import * as vscode from 'vscode';
import * as path from 'path';
import * as WebSocket from 'ws';
import { FileChangeManager } from './FileChangeManager'; // Ensure correct path is used
//import { MessageProcessor } from './MessageProcessor';
import { WebSocketConstants } from './WebSocketConstants';

import { FollowAndAuthorRulesProcessor } from './FollowAndAuthorRulesProcessor';
import { MiningRulesProcessor } from './MiningRulesProcessor';
import { DoiProcessing } from './DoiProcessing';

import { diffChunks, DiffChunk } from './FollowAndAuthorRulesProcessor';
import { reconcile } from './reconcile';
import { sourceSnapshotsEqual } from './sourceSnapshot';
import { DashboardServer } from './dashboardServer';
import { isLoopbackAddress, isOriginAllowed } from './requestGuards';
import { initRuntime, isDevelopmentHost } from './runtime';
import { setSrcmlPathOverride } from './srcmlRunner';


// EventEmitter to trigger CodeLens refresh (exported for use in other modules)
export const codeLensChangeEmitter = new vscode.EventEmitter<void>();

// Development socket for a dashboard run from source (npm start, port 9010).
// Installed copies serve their own bundled dashboard instead.
const DEV_SOCKET_PORT = 8887;
const DEV_DASHBOARD_AUTHORITIES: ReadonlySet<string> = new Set(['localhost:9010', '127.0.0.1:9010']);
const OPENAI_KEY_SECRET = 'designfix.openaiApiKey';
const WELCOME_SHOWN_KEY = 'designfix.welcomeShown';
let activeWebSocket: WebSocket.WebSocket | null = null;



export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "DesignFix" is now active.');
    initRuntime(context);

    const applySrcmlPath = () => setSrcmlPathOverride(
        vscode.workspace.getConfiguration('designfix').get<string>('srcmlPath', ''));
    applySrcmlPath();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('designfix.srcmlPath')) {
            applySrcmlPath();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('designfix.mineRules', () => {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showWarningMessage('No workspace is open.');
            return;
        }

        if (!activeWebSocket || activeWebSocket.readyState !== WebSocket.OPEN) {
            vscode.window.showWarningMessage('DesignFix client is not connected.');
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active editor.');
            return;
        }

        const document = editor.document;
        const selection = editor.selection;
        const wordRange = document.getWordRangeAtPosition(selection.start);
        if (!wordRange) {
            vscode.window.showInformationMessage('No word selected');
            return;
        }

        const word = document.getText(wordRange);
        const startOffset = document.offsetAt(wordRange.start);
        const startLineOffset = wordRange.start.character;
        const lineNumber = wordRange.start.line + 1; // VS Code lines are zero-based
        const filePath = document.uri.fsPath;
        const formattedFilePath = filePath.replace(/\\/g, '/');

        const minigDataInfo = {
            filePath: formattedFilePath,
            startOffset: startOffset.toString(),
            startLineOffset: startLineOffset.toString(),
            lineNumber: lineNumber.toString(),
            text: word
        };

        activeWebSocket.send(JSON.stringify({
            command: WebSocketConstants.SEND_ELEMENT_INFO_FOR_MINE_RULES,
            data: minigDataInfo
        }));

        const doiProcessing = DoiProcessing.getInstance();

        const doiData = {
            recentVisitedFiles: doiProcessing.getVisitedFiles(),
            recentVisitedElements: doiProcessing.getVisitedElements()
        };

        activeWebSocket.send(JSON.stringify({
            command: WebSocketConstants.SEND_DOI_INFORMATION,
            data: doiData
        }));

        activeWebSocket.send(JSON.stringify({
            command: WebSocketConstants.SEND_REQUEST_MINE_RULES_FOR_ELEMENT,
            data: ""
        }));
    }));

    // One handler serves every dashboard connection, whether it arrives on the
    // bundled dashboard's server or on the development socket. The folder is
    // resolved per connection, so both "Open Folder" and "Add Folder to
    // Workspace" work.
    const handleConnection = (ws: WebSocket.WebSocket) => {
        // A soft refresh can establish its replacement socket before the old
        // page has finished closing. Mark the new one active first and retire
        // the predecessor so only one browser client can drive shared state.
        const previousWebSocket = activeWebSocket;
        activeWebSocket = ws;
        if (previousWebSocket && previousWebSocket !== ws &&
            previousWebSocket.readyState !== WebSocket.CLOSED) {
            previousWebSocket.close(1000, 'Superseded by a newer DesignFix client');
        }

        console.log('Client connected');
        let fileChangeManager: FileChangeManager | null = null;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (workspaceFolder) {
            const projectPath = workspaceFolder.uri.fsPath.replace(/\\/g, '/');
            fileChangeManager = FileChangeManager.getInstance(projectPath, ws);
            // Reconnects and source mutations use the same full-cycle pipeline.
            // A reconnect starts immediately; source changes use its debounce.
            fileChangeManager.requestFullSync({ reason: 'refresh' }, 0);
        } else {
            console.log('No workspace found');
            vscode.window.showWarningMessage(
                'DesignFix: no folder is open. Use "Open Folder" (or "Add Folder to Workspace"), ' +
                'then reload the DesignFix client to analyze it.'
            );
        }

        let processingQueue: Promise<void> = Promise.resolve();
        ws.on('message', (message: string) => {
            // Ignore a message that was already queued by the socket superseded
            // above; all processor singletons now belong to the active client.
            if (activeWebSocket !== ws) {
                return;
            }

            // Serialize incoming work. Concurrent fix messages previously
            // raced while mutating the shared review collection.
            processingQueue = processingQueue.then(async () => {
                if (activeWebSocket !== ws) {
                    return;
                }
                const faw = FollowAndAuthorRulesProcessor.getInstance();
                const mr = MiningRulesProcessor.getInstance();
                const json = JSON.parse(message.toString());

                if (faw.wsMessages.includes(json.command)) {
                    await faw.processReceivedMessages(message);
                }
                else if (mr.wsMessages.includes(json.command)) {
                    console.log('in MR');
                    await mr.processReceivedMessages(message);
                }
            }).catch((error) => {
                console.error('Error processing WebSocket message:', error);
            });
        });

        ws.on('error', (error) => {
            console.error(`WebSocket error: ${error}`);
        });

        ws.on('close', () => {
            console.log('Client disconnected');
            fileChangeManager?.disconnect(ws);
            if (activeWebSocket === ws) {
                activeWebSocket = null;
            }
        });
    };





    // The bundled dashboard and its socket share one local server per window,
    // on a free port bound to 127.0.0.1 (see dashboardServer.ts).
    const dashboard = new DashboardServer({
        dashboardRoot: path.join(context.extensionPath, 'dashboard'),
        port: vscode.workspace.getConfiguration('designfix').get<number>('dashboard.port', 0),
        getApiKey: () => context.secrets.get(OPENAI_KEY_SECRET),
        onConnection: handleConnection,
    });
    const dashboardReady = dashboard.start();
    dashboardReady.then(
        (boundPort) => console.log(`DesignFix dashboard: http://127.0.0.1:${boundPort}/`),
        (error) => {
            console.error('DesignFix dashboard server failed to start:', error);
            void vscode.window.showErrorMessage(
                `DesignFix could not start its dashboard server: ${error instanceof Error ? error.message : String(error)}`);
        }
    );
    context.subscriptions.push(new vscode.Disposable(() => dashboard.dispose()));

    // A dashboard run from source (npm start, port 9010) connects to the
    // development socket instead. It is on in an Extension Development Host,
    // so study runs keep working, and otherwise only when the
    // designfix.devSocket.enabled setting is on.
    const devSocketEnabled = isDevelopmentHost()
        || vscode.workspace.getConfiguration('designfix').get<boolean>('devSocket.enabled', false);
    if (devSocketEnabled) {
        // Only this machine, and only the dashboard's own page, may connect.
        const verifyDevClient: WebSocket.VerifyClientCallbackSync = ({ origin, req }) =>
            isLoopbackAddress(req.socket.remoteAddress) && isOriginAllowed(origin, DEV_DASHBOARD_AUTHORITIES);
        const devServer = new WebSocket.Server({ port: DEV_SOCKET_PORT, verifyClient: verifyDevClient });
        devServer.on('connection', handleConnection);
        devServer.on('error', (error) => {
            console.error(`DesignFix development socket error on port ${DEV_SOCKET_PORT}:`, error);
            void vscode.window.showWarningMessage(
                `DesignFix: port ${DEV_SOCKET_PORT} is unavailable, so a dashboard run from source cannot `
                + 'connect to this window. The bundled dashboard still works.');
        });
        context.subscriptions.push(new vscode.Disposable(() => devServer.close()));
    }

    const openDashboard = async (): Promise<void> => {
        let boundPort: number;
        try {
            boundPort = await dashboardReady;
        } catch {
            return; // already reported when the server failed to start
        }
        // asExternalUri maps the port through VS Code's port forwarding in
        // remote development; on a local machine it returns the same address.
        const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${boundPort}/`));
        dashboard.allowAuthority(external.authority);
        await vscode.env.openExternal(external);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('designfix.openDashboard', openDashboard),
        vscode.commands.registerCommand('designfix.setOpenAIKey', async () => {
            const value = await vscode.window.showInputBox({
                title: 'DesignFix: Set OpenAI API Key',
                prompt: 'Saved in VS Code secret storage on this machine. It is sent only to api.openai.com, when you request a fix.',
                placeHolder: 'sk-...',
                password: true,
                ignoreFocusOut: true,
                validateInput: (text) => (text.trim() ? undefined : 'Enter a key, or press Escape to cancel.'),
            });
            if (value === undefined) {
                return;
            }
            await context.secrets.store(OPENAI_KEY_SECRET, value.trim());
            void vscode.window.showInformationMessage('DesignFix: OpenAI API key saved. Reload the dashboard to update its status.');
        }),
        vscode.commands.registerCommand('designfix.clearOpenAIKey', async () => {
            await context.secrets.delete(OPENAI_KEY_SECRET);
            void vscode.window.showInformationMessage('DesignFix: OpenAI API key removed.');
        })
    );

    const dashboardStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    dashboardStatusItem.text = '$(checklist) DesignFix';
    dashboardStatusItem.tooltip = 'Open the DesignFix dashboard';
    dashboardStatusItem.command = 'designfix.openDashboard';
    dashboardStatusItem.show();
    context.subscriptions.push(dashboardStatusItem);

    // Point new users at the dashboard, once per workspace.
    if (!context.workspaceState.get<boolean>(WELCOME_SHOWN_KEY)) {
        void context.workspaceState.update(WELCOME_SHOWN_KEY, true);
        void (async () => {
            const hasKey = Boolean(await context.secrets.get(OPENAI_KEY_SECRET));
            const actions = hasKey ? ['Open Dashboard'] : ['Open Dashboard', 'Set OpenAI API Key'];
            const choice = await vscode.window.showInformationMessage(
                'DesignFix is ready for this project. Open the dashboard to see design-rule violations and request fixes.',
                ...actions);
            if (choice === 'Open Dashboard') {
                await vscode.commands.executeCommand('designfix.openDashboard');
            } else if (choice === 'Set OpenAI API Key') {
                await vscode.commands.executeCommand('designfix.setOpenAIKey');
            }
        })();
    }

    // CodeLens Accept/Reject integration for diff view
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'java', scheme: 'untitled' },
            {
                onDidChangeCodeLenses: codeLensChangeEmitter.event,
                provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
                    // Only show a chunk's lenses on the diff tab it belongs to.
                    // (Legacy chunks without modifiedUri show on any untitled java doc.)
                    return diffChunks.flatMap((chunk) => {
                        if (chunk.modifiedUri && chunk.modifiedUri !== document.uri.toString()) {
                            return [];
                        }
                        return [
                        new vscode.CodeLens(chunk.range, {
                            command: 'designfix.acceptChange',
                            title: 'Accept Fix (all files)',
                            arguments: [vscode.Uri.parse(chunk.modifiedUri || document.uri.toString())]
                        }),
                        new vscode.CodeLens(chunk.range, {
                            command: 'designfix.rejectChange',
                            title: 'Reject Fix (all files)',
                            arguments: [vscode.Uri.parse(chunk.modifiedUri || document.uri.toString())]
                        })
                    ];
                    });
                }
            }
        )
    );
    // ---- Accept / Reject for reconciled fix reviews -------------------------
    // Commands accept either a chunk index (legacy CodeLens path) or the URI of
    // the review's modified-side document (editor-title buttons, notifications).
    // With no argument they resolve the chunk from the active diff tab.

    const resolveChunkIndex = (arg?: number | vscode.Uri): number => {
        if (typeof arg === 'number') {
            return arg >= 0 && arg < diffChunks.length ? arg : -1;
        }
        const target = arg instanceof vscode.Uri ? arg.toString() : undefined;
        if (target) {
            const i = diffChunks.findIndex(c => c.modifiedUri === target);
            if (i >= 0) { return i; }
        }
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (tab && tab.input instanceof vscode.TabInputTextDiff) {
            const modified = tab.input.modified.toString();
            const i = diffChunks.findIndex(c => c.modifiedUri === modified);
            if (i >= 0) { return i; }
        }
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const i = diffChunks.findIndex(c => c.modifiedUri === editor.document.uri.toString());
            if (i >= 0) { return i; }
        }
        return diffChunks.length === 1 ? 0 : -1;
    };

    const closeReviewTab = async (chunk: DiffChunk): Promise<void> => {
        // The right side of the review diff is an untitled document; with
        // content it counts as dirty, so closing its tab would pop VS Code's
        // "save?" dialog. Empty untitled editors close silently, so discard
        // the preview's content before closing the tab.
        const rightDoc = vscode.workspace.textDocuments.find(
            d => d.uri.toString() === chunk.modifiedUri && d.uri.scheme === 'untitled'
        );
        if (rightDoc && !rightDoc.isClosed && rightDoc.getText().length > 0) {
            const discard = new vscode.WorkspaceEdit();
            discard.replace(
                rightDoc.uri,
                new vscode.Range(rightDoc.positionAt(0), rightDoc.positionAt(rightDoc.getText().length)),
                ''
            );
            await vscode.workspace.applyEdit(discard);
        }

        const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
        for (const tab of tabs) {
            const input = tab.input;
            const matches =
                (input instanceof vscode.TabInputTextDiff && input.modified.toString() === chunk.modifiedUri) ||
                (input instanceof vscode.TabInputText && input.uri.toString() === chunk.modifiedUri);
            if (matches) {
                try {
                    await vscode.window.tabGroups.close(tab);
                } catch (err) {
                    console.warn('Failed to close review tab:', err);
                }
            }
        }
    };

    const chunksForReview = (chunk: DiffChunk): DiffChunk[] =>
        diffChunks.filter(candidate => candidate.reviewId === chunk.reviewId);

    const finishReview = async (chunks: DiffChunk[]): Promise<void> => {
        const completed = new Set(chunks);
        for (let i = diffChunks.length - 1; i >= 0; i--) {
            if (completed.has(diffChunks[i])) {
                diffChunks.splice(i, 1);
            }
        }
        // A held fix-attempt record must never outlive the chunks it belongs
        // to. Accept commits it and reject discards it before reaching here, so
        // this is a no-op for both; it is the backstop that keeps any future
        // resolution path from stranding a record in memory.
        const faw = FollowAndAuthorRulesProcessor.getInstance();
        for (const reviewId of new Set(chunks.map(chunk => chunk.reviewId))) {
            faw.discardFixLog(reviewId);
        }
        await vscode.commands.executeCommand('setContext', 'designfix.reviewActive', diffChunks.length > 0);
        codeLensChangeEmitter.fire();
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('designfix.acceptChange', async (arg?: number | vscode.Uri) => {
            const index = resolveChunkIndex(arg);
            if (index < 0) {
                vscode.window.showWarningMessage('DesignFix: no pending fix found for this tab.');
                return;
            }
            const selectedChunk = diffChunks[index];
            const reviewChunks = chunksForReview(selectedChunk);
            type PreparedReviewEdit = {
                chunk: DiffChunk;
                uri: vscode.Uri;
                doc: vscode.TextDocument | null;
                rightText: string;
                originalText: string;
                patchedText: string;
                changed: boolean;
                create: boolean;
                legacyTruncation: boolean;
            };
            let prepared: PreparedReviewEdit[] = [];
            let workspaceApplied = false;

            try {
                // Validate and stage every file first. Version 2 suggestions are
                // locally materialized exact edits, so any base drift is a hard
                // conflict rather than an invitation to fuzzy-merge.
                for (const chunk of reviewChunks) {
                    const rightDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === chunk.modifiedUri);
                    const rightText = rightDoc ? rightDoc.getText() : chunk.newText;
                    const uri = vscode.Uri.file(chunk.filePath);
                    const create = chunk.operation === 'create';
                    let doc: vscode.TextDocument | null = null;
                    try {
                        doc = await vscode.workspace.openTextDocument(uri);
                    } catch {
                        doc = null;
                    }

                    if (create && doc) {
                        throw new Error(`${chunk.filePath} now exists; regenerate the fix before accepting it.`);
                    }
                    if (!create && !doc) {
                        throw new Error(`${chunk.filePath} no longer exists; regenerate the fix before accepting it.`);
                    }

                    const originalText = doc ? doc.getText() : '';
                    if (chunk.schemaVersion === 2
                        && !sourceSnapshotsEqual(originalText, chunk.fullOriginalContent)) {
                        throw new Error(`${chunk.filePath} changed after review opened; regenerate the entire fix.`);
                    }

                    if (chunk.schemaVersion === 2 || create) {
                        prepared.push({
                            chunk,
                            uri,
                            doc,
                            rightText,
                            originalText,
                            patchedText: rightText,
                            changed: create || originalText !== rightText,
                            create,
                            legacyTruncation: false,
                        });
                    } else {
                        const rec = reconcile(originalText, rightText);
                        prepared.push({
                            chunk,
                            uri,
                            doc,
                            rightText,
                            originalText,
                            patchedText: rec.patchedText,
                            changed: !rec.identicalAfterReconcile,
                            create: false,
                            legacyTruncation: rec.truncationSuspected,
                        });
                    }
                }

                if (prepared.some(item => item.legacyTruncation)) {
                    const pick = await vscode.window.showWarningMessage(
                        'One or more legacy suggestions may be truncated. How should DesignFix apply this atomic fix?',
                        { modal: true },
                        'Keep unmatched original lines',
                        'Delete them and apply'
                    );
                    if (pick === undefined) { return; }
                    if (pick === 'Delete them and apply') {
                        prepared = prepared.map(item => {
                            if (!item.legacyTruncation) { return item; }
                            const rec = reconcile(item.originalText, item.rightText, { allowLargeDeletions: true });
                            return {
                                ...item,
                                patchedText: rec.patchedText,
                                changed: !rec.identicalAfterReconcile,
                                legacyTruncation: false,
                            };
                        });
                    }
                }

                const changed = prepared.filter(item => item.changed);
                if (changed.length === 0) {
                    // Accepted, but every target already matches the suggestion.
                    // The user still resolved this review by accepting it, so the
                    // attempt is recorded like any other accepted fix.
                    vscode.window.showInformationMessage('DesignFix: every file already satisfies this suggestion.');
                    await FollowAndAuthorRulesProcessor.getInstance().commitFixLog(selectedChunk.reviewId);
                    for (const chunk of reviewChunks) { await closeReviewTab(chunk); }
                    await finishReview(reviewChunks);
                    return;
                }

                // One WorkspaceEdit commits the complete review group. No file is
                // written if any staged edit is invalid.
                const workspaceEdit = new vscode.WorkspaceEdit();
                for (const item of changed) {
                    if (item.create) {
                        workspaceEdit.createFile(item.uri, { ignoreIfExists: false, overwrite: false });
                        workspaceEdit.insert(item.uri, new vscode.Position(0, 0), item.patchedText);
                    } else if (item.doc) {
                        workspaceEdit.replace(
                            item.uri,
                            new vscode.Range(item.doc.positionAt(0), item.doc.positionAt(item.originalText.length)),
                            item.patchedText,
                        );
                    }
                }

                workspaceApplied = await vscode.workspace.applyEdit(workspaceEdit);
                if (!workspaceApplied) {
                    throw new Error('the atomic workspace edit was not applied');
                }

                for (const item of changed) {
                    const savedDoc = await vscode.workspace.openTextDocument(item.uri);
                    if (!await savedDoc.save()) {
                        throw new Error(`could not save ${item.chunk.filePath}`);
                    }
                }

                // Every file is on disk. Only now is the fix-attempt record
                // written to data/rule_<id>/run_<NN>/. commitFixLog never
                // rejects, so a logging failure cannot trigger the rollback
                // below for edits that already succeeded.
                await FollowAndAuthorRulesProcessor.getInstance().commitFixLog(selectedChunk.reviewId);

                vscode.window.showInformationMessage(
                    `DesignFix: atomic fix applied to ${changed.length} file(s).`
                );
                for (const chunk of reviewChunks) { await closeReviewTab(chunk); }
                await finishReview(reviewChunks);
            } catch (err: any) {
                // Saving is separate from WorkspaceEdit. If it fails, restore all
                // original snapshots and remove files created by this review.
                if (workspaceApplied && prepared.length > 0) {
                    try {
                        const rollback = new vscode.WorkspaceEdit();
                        for (const item of prepared.filter(candidate => candidate.changed)) {
                            if (item.create) {
                                rollback.deleteFile(item.uri, { ignoreIfNotExists: true, recursive: false });
                            } else {
                                const current = await vscode.workspace.openTextDocument(item.uri);
                                rollback.replace(
                                    item.uri,
                                    new vscode.Range(current.positionAt(0), current.positionAt(current.getText().length)),
                                    item.originalText,
                                );
                            }
                        }
                        await vscode.workspace.applyEdit(rollback);
                        for (const item of prepared.filter(candidate => candidate.changed && !candidate.create)) {
                            const restored = await vscode.workspace.openTextDocument(item.uri);
                            await restored.save();
                        }
                    } catch (rollbackError) {
                        console.error('Failed to roll back atomic DesignFix edit:', rollbackError);
                    }
                }
                vscode.window.showErrorMessage(`Failed to apply atomic fix: ${err.message}`);
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('designfix.rejectChange', async (arg?: number | vscode.Uri) => {
            const index = resolveChunkIndex(arg);
            if (index < 0) {
                vscode.window.showWarningMessage('DesignFix: no pending fix found for this tab.');
                return;
            }
            const chunk = diffChunks[index];
            const reviewChunks = chunksForReview(chunk);

            // Cross-file fixes are one transaction. Rejecting any tab rejects
            // every dependent edit, preventing a Rule 7-style half-state.
            // The held fix-attempt record is dropped with them: a rejected
            // suggestion leaves no run folder under data/.
            FollowAndAuthorRulesProcessor.getInstance().discardFixLog(chunk.reviewId);
            for (const reviewChunk of reviewChunks) { await closeReviewTab(reviewChunk); }
            await finishReview(reviewChunks);
            vscode.window.showInformationMessage(
                `DesignFix: rejected atomic fix across ${reviewChunks.length} file(s).`
            );
        })
    );

    // ---- Persistent review controls -----------------------------------------
    // Notification toasts auto-dismiss after a few seconds, so the primary
    // Accept/Reject affordance is a pair of status-bar buttons (plus the ✓/✕
    // icons in the diff tab's title bar). They stay visible exactly as long as
    // at least one fix review is pending, driven by codeLensChangeEmitter,
    // which fires on every review open/accept/reject.
    const acceptStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
    acceptStatusItem.text = '$(check) Accept DesignFix Fix';
    acceptStatusItem.tooltip = 'Atomically apply every file in the DesignFix suggestion shown in the diff';
    acceptStatusItem.command = 'designfix.acceptChange';
    acceptStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    const rejectStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9999);
    rejectStatusItem.text = '$(close) Reject';
    rejectStatusItem.tooltip = 'Discard the complete DesignFix suggestion shown in the diff';
    rejectStatusItem.command = 'designfix.rejectChange';

    const updateReviewControls = () => {
        if (diffChunks.length > 0) {
            const pendingReviews = new Set(diffChunks.map(chunk => chunk.reviewId)).size;
            const suffix = pendingReviews > 1 ? ` (${pendingReviews} pending)` : '';
            acceptStatusItem.text = `$(check) Accept DesignFix Fix${suffix}`;
            acceptStatusItem.show();
            rejectStatusItem.show();
        } else {
            acceptStatusItem.hide();
            rejectStatusItem.hide();
        }
    };
    context.subscriptions.push(
        codeLensChangeEmitter.event(updateReviewControls),
        acceptStatusItem,
        rejectStatusItem
    );




    // The dashboard server and the development socket are closed through
    // context.subscriptions, where they are registered above.
}

export function deactivate() { }
