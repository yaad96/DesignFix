import * as vscode from 'vscode';
import WebSocket from 'ws';
import { Constants } from './Constants';
import { FollowAndAuthorRulesProcessor } from './FollowAndAuthorRulesProcessor';
import { MiningRulesProcessor } from './MiningRulesProcessor';
import { DoiProcessing } from './DoiProcessing';
import { buildFolderHierarchy } from './utilites';
import { WebSocketConstants } from './WebSocketConstants';
import { classifySrcmlFailure, convertJavaToXml } from './srcmlRunner';

const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

type XmlSnapshotEntry = Readonly<{
    filePath: string;
    xmlContent: string;
}>;

type FullSyncTrigger = Readonly<{
    reason: 'refresh' | 'code_change';
    filePath?: string;
}>;

/**
 * Owns the one canonical project synchronization pipeline.
 *
 * Java filesystem events and client reconnects both invalidate any older run,
 * build a complete local snapshot, and publish one full protocol cycle. Nothing
 * from a run is sent until XML conversion and rule/tag loading have completed.
 */
export class FileChangeManager {
    private static instance: FileChangeManager;

    private ws: WebSocket | null;
    private projectPath: string;
    private javaFileWatcher: vscode.FileSystemWatcher | null = null;
    private fullSyncTimer: NodeJS.Timeout | null = null;
    private syncGeneration = 0;
    private tablesReady: Promise<void> = Promise.resolve();

    private constructor(projectPath: string, ws: WebSocket) {
        this.projectPath = projectPath;
        this.ws = ws;
        this.tablesReady = this.syncCollaborators(projectPath, ws);
        this.watchJavaFilesOnDisk();
        this.handleActiveTextEditorChange();
    }

    public static getInstance(projectPath: string, ws: WebSocket): FileChangeManager {
        if (!FileChangeManager.instance) {
            FileChangeManager.instance = new FileChangeManager(projectPath, ws);
        } else {
            FileChangeManager.instance.updateConnection(projectPath, ws);
        }
        return FileChangeManager.instance;
    }

    private updateConnection(projectPath: string, ws: WebSocket): void {
        const projectChanged = this.projectPath !== projectPath;

        // Invalidate before replacing either mutable value. A scan that belongs
        // to the previous client/project may keep converting, but cannot send.
        this.invalidateCurrentSync();
        this.projectPath = projectPath;
        this.ws = ws;
        this.tablesReady = this.syncCollaborators(projectPath, ws);

        if (projectChanged) {
            this.watchJavaFilesOnDisk();
        }
    }

    /** Cancel work only when the socket being closed is still the current one. */
    public disconnect(ws: WebSocket): void {
        if (this.ws !== ws) {
            return;
        }
        this.invalidateCurrentSync();
        this.ws = null;
    }

    private syncCollaborators(projectPath: string, ws: WebSocket): Promise<void> {
        const follow = FollowAndAuthorRulesProcessor.getInstance(projectPath, ws);
        const tableLoad = follow.updateProjectWs(projectPath, ws);
        // Keep the original rejecting promise for runFullSync while ensuring a
        // very fast disconnect cannot leave its rejection temporarily unhandled.
        void tableLoad.catch(() => undefined);

        MiningRulesProcessor.getInstance(projectPath, ws).updateProjectWs(projectPath, ws);
        DoiProcessing.getInstance(projectPath, ws).updateProjectWs(projectPath, ws);

        return tableLoad;
    }

    /**
     * Request a complete refresh. Every request increments the generation
     * immediately, so even a request waiting in the debounce window supersedes
     * a scan or send already in progress.
     */
    public requestFullSync(trigger: FullSyncTrigger, delayMs = Constants.DEBOUNCER_DELAY): void {
        const generation = this.invalidateCurrentSync();
        const socket = this.ws;
        const projectPath = this.projectPath;
        const tablesReady = this.tablesReady;
        const capturedTrigger = Object.freeze({ ...trigger });

        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return;
        }

        this.fullSyncTimer = setTimeout(() => {
            this.fullSyncTimer = null;
            this.runFullSync(generation, projectPath, socket, tablesReady, capturedTrigger).catch(error => {
                if (this.isCurrent(generation, projectPath, socket)) {
                    console.error(`DesignFix full sync failed (${capturedTrigger.reason}):`, error);
                    FileChangeManager.reportSyncFailure(error);
                }
            });
        }, delayMs);
    }

    private invalidateCurrentSync(): number {
        this.syncGeneration += 1;
        if (this.fullSyncTimer) {
            clearTimeout(this.fullSyncTimer);
            this.fullSyncTimer = null;
        }
        return this.syncGeneration;
    }

    private isCurrent(generation: number, projectPath: string, socket: WebSocket): boolean {
        return generation === this.syncGeneration &&
            projectPath === this.projectPath &&
            socket === this.ws &&
            socket.readyState === WebSocket.OPEN;
    }

    private async runFullSync(
        generation: number,
        projectPath: string,
        socket: WebSocket,
        tablesReady: Promise<void>,
        trigger: FullSyncTrigger
    ): Promise<void> {
        // Both operations finish before ENTER. If conversion fails, the client
        // keeps its previous committed result instead of receiving a partial set.
        const [xmlSnapshot] = await Promise.all([
            this.buildXmlSnapshot(projectPath),
            tablesReady
        ]);

        if (!this.isCurrent(generation, projectPath, socket)) {
            return;
        }

        const follow = FollowAndAuthorRulesProcessor.getInstance();
        const tagTable = follow.getTagTableForClient();
        const ruleTable = follow.getRuleTableForClient();
        const projectHierarchy = buildFolderHierarchy(projectPath);

        const protocolMessages = [
            {
                command: WebSocketConstants.SEND_ENTER_CHAT_MSG,
                data: 'Project is connected to designfix'
            },
            {
                command: WebSocketConstants.SEND_PROJECT_PATH_MSG,
                data: projectPath
            },
            {
                command: WebSocketConstants.SEND_PROJECT_HIERARCHY_MSG,
                data: projectHierarchy
            },
            ...xmlSnapshot.map(({ filePath, xmlContent }) => ({
                command: WebSocketConstants.SEND_XML_FILES_MSG,
                data: {
                    filePath: filePath.replace(/\\/g, '/'),
                    xml: xmlContent
                }
            })),
            {
                command: WebSocketConstants.SEND_TAG_TABLE_MSG,
                data: tagTable
            },
            {
                command: WebSocketConstants.SEND_RULE_TABLE_MSG,
                data: ruleTable
            },
            {
                command: WebSocketConstants.SEND_VERIFY_RULES_MSG,
                data: trigger.filePath
                    ? { reason: trigger.reason, filePath: trigger.filePath.replace(/\\/g, '/') }
                    : { reason: trigger.reason }
            }
        ];

        // Enqueue the complete transaction in one JavaScript turn. `ws` keeps
        // per-socket send order; without an await here, a new filesystem event
        // cannot invalidate the generation between ENTER and VERIFY and strand
        // the client with an uncommitted partial staging set.
        for (const message of protocolMessages) {
            if (!this.isCurrent(generation, projectPath, socket)) {
                return;
            }
            socket.send(JSON.stringify(message), error => {
                if (error) {
                    console.error('DesignFix full-sync WebSocket send failed:', error);
                }
            });
        }

        console.log(`DesignFix full sync complete (${trigger.reason}): ${xmlSnapshot.length} Java file(s).`);
    }

    /**
     * One watcher is sufficient for saves, creates, deletes, and both halves of
     * a rename, including changes made by tools outside this VS Code window.
     */
    private watchJavaFilesOnDisk(): void {
        this.javaFileWatcher?.dispose();
        this.javaFileWatcher = null;

        if (!this.projectPath) {
            return;
        }

        const pattern = new vscode.RelativePattern(this.projectPath, '**/*.java');
        this.javaFileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.javaFileWatcher.onDidChange(uri => this.handleJavaFileMutation(uri.fsPath, 'save/change'));
        this.javaFileWatcher.onDidCreate(uri => this.handleJavaFileMutation(uri.fsPath, 'create/rename'));
        this.javaFileWatcher.onDidDelete(uri => this.handleJavaFileMutation(uri.fsPath, 'delete/rename'));
    }

    private handleJavaFileMutation(javaFilePath: string, kind: string): void {
        if (this.isIgnoredJavaFile(javaFilePath)) {
            return;
        }
        console.log(`DesignFix scheduling full sync (${kind}): ${javaFilePath}`);
        this.requestFullSync({ reason: 'code_change', filePath: javaFilePath });
    }

    private isIgnoredJavaFile(javaFilePath: string): boolean {
        const base = javaFilePath.replace(/\\/g, '/').split('/').pop() || '';
        return base === Constants.TEMP_JAVA_FILE || base === Constants.TEMP_JAVA_FILE_TESTING;
    }

    private async buildXmlSnapshot(projectPath: string): Promise<ReadonlyArray<XmlSnapshotEntry>> {
        const javaUris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(projectPath, '**/*.java')
        );
        const javaFiles = javaUris
            .map(uri => uri.fsPath)
            .filter(filePath => !this.isIgnoredJavaFile(filePath))
            .sort((left, right) =>
                left.replace(/\\/g, '/').localeCompare(right.replace(/\\/g, '/'))
            );

        const snapshot: XmlSnapshotEntry[] = [];
        for (const filePath of javaFiles) {
            // A single failure rejects the whole local build. No protocol phase
            // has started yet, so the last client snapshot remains authoritative.
            const xmlContent = await this.convertToXML(filePath);
            snapshot.push(Object.freeze({ filePath, xmlContent }));
        }
        return Object.freeze(snapshot);
    }

    private convertToXML(inputFilePath: string): Promise<string> {
        return convertJavaToXml(inputFilePath);
    }

    private static readonly reportedFailureKinds = new Set<string>();

    /**
     * Tell the user why the project could not be analyzed, once per kind of
     * failure, instead of leaving the dashboard silently empty.
     */
    private static reportSyncFailure(error: unknown): void {
        const kind = classifySrcmlFailure(error);
        if (FileChangeManager.reportedFailureKinds.has(kind)) {
            return;
        }
        FileChangeManager.reportedFailureKinds.add(kind);

        if (kind === 'not-found') {
            void vscode.window.showErrorMessage(
                'DesignFix could not find srcML. Install srcML 0.9.5 and set "designfix.srcmlPath" to its executable.',
                'Open Settings'
            ).then((choice) => {
                if (choice === 'Open Settings') {
                    void vscode.commands.executeCommand('workbench.action.openSettings', 'designfix.srcmlPath');
                }
            });
        } else if (kind === 'missing-runtime') {
            void vscode.window.showErrorMessage(
                'srcML could not start because the Microsoft Visual C++ Redistributable (x64) is not installed.',
                'Download'
            ).then((choice) => {
                if (choice === 'Download') {
                    void vscode.env.openExternal(vscode.Uri.parse(VC_REDIST_URL));
                }
            });
        } else {
            const detail = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`DesignFix could not analyze this project: ${detail}`);
        }
    }

    /** Keep IDE active-editor navigation independent from project re-analysis. */
    private handleActiveTextEditorChange(): void {
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!editor || editor.document.languageId !== 'java') {
                return;
            }

            const socket = this.ws;
            if (!socket || socket.readyState !== WebSocket.OPEN) {
                return;
            }

            socket.send(JSON.stringify({
                command: WebSocketConstants.SEND_FILE_CHANGE_IN_IDE_MSG,
                data: editor.document.uri.fsPath.replace(/\\/g, '/')
            }), error => {
                if (error) {
                    console.error('Failed to send active Java file:', error);
                }
            });
        });
    }
}
