import * as vscode from 'vscode';
import * as WebSocket from 'ws';
import * as fs from 'fs';
import { promisify } from 'util';
import { FileChangeManager } from './FileChangeManager'; // Ensure correct path is used
import { buildFolderHierarchy } from './utilites'; // Removed extra semicolon and corrected typo
//import { MessageProcessor } from './MessageProcessor';
import { WebSocketConstants } from './WebSocketConstants';

import { FollowAndAuthorRulesProcessor } from './FollowAndAuthorRulesProcessor';
import { MiningRulesProcessor } from './MiningRulesProcessor';
import { DoiProcessing } from './DoiProcessing';

import { diffChunks, DiffChunk } from './FollowAndAuthorRulesProcessor';
import { reconcile } from './reconcile';


//const readFileAsync = promisify(fs.readFile);

// EventEmitter to trigger CodeLens refresh (exported for use in other modules)
export const codeLensChangeEmitter = new vscode.EventEmitter<void>();

const port = 8887;
let activeWebSocket: WebSocket.WebSocket | null = null;



export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "DesignFix" is now active.');
    //console.log("All xml files created");

    const server = new WebSocket.Server({ port });
    console.log(`WebSocket server started on port: ${port}`);

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

    // Register the connection handler unconditionally so the tool works whether
    // the target folder was opened via "Open Folder" or "Add Folder to
    // Workspace" - even if no folder was open when the extension activated
    // (onStartupFinished). The folder is resolved per-connection below.
    server.on('connection', (ws) => {
            activeWebSocket = ws;

            console.log('Client connected');

            (async () => { // Immediately Invoked Function Expression (IIFE) for async
                if (vscode.workspace.workspaceFolders) {

                    var projectPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
                    projectPath = projectPath.replace(/\\/g, '/');
                    const fileChangeManager = FileChangeManager.getInstance(projectPath, ws);



                    /*ws.send(MessageProcessor.encodeData({
                        command: WebSocketConstants.SEND_ENTER_CHAT_MSG,
                        data: " is connected to DesignFix",
                    }));*/

                    ws.send(JSON.stringify({
                        command:WebSocketConstants.SEND_ENTER_CHAT_MSG,
                        data:"Project is connected to designfix"
                    }));

                    /*ws.send(MessageProcessor.encodeData({
                        command: WebSocketConstants.SEND_PROJECT_PATH_MSG,
                        data: projectPath,
                    }));*/

                    ws.send(JSON.stringify({
                        command:WebSocketConstants.SEND_PROJECT_PATH_MSG,
                        data:projectPath
                    }));


                    try {
                        const projectHierarchy = buildFolderHierarchy(projectPath); // Assuming this function is properly implemented to use async/await

                        const output = {
                            command: WebSocketConstants.SEND_PROJECT_HIERARCHY_MSG,
                            data: projectHierarchy
                          };
                        
                          // Send the project hierarchy data to the connected client
                          ws.send(JSON.stringify(output));

                        //await fileChangeManager.sendXmlFilesSequentially();

                    } catch (error) {
                        console.error('Failed to generate project hierarchy:', error);
                    }
                    fileChangeManager.convertAllJavaFilesToXML(projectPath).then(() => {
                        console.log('All Java files have been converted to XML and stored.');
                        fileChangeManager.sendXmlFilesSequentially().then(() => {
                            /*ws.send(MessageProcessor.encodeData({
                                command: WebSocketConstants.SEND_TAG_TABLE_MSG,
                                data: FollowAndAuthorRulesProcessor.getInstance().getTagTableForClient()
                            }));*/
                            ws.send(JSON.stringify({
                                command: WebSocketConstants.SEND_TAG_TABLE_MSG,
                                data: FollowAndAuthorRulesProcessor.getInstance().getTagTableForClient()
                            }));

                            /*ws.send(MessageProcessor.encodeData({
                                command: WebSocketConstants.SEND_RULE_TABLE_MSG,
                                data: FollowAndAuthorRulesProcessor.getInstance().getRuleTableForClient()
                            }));*/
                            ws.send(JSON.stringify({
                                command: WebSocketConstants.SEND_RULE_TABLE_MSG,
                                data: FollowAndAuthorRulesProcessor.getInstance().getRuleTableForClient()
                            }));

                            /*ws.send(MessageProcessor.encodeData({
                                command: WebSocketConstants.SEND_VERIFY_RULES_MSG,
                                data: ""
                            }));*/
                            ws.send(JSON.stringify({
                                command: WebSocketConstants.SEND_VERIFY_RULES_MSG,
                                data: ""
                            }));
                        }).catch(error=>console.error("Error sending xml files : ",error));
                        // Here you can optionally handle the stored XML data, e.g., send via WebSocket
                    }).catch(error => console.error('Error converting Java files to XML:', error));



                } else {
                    console.log("No workspace found");
                    vscode.window.showWarningMessage(
                        'DesignFix: no folder is open. Use "Open Folder" (or "Add Folder to Workspace"), ' +
                        'then reload the DesignFix client to analyze it.'
                    );
                }
            })().catch(error => console.error('Error in WebSocket connection handler:', error));

            ws.on('message', (message: string) => {
                //console.log(`Received message: ${message}`);
                const faw = FollowAndAuthorRulesProcessor.getInstance();
                const mr = MiningRulesProcessor.getInstance();
                try {
                    const json = JSON.parse(message.toString());
                    //console.log("Command:", json.command);
                    //console.log("Data:", json.data);


                    if (faw.wsMessages.includes(json.command)) {
                        //console.log('Received a recognized command:', json.command);
                        faw.processReceivedMessages(message);
                        // Handle the command as needed
                    }
                    else if (mr.wsMessages.includes(json.command)) {
                        console.log("in MR");
                        mr.processReceivedMessages(message);
                    }
                } catch (e) {
                    console.error("Error parsing JSON:", e);
                }




            });

            ws.on('error', (error) => {
                console.error(`WebSocket error: ${error}`);
            });

            ws.on('close', () => {
                console.log('Client disconnected');
                if (activeWebSocket === ws) {
                    activeWebSocket = null;
                }
            });
        });





    context.subscriptions.push(vscode.commands.registerCommand('designfix.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from DesignFix!');
    }));

    // CodeLens Accept/Reject integration for diff view
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'java', scheme: 'untitled' },
            {
                onDidChangeCodeLenses: codeLensChangeEmitter.event,
                provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
                    // Only show a chunk's lenses on the diff tab it belongs to.
                    // (Legacy chunks without modifiedUri show on any untitled java doc.)
                    return diffChunks.flatMap((chunk, i) => {
                        if (chunk.modifiedUri && chunk.modifiedUri !== document.uri.toString()) {
                            return [];
                        }
                        return [
                        new vscode.CodeLens(chunk.range, {
                            command: 'designfix.acceptChange',
                            title: 'Accept Change',
                            arguments: [i]
                        }),
                        new vscode.CodeLens(chunk.range, {
                            command: 'designfix.rejectChange',
                            title: 'Reject Change',
                            arguments: [i]
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

    const finishChunk = async (chunk: DiffChunk): Promise<void> => {
        const i = diffChunks.indexOf(chunk);
        if (i >= 0) {
            diffChunks.splice(i, 1);
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
            const chunk = diffChunks[index];

            // The right-side buffer is editable; honor any hand-edits the user made.
            const rightDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === chunk.modifiedUri);
            const rightText = rightDoc ? rightDoc.getText() : chunk.newText;

            try {
                let doc: vscode.TextDocument | null = null;
                try {
                    doc = await vscode.workspace.openTextDocument(chunk.filePath);
                } catch {
                    doc = null; // fix creates a new file
                }

                if (doc) {
                    // Re-reconcile against the CURRENT document state so the applied
                    // edit stays minimal even after hand-edits or on-disk drift.
                    let rec = reconcile(doc.getText(), rightText);
                    if (rec.truncationSuspected) {
                        const pick = await vscode.window.showWarningMessage(
                            `Applying this fix would delete ${rec.keptDeletionLines} line(s) with no replacement ` +
                            `(possibly truncated LLM output). How should DesignFix proceed?`,
                            { modal: true },
                            'Keep those lines and apply',
                            'Delete them and apply'
                        );
                        if (pick === undefined) { return; }
                        if (pick === 'Delete them and apply') {
                            rec = reconcile(doc.getText(), rightText, { allowLargeDeletions: true });
                        }
                    }
                    if (rec.identicalAfterReconcile) {
                        vscode.window.showInformationMessage(
                            'DesignFix: the file already satisfies this suggestion; nothing to apply.'
                        );
                        await closeReviewTab(chunk);
                        await finishChunk(chunk);
                        return;
                    }
                    const fullRange = new vscode.Range(
                        doc.positionAt(0),
                        doc.positionAt(doc.getText().length)
                    );
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(doc.uri, fullRange, rec.patchedText);
                    const applied = await vscode.workspace.applyEdit(edit);
                    if (!applied) {
                        throw new Error('workspace edit was not applied');
                    }
                    await doc.save();
                } else {
                    await fs.promises.writeFile(chunk.filePath, rightText, 'utf8');
                }

                vscode.window.showInformationMessage(
                    `DesignFix: changes applied to ${chunk.filePath.split(/[\\/]/).pop()}.`
                );
                await closeReviewTab(chunk);
                await finishChunk(chunk);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to apply fix: ${err.message}`);
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

            // Nothing was written to disk for this file (the diff is a preview),
            // so just discard this file's change from the review set.
            await closeReviewTab(chunk);
            await finishChunk(chunk);
            vscode.window.showInformationMessage(
                `DesignFix: rejected change to ${chunk.filePath.split(/[\\/]/).pop()}.`
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
    acceptStatusItem.tooltip = 'Apply the DesignFix suggestion shown in the diff to the file';
    acceptStatusItem.command = 'designfix.acceptChange';
    acceptStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    const rejectStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9999);
    rejectStatusItem.text = '$(close) Reject';
    rejectStatusItem.tooltip = 'Discard the DesignFix suggestion shown in the diff';
    rejectStatusItem.command = 'designfix.rejectChange';

    const updateReviewControls = () => {
        if (diffChunks.length > 0) {
            const suffix = diffChunks.length > 1 ? ` (${diffChunks.length} pending)` : '';
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




    // Ensure the server is closed when the extension is deactivated
    context.subscriptions.push(new vscode.Disposable(() => server.close()));
}

export function deactivate() { }
