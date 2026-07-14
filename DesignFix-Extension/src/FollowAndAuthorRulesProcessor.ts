import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as fs from 'fs/promises'; // Use fs/promises for readFile
import * as path from 'path';
import { WebSocketConstants } from './WebSocketConstants';
//import { MessageProcessor } from './MessageProcessor';
import { Constants } from './Constants';
import * as fs1 from 'fs';
import { FileChangeManager } from './FileChangeManager';
import { writeToFile, convertToXML, findFileAndReadContent } from './utilites';

import { reconcile, describeReconcile, ReconcileResult } from './reconcile';
import { codeLensChangeEmitter } from './extension';
import { sourceSnapshotsEqual } from './sourceSnapshot';

export interface DiffChunk {
    range: vscode.Range;
    newText: string;
    filePath: string;
    originalText: string;
    fullOriginalContent: string;
    startOffset: number;
    endOffset: number;
    // URI (as string) of the untitled modified document this chunk belongs to.
    // Used to scope the Accept/Reject CodeLenses to the correct diff tab when a
    // multi-file fix opens several diff views at once.
    modifiedUri?: string;
    // Every file in one suggested fix shares a stable review id. Accept/reject
    // operates on the whole group so cross-file changes cannot be half-applied.
    reviewId: string;
    schemaVersion?: number;
    operation?: string;
}
export const diffChunks: DiffChunk[] = [];



interface Tag {
    ID: string;
    tagName: string;
    detail: string;
}



export class FollowAndAuthorRulesProcessor {
    private static instance: FollowAndAuthorRulesProcessor | null = null;
    private ws: WebSocket | null;
    private ruleTable: any[]; // Consider using a more specific type
    private tagTable: Tag[];
    private currentProjectPath: string;
    private reviewSequence = 0;
    public readonly wsMessages: string[] = [
        WebSocketConstants.RECEIVE_EDIT_FIX,
        WebSocketConstants.SEND_CONTENT_FOR_EDIT_FIX,
        WebSocketConstants.RECEIVE_LLM_MODIFIED_FILE_CONTENT,
        WebSocketConstants.RECEIVE_CONVERTED_JAVA_SNIPPET_MSG,
        WebSocketConstants.RECEIVE_LLM_SNIPPET_MSG,
        WebSocketConstants.RECEIVE_SNIPPET_XML_MSG,
        WebSocketConstants.RECEIVE_MODIFIED_RULE_MSG,
        WebSocketConstants.RECEIVE_MODIFIED_TAG_MSG,
        WebSocketConstants.RECEIVE_CODE_TO_XML_MSG,
        WebSocketConstants.RECEIVE_NEW_RULE_MSG,
        WebSocketConstants.RECEIVE_NEW_TAG_MSG,
    ];

    public constructor(currentProjectPath: string, ws: WebSocket | null) {
        this.currentProjectPath = currentProjectPath;
        this.ws = ws;
        this.tagTable = [];
        this.ruleTable = []; // Initialize as an empty array
        this.loadTagTable();
        this.loadRuleTable();
    }

    public static getInstance(currentProjectPath: string = "", ws: WebSocket | null = null): FollowAndAuthorRulesProcessor {
        if (this.instance === null) {
            this.instance = new FollowAndAuthorRulesProcessor(currentProjectPath, ws);
        }
        return this.instance;
    }

    private async loadTagTable(): Promise<void> {
        const tagTablePath = path.join(this.currentProjectPath, Constants.TAG_TABLE_JSON);
        try {
            const data = await fs.readFile(tagTablePath, { encoding: 'utf8' });
            this.tagTable = JSON.parse(data);
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err?.code === 'ENOENT') {
                this.tagTable = [];
                try {
                    await fs.writeFile(tagTablePath, JSON.stringify(this.tagTable, null, 2), { encoding: 'utf8' });
                    console.warn(`Tag table not found. Created default at ${tagTablePath}`);
                } catch (writeError) {
                    console.error('Failed to create default tag table:', writeError);
                }
            } else {
                console.error('Failed to load tag table:', error);
            }
        }
    }

    private async loadRuleTable(): Promise<void> {
        const ruleTablePath = path.join(this.currentProjectPath, Constants.RULE_TABLE_JSON);
        try {
            const data = await fs.readFile(ruleTablePath, { encoding: 'utf8' });
            this.ruleTable = JSON.parse(data);
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err?.code === 'ENOENT') {
                this.ruleTable = [];
                try {
                    await fs.writeFile(ruleTablePath, JSON.stringify(this.ruleTable, null, 2), { encoding: 'utf8' });
                    console.warn(`Rule table not found. Created default at ${ruleTablePath}`);
                } catch (writeError) {
                    console.error('Failed to create default rule table:', writeError);
                }
            } else {
                console.error('Failed to load rule table:', error);
            }
        }
    }

    public updateProjectWs(projectPath: string, ws: WebSocket): void {
        this.currentProjectPath = projectPath;
        this.ws = ws;
        this.loadTagTable();
        this.loadRuleTable();
    }

    private nextReviewId(): string {
        this.reviewSequence += 1;
        return `${Date.now()}-${this.reviewSequence}`;
    }

    private resolveWorkspaceTarget(targetPath: string): string {
        const workspaceRoot = path.resolve(this.currentProjectPath);
        const resolved = path.resolve(path.isAbsolute(targetPath)
            ? targetPath
            : path.join(workspaceRoot, targetPath));
        const relative = path.relative(workspaceRoot, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error(`Fix target is outside the active workspace: ${targetPath}`);
        }
        return resolved;
    }

    public getRuleTableForClient(): string {
        const ruleTableData = JSON.stringify(this.ruleTable);
        return ruleTableData;
    }

    public getTagTableForClient(): string {
        const tagTableData = JSON.stringify(this.tagTable);
        return tagTableData;
    }




    public async processReceivedMessages(message: string): Promise<void> {
        const jsonData = JSON.parse(message.toString());
        const command = jsonData.command;

        switch (command) {

            case WebSocketConstants.RECEIVE_EDIT_FIX:
                //console.log("ASDASDASDasdadad22222");
                //console.log(jsonData);
                const filePathOfSuggestedFix = jsonData.data.filePathOfSuggestedFix;

                findFileAndReadContent(filePathOfSuggestedFix)
                    .then(content => {
                        if (content) {
                            // Process the file content as needed
                            console.log('File content:', content);

                            this.ws?.send(JSON.stringify({
                                command: WebSocketConstants.SEND_CONTENT_FOR_EDIT_FIX,
                                data: content
                            }));
                        }
                    })
                    .catch(err => {
                        console.error('Error reading file content:', err);
                    });

                break;


            case WebSocketConstants.RECEIVE_LLM_MODIFIED_FILE_CONTENT: {
                await this.handleLlmModifiedFileContent(jsonData);
                break;
            }





            /*
            case WebSocketConstants.RECEIVE_LLM_MODIFIED_FILE_CONTENT:
                console.log("COME");
                console.log(jsonData);

                // 1) Extract incoming fields
                var localFilePath = jsonData.data.filePath as string;
                var modifiedContent = jsonData.data.modifiedFileContent as string;
                var violatedCode = jsonData.data.violatedCode as string;
                // (explanation available if you want to inject as a comment)

                // 2) Helper to escape RegExp metachars
                var escapeRegExp = (s: string) =>
                    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                // 3) Read the original file off disk
                fs1.readFile(localFilePath, 'utf8', (err, originalContent) => {
                    if (err) {
                        console.error('Error reading the file:', err);
                        return;
                    }

                    // 4) Produce the “fixed” content
                    const regex = new RegExp(escapeRegExp(violatedCode), 'gs');
                    const finalContent = originalContent.replace(regex, modifiedContent);

                    // 5) Show the real file side-by-side in Column 1
                    vscode.workspace.openTextDocument(localFilePath)
                        .then(doc => vscode.window.showTextDocument(doc, vscode.ViewColumn.One),
                            openErr => console.error(openErr));

                    // 6) Prepare your yellow highlight decoration
                    const highlightDeco = vscode.window.createTextEditorDecorationType({
                        backgroundColor: 'rgba(255,255,0,0.4)'
                    });

                    // 7) Clear out any old diffs
                    diffChunks.length = 0;

                    // 8) Open an unsaved Java doc with the new content in Column 2
                    vscode.workspace.openTextDocument({ language: 'java', content: finalContent })
                        .then(newDoc =>
                            vscode.window.showTextDocument(newDoc, vscode.ViewColumn.Two)
                                .then(editor => {
                                    // 9) Compute a char-level diff
                                    const diffs = diffChars(originalContent, finalContent);
                                    let offset = 0;
                                    const decorations: vscode.DecorationOptions[] = [];

                                    for (const part of diffs) {
                                        if (!part.removed) {
                                            const len = part.value.length;
                                            if (part.added) {
                                                const start = newDoc.positionAt(offset);
                                                const end = newDoc.positionAt(offset + len);

                                                // 10) Highlight the added range
                                                decorations.push({ range: new vscode.Range(start, end) });

                                                // 11) Record this chunk (with exact offsets)
                                                const startOffset = newDoc.offsetAt(start);
                                                const endOffset = newDoc.offsetAt(end);
                                                // …after you do:
                                                // fs1.readFile(localFilePath, 'utf8', (err, originalContent) => { … })
                                                const fullOriginalContent = originalContent;

                                                // then, when you push each diff:
                                                diffChunks.push({
                                                    range: new vscode.Range(start, end),
                                                    newText: part.value,
                                                    originalText: violatedCode,
                                                    fullOriginalContent:fullOriginalContent,          // ← add this
                                                    filePath: localFilePath,
                                                    startOffset,
                                                    endOffset
                                                });

                                            }
                                            offset += len;
                                        }
                                    }

                                    // 12) Apply highlights and refresh CodeLenses
                                    editor.setDecorations(highlightDeco, decorations);
                                    vscode.commands.executeCommand('editor.action.codeLens.refresh');
                                },
                                    showErr => console.error(showErr)
                                ),
                            docErr => console.error(docErr)
                        );
                });
                break;
            */



            /*
            case WebSocketConstants.RECEIVE_LLM_MODIFIED_FILE_CONTENT:
                console.log("COME");
                console.log(jsonData);

                var localFilePath = jsonData.data.filePath as string;
                var modifiedContent = jsonData.data.modifiedFileContent as string;
                var violatedCode = jsonData.data.violatedCode as string;
                // (explanation is available if you want to inject it as a comment)

                // 1) Read original file
                fs1.readFile(localFilePath, 'utf8', (err, originalContent) => {
                    if (err) {
                        console.error('Error reading the file:', err);
                        return;
                    }

                    // 2) Replace the violated snippet
                    var escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(escapeRegExp(violatedCode), 'gs');
                    const finalContent = originalContent.replace(regex, modifiedContent);

                    // 3) Open the original on Column One
                    vscode.workspace.openTextDocument(localFilePath)
                        .then(doc => vscode.window.showTextDocument(doc, vscode.ViewColumn.One),
                            openErr => console.error(openErr));

                    // 4) Create a decoration type for highlighting diffs
                    const highlightDeco = vscode.window.createTextEditorDecorationType({
                        backgroundColor: 'rgba(255,255,0,0.4)'
                    });

                    // 5) Open an untitled Java doc with the edited content on Column Two
                    vscode.workspace.openTextDocument({ language: 'java', content: finalContent })
                        .then(newDoc =>
                            vscode.window.showTextDocument(newDoc, vscode.ViewColumn.Two)
                                .then(editor => {
                                    // 6) Compute the diff between original vs. final
                                    const diffs = diffChars(originalContent, finalContent);

                                    // 7) Walk the diff to collect ranges of *added* or *changed* text
                                    const decorations: vscode.DecorationOptions[] = [];
                                    let offset = 0;
                                    for (const part of diffs) {
                                        if (!part.removed) {
                                            const length = part.value.length;
                                            if (part.added) {
                                                const start = newDoc.positionAt(offset);
                                                const end = newDoc.positionAt(offset + length);
                                                decorations.push({ range: new vscode.Range(start, end) });
                                            }
                                            offset += length;
                                        }
                                    }

                                    // 8) Apply the highlighting on Column Two
                                    editor.setDecorations(highlightDeco, decorations);
                                },
                                    showErr => console.error(showErr)
                                ),
                            docErr => console.error(docErr)
                        );
                });
                break;
            */





            // Within your switch/case block:
            case WebSocketConstants.RECEIVE_LLM_MODIFIED_FILE_CONTENT_backup: {
                await this.handleLlmModifiedFileContent(jsonData);
                break;
            }


            /*
                        case WebSocketConstants.RECEIVE_LLM_MODIFIED_FILE_CONTENT:
            
                            //modifiedFileContent is just the suggestion from GPT, not the whole codefile with the modifications. 
                            //JUST THE MODIFICATIONS
                            console.log("COME");
                            console.log(jsonData);
                            const localFilePath = jsonData.data.filePath;
                            const modifiedContent = jsonData.data.modifiedFileContent;
                            const explanation = jsonData.data.explanation;
                            const violatedCode = jsonData.data.violatedCode;
            
                            // Function to escape special characters in a string for use in a regular expression
                            const escapeRegExp = (string: string): string => {
                                return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
                            };
            
                            // Read the file content
                            fs1.readFile(localFilePath, 'utf8', (err, data) => {
                                if (err) {
                                    console.error('Error reading the file:', err);
                                    return;
                                }
            
                                // Escape the violatedCode for use in a regular expression
                                const escapedViolatedCode = escapeRegExp(violatedCode);
            
                                // Create a regular expression to find the violated code, with the 's' flag for dotAll mode
                                const regex = new RegExp(escapedViolatedCode, 'gs');
            
                                // Replace the violated code with the modified content
                                const newContent = data.replace(regex, modifiedContent);
            
                                // Format the explanation as a comment
                                
                                const comment = ``;
            
                                // Prepare the final content with the explanation
                                const finalContent = `${comment}${newContent}`;
            
                                // Write the updated content back to the file
                                fs1.writeFile(localFilePath, finalContent, 'utf8', (err) => {
                                    if (err) {
                                        console.error('Error writing to the file:', err);
                                    } else {
                                        console.log('File updated successfully.');
                                    }
                                });
                            });
                            break;
                        */


            case WebSocketConstants.RECEIVE_CONVERTED_JAVA_SNIPPET_MSG:
                console.log("ASDAD222aaaa");
                try {
                    //const data = JSON.parse(message);
                    const fileName = jsonData.data.fileName;
                    const convertedJava = jsonData.data.convertedJava;
                    const lastLineSnippet = convertedJava.trim().split('\n').pop().trim();

                    const openPath = vscode.Uri.file(fileName);
                    vscode.workspace.openTextDocument(openPath).then(doc => {
                        vscode.window.showTextDocument(doc).then(editor => {
                            const text = doc.getText();
                            const lines = text.split('\n');
                            let lineIndex = -1;

                            // Find the line containing the lastLineSnippet
                            for (let i = 0; i < lines.length; i++) {
                                if (lines[i].includes(lastLineSnippet)) {
                                    lineIndex = i;
                                    break;
                                }
                            }

                            if (lineIndex !== -1) {
                                const startPos = new vscode.Position(lineIndex, 0);
                                const endPos = new vscode.Position(lineIndex, lines[lineIndex].length);
                                const range = new vscode.Range(startPos, endPos);

                                editor.selection = new vscode.Selection(startPos, endPos);
                                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

                                // Optionally highlight the line
                                const decoration = vscode.window.createTextEditorDecorationType({
                                    backgroundColor: 'rgba(255,255,0,0.3)'
                                });
                                editor.setDecorations(decoration, [range]);
                            }
                        });
                    });
                } catch (error) {
                    vscode.window.showErrorMessage('Failed to process the message: ' + error);
                }
                break;

            case WebSocketConstants.RECEIVE_LLM_SNIPPET_MSG:
                console.log("CAME HERE");
                const code = jsonData.data.code;
                // Format the explanation as a multiline comment
                const explanationAsComment = `/*\n * ${jsonData.data.explanation.replace(/\n/g, '\n * ')}\n */\n\n`;

                // Create a new split window with the explanation comment at the top and the code below
                vscode.workspace.openTextDocument({ content: explanationAsComment + code, language: 'java' }) // Adjust the language as necessary
                    .then(document => {
                        vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
                    });
                break;

            case WebSocketConstants.RECEIVE_SNIPPET_XML_MSG:
                // Handle RECEIVE_SNIPPET_XML_MSG
                /*const xmlString = jsonData.data.xml;


                const tempXmlFilePath = path.join(this.currentProjectPath, Constants.TEMP_XML_FILE);
                const xmlHeader = Constants.XML_HEADER;

                // Write XML to temporary file
                fs.writeFile(tempXmlFilePath, xmlHeader + xmlString, { encoding: 'utf8' });

                // Open the specified file
                //we are getting the full path from the client 
                const fileUri = vscode.Uri.file(jsonData.data.fileName);
                const document = await vscode.workspace.openTextDocument(fileUri);
                const editor = await vscode.window.showTextDocument(document);

                try {
                    const positionString = await findLineNumber(tempXmlFilePath);
                    // Calculate the position based on the XML length
                    const positionIndex = positionString.length;

                    // Find the position in the document
                    const charPosition = document.positionAt(positionIndex);

                    // Get the entire line where the character is located
                    const line = document.lineAt(charPosition.line);

                    // Use the start and end of the line for startPosition and endPosition
                    const startPosition = line.range.start;
                    const endPosition = line.range.end;

                    // Move the cursor and highlight the whole line
                    editor.selection = new vscode.Selection(startPosition, endPosition);
                    editor.revealRange(new vscode.Range(startPosition, endPosition), vscode.TextEditorRevealType.InCenter);
                } catch (error) {
                    console.error("An error occurred:");
                    console.error(error); // Handle the error
                }*/


                break;

            case WebSocketConstants.RECEIVE_MODIFIED_RULE_MSG:
                // Extract ruleID and ruleInfo from jsonData.data
                const ruleID = jsonData.data.ruleID;
                const ruleInfo = jsonData.data.ruleInfo;
                const ruleExists = this.checkRuleExists(ruleID, ruleInfo);
                if (ruleExists) {
                    const ruleIndex = this.ruleTable.findIndex(rule => rule.index === ruleID);
                    this.ruleTable[ruleIndex] = ruleInfo;
                    this.updateRuleTableFile();

                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            command: WebSocketConstants.SEND_UPDATE_RULE_MSG,
                            data: jsonData.data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }


                }
                else {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            command: WebSocketConstants.SEND_FAILED_UPDATE_RULE_MSG,
                            data: jsonData.data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }

                }
                // Update the rule by ruleID with ruleInfo here
                break;
            case WebSocketConstants.RECEIVE_MODIFIED_TAG_MSG:
                // Extract tagID and tagInfo from jsonData.data
                const updateTagID = jsonData.data.tagID;
                const updateTagInfo = jsonData.data.tagInfo;
                var data = {
                    ID: jsonData.data.tagInfo.ID,
                    tagName: jsonData.data.tagInfo.tagName,
                    detail: jsonData.data.tagInfo.detail
                };
                // Update the tag by tagID with tagInfo here
                const tagExists = this.checkTagExists(updateTagID, updateTagInfo);
                if (tagExists) {
                    const tagIndex = this.tagTable.findIndex(tag => tag.ID === updateTagID);
                    this.tagTable[tagIndex] = updateTagInfo;
                    this.updateTagTableFile();

                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            command: WebSocketConstants.SEND_UPDATE_TAG_MSG,
                            data: data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }


                }
                else {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({

                            command: WebSocketConstants.SEND_FAILED_UPDATE_TAG_MSG,
                            data: data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }

                }

                break;
            case WebSocketConstants.RECEIVE_CODE_TO_XML_MSG:
                // Handle conversion of code to XML and respond back
                const plainCode = jsonData.data.codeText;
                const tempJavaFilePath = path.join(this.currentProjectPath, Constants.TEMP_JAVA_FILE);
                writeToFile(tempJavaFilePath, plainCode);
                if (tempJavaFilePath.endsWith('.java')) {


                    try {
                        const xmlContent = await convertToXML(tempJavaFilePath); // Adjusted call
                        if (this.ws?.readyState === WebSocket.OPEN) {
                            this.ws.send(JSON.stringify({
                                command: WebSocketConstants.SEND_XML_FROM_CODE_MSG,
                                data: {
                                    xmlText: xmlContent,
                                    messageID: jsonData.data.messageID
                                }
                            }));
                        } else {
                            console.warn('Skipping send: WebSocket not open');
                        }



                    } catch (error) {
                        console.error(`Error processing newly created file ${tempJavaFilePath}:`, error);
                    }
                }

                //const resultXML = FileChangeManager.getInstance(this.currentProjectPath,this.ws).convertToXML(tempJavaFilePath) 


                break;
            case WebSocketConstants.RECEIVE_NEW_RULE_MSG:
                // Handle new rule creation from jsonData.data
                const newRuleID = jsonData.data.ruleID;
                const newRuleInfo = jsonData.data.ruleInfo;

                const ruleAlreadyExists = this.checkRuleExists(newRuleID, newRuleInfo);
                if (ruleAlreadyExists) {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            command: WebSocketConstants.SEND_FAILED_NEW_RULE_MSG,
                            data: jsonData.data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }


                }
                else {
                    //console.log("here");
                    this.ruleTable.push(newRuleInfo);
                    this.updateRuleTableFile();
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({

                            command: WebSocketConstants.SEND_NEW_RULE_MSG,
                            data: jsonData.data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }


                }

                break;
            case WebSocketConstants.RECEIVE_NEW_TAG_MSG:
                // Similar to the Java version, parse the jsonData for new tag info and process it
                const newTagID = jsonData.data.tagID;
                const newTagInfo = jsonData.data.tagInfo;
                data = {
                    ID: jsonData.data.tagInfo.ID,
                    tagName: jsonData.data.tagInfo.tagName,
                    detail: jsonData.data.tagInfo.detail
                };


                const tagAlreadyExists = this.checkTagExists(newTagID, newTagInfo);
                if (tagAlreadyExists) {


                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            command: WebSocketConstants.SEND_FAILED_NEW_TAG_MSG,
                            data: data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }



                }
                else {
                    this.tagTable.push(newTagInfo);
                    this.updateTagTableFile();
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({

                            command: WebSocketConstants.SEND_NEW_TAG_MSG,
                            data: data
                        }));
                    } else {
                        console.warn('Skipping send: WebSocket not open');
                    }

                }
                // Add a new tag based on newTagID and newTagInfo here
                break;
            // Add other case statements as necessary
            default:
                console.log(`Unrecognized command: ${command}`);
        }

    }

    private checkRuleExists(newRuleID: string, newRuleInfo: any): boolean {
        if (newRuleID !== newRuleInfo.index) {
            console.error("Mismatched IDs");
            return true;
        }

        const ruleExists = this.ruleTable.some(rule => rule.index === newRuleID);
        if (ruleExists) {
            return true;
        }
        return false;
    }

    private checkTagExists(newTagID: string, newTagInfo: Tag): boolean {


        // Ensure the ID in the newTagInfo matches newTagID
        if (newTagInfo.ID !== newTagID) {
            console.error("Mismatched IDs");
            return true;
        }

        // Check if the tagTable already contains a tag with the newTagID
        const tagExists = this.tagTable.some(tag => tag.ID === newTagID);
        if (tagExists) {
            // Tag already exists, return true
            return true;
        }
        return false;
    }


    private async updateRuleTableFile() {
        const ruleTablePath = path.join(this.currentProjectPath, Constants.RULE_TABLE_JSON); // Adjust __dirname to your project's root path as necessary

        // Read the existing tag table
        fs1.readFile(ruleTablePath, 'utf8', (err, data) => {
            if (err) {
                console.error('Error reading the file table:', err);
                return;
            }

            // Parse the existing tag table and append new tag info
            //const tagTable = JSON.parse(data);


            // Write the updated tag table back to the file
            fs1.writeFile(ruleTablePath, JSON.stringify(this.ruleTable, null, 2), 'utf8', (err) => {
                if (err) {
                    console.error('Error writing the updated rule table:', err);
                } else {
                    console.log('rule info successfully appended to tagTable.json');
                }
            });
        });
    }



    private async updateTagTableFile() {
        const tagTablePath = path.join(this.currentProjectPath, Constants.TAG_TABLE_JSON); // Adjust __dirname to your project's root path as necessary

        // Read the existing tag table
        fs1.readFile(tagTablePath, 'utf8', (err, data) => {
            if (err) {
                console.error('Error reading the tag table:', err);
                return;
            }

            // Parse the existing tag table and append new tag info
            //const tagTable = JSON.parse(data);


            // Write the updated tag table back to the file
            fs1.writeFile(tagTablePath, JSON.stringify(this.tagTable, null, 2), 'utf8', (err) => {
                if (err) {
                    console.error('Error writing the updated tag table:', err);
                } else {
                    console.log('Tag info successfully appended to tagTable.json');
                }
            });
        });
    }


    /**
     * Layer 2: present a reconciled fix in VS Code's native diff editor.
     * Left pane: the real file on disk (read-only view of truth). Right pane:
     * an EDITABLE untitled document holding the minimal patched content - the
     * user may hand-tune the suggestion before accepting, and the accept
     * command re-reconciles whatever ends up in that buffer.
     */
    private async openFixReview(
        targetPath: string,
        originalContent: string,
        rec: ReconcileResult,
        explanation: string,
        showNotification: boolean,
        reviewId: string,
        schemaVersion?: number,
        operation?: string,
    ): Promise<void> {
        const fileName = path.basename(targetPath);
        const patchedDoc = await vscode.workspace.openTextDocument({
            language: 'java',
            content: rec.patchedText
        });

        await vscode.commands.executeCommand(
            'vscode.diff',
            vscode.Uri.file(targetPath),
            patchedDoc.uri,
            `DesignFix: ${fileName} (original ↔ suggested fix)`,
            { preview: false }
        );

        const patchedTextNow = patchedDoc.getText();
        diffChunks.push({
            range: new vscode.Range(patchedDoc.positionAt(0), patchedDoc.positionAt(0)),
            newText: patchedTextNow,
            originalText: originalContent,
            fullOriginalContent: originalContent,
            filePath: targetPath,
            startOffset: 0,
            endOffset: patchedTextNow.length,
            modifiedUri: patchedDoc.uri.toString(),
            reviewId,
            schemaVersion,
            operation,
        });
        await vscode.commands.executeCommand('setContext', 'designfix.reviewActive', true);
        codeLensChangeEmitter.fire();

        if (explanation) {
            vscode.window.setStatusBarMessage(`LLM explanation: ${explanation}`, 8000);
        }

        if (showNotification) {
            const summary = `DesignFix: ${fileName} — ${describeReconcile(rec)}.`;
            const choice = await vscode.window.showInformationMessage(summary, 'Accept Fix', 'Reject');
            if (choice === 'Accept Fix') {
                await vscode.commands.executeCommand('designfix.acceptChange', patchedDoc.uri);
            } else if (choice === 'Reject') {
                await vscode.commands.executeCommand('designfix.rejectChange', patchedDoc.uri);
            }
        }
    }

    /**
     * Persist a fix-attempt record under <workspace-root>/data/rule_<id>/run_<NN>/.
     * The `data` folder sits alongside the DesignFix-Extension and DesignFix-client
     * folders and is git-ignored. Each run captures everything we know about the
     * attempt: metadata, token usage, prompts, raw responses, the list of files
     * the LLM inspected, and the original/modified content of every edited file.
     */
    private async writeFixLog(log: any): Promise<void> {
        // <root>/DesignFix-Extension/out -> up two levels -> workspace root.
        const dataRoot = path.join(__dirname, '..', '..', 'data');

        const sanitize = (s: string) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
        const ruleId = sanitize(log.ruleId !== undefined && log.ruleId !== null ? log.ruleId : 'unknown');
        const ruleDir = path.join(dataRoot, `rule_${ruleId}`);

        await fs.mkdir(ruleDir, { recursive: true });

        // Next run number: scan existing run_NN folders and increment.
        let nextRun = 1;
        try {
            const entries = await fs.readdir(ruleDir, { withFileTypes: true });
            const runNums = entries
                .filter(e => e.isDirectory() && /^run_\d+$/.test(e.name))
                .map(e => parseInt(e.name.slice(4), 10))
                .filter(n => !isNaN(n));
            if (runNums.length > 0) {
                nextRun = Math.max(...runNums) + 1;
            }
        } catch { /* ruleDir just created / empty */ }

        const runDir = path.join(ruleDir, `run_${String(nextRun).padStart(2, '0')}`);
        await fs.mkdir(runDir, { recursive: true });

        const inspectedFiles: any[] = Array.isArray(log.inspectedFiles) ? log.inspectedFiles : [];
        const editedFiles: any[] = Array.isArray(log.editedFiles) ? log.editedFiles : [];

        // meta.json: everything except the bulky file bodies and prompts.
        const meta = {
            ruleId: log.ruleId,
            ruleTitle: log.ruleTitle ?? '',
            createdAt: log.createdAt ?? new Date().toISOString(),
            model: log.model ?? '',
            violationFilePath: log.violationFilePath ?? '',
            exampleFilePath: log.exampleFilePath ?? '',
            tokenUsage: log.tokenUsage ?? null,
            inspectedFiles: inspectedFiles.map(f => ({ filePath: f.filePath, reason: f.reason ?? '' })),
            editedFiles: editedFiles.map(f => ({ filePath: f.filePath })),
            explanation: log.explanation ?? '',
        };
        await fs.writeFile(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

        // Prompts and raw model responses.
        if (log.prompts) {
            if (log.prompts.A) { await fs.writeFile(path.join(runDir, 'prompt_A.txt'), String(log.prompts.A), 'utf8'); }
            if (log.prompts.B) { await fs.writeFile(path.join(runDir, 'prompt_B.txt'), String(log.prompts.B), 'utf8'); }
        }
        if (log.responses) {
            if (log.responses.A) { await fs.writeFile(path.join(runDir, 'response_A.txt'), String(log.responses.A), 'utf8'); }
            if (log.responses.B) { await fs.writeFile(path.join(runDir, 'response_B.json'), String(log.responses.B), 'utf8'); }
        }

        // Original + modified content of every edited file, in a subfolder.
        if (editedFiles.length > 0) {
            const editsDir = path.join(runDir, 'edited_files');
            await fs.mkdir(editsDir, { recursive: true });
            let idx = 0;
            for (const f of editedFiles) {
                idx++;
                const base = sanitize(path.basename(f.filePath || `file_${idx}`));
                const stem = `${String(idx).padStart(2, '0')}_${base}`;
                if (typeof f.originalFileContent === 'string') {
                    await fs.writeFile(path.join(editsDir, `${stem}.original`), f.originalFileContent, 'utf8');
                }
                if (typeof f.modifiedFileContent === 'string') {
                    await fs.writeFile(path.join(editsDir, `${stem}.modified`), f.modifiedFileContent, 'utf8');
                }
            }
        }

        console.log(`DesignFix fix log written: ${runDir}`);
        vscode.window.setStatusBarMessage(`DesignFix: logged fix to data/rule_${ruleId}/run_${String(nextRun).padStart(2, '0')}`, 4000);
    }

    private async handleLlmModifiedFileContent(jsonData: any): Promise<void> {
        const data = jsonData?.data;
        if (!data) {
            console.error('LLM modified file content missing data payload.');
            return;
        }

        // Persist a full record of this fix attempt (files inspected/edited,
        // prompts, responses, token usage) for the agentic-comparison dataset.
        if (data.log) {
            try {
                await this.writeFixLog(data.log);
            } catch (err) {
                console.error('Failed to write DesignFix fix log:', err);
            }
        }

        // Structured edit batch. One or more files are reviewed as a single
        // transaction; nothing reaches disk until the complete group is accepted.
        if (Array.isArray(data.edits) && data.edits.length >= 1) {
            await this.applyMultiFileEdits(data.edits, data.explanation, data.schemaVersion);
            return;
        }

        let targetPath: string | undefined = data.filePath || data.fileToChange;
        if (!targetPath) {
            vscode.window.showErrorMessage('Unable to apply fix: no target file path provided.');
            return;
        }

        try {
            targetPath = this.resolveWorkspaceTarget(targetPath);
        } catch (error) {
            vscode.window.showErrorMessage(`Unable to review fix: ${(error as Error).message}`);
            return;
        }

        const newContentRaw: string = data.modifiedFileContent ?? '';
        const providedOriginalRaw: string = data.originalFileContent ?? '';
        const explanation: string = data.explanation ?? '';

        if (!newContentRaw.trim()) {
            vscode.window.showErrorMessage('LLM fix did not include replacement content.');
            return;
        }

        let fileContent: string;
        try {
            fileContent = await fs.readFile(targetPath, { encoding: 'utf8' });
        } catch (error) {
            console.error('Failed to read target file:', error);
            vscode.window.showErrorMessage(`Unable to read file: ${targetPath}`);
            return;
        }

        if (providedOriginalRaw && !sourceSnapshotsEqual(providedOriginalRaw, fileContent)) {
            if (data.schemaVersion === 2) {
                vscode.window.showErrorMessage(
                    `DesignFix: ${path.basename(targetPath)} changed after the fix was generated. Regenerate the fix before reviewing it.`
                );
                return;
            }
            console.warn('Provided original content does not match the current file on disk. Proceeding with on-disk version.');
        }

        // Layer 1: rebuild the suggestion as ORIGINAL + minimal hunks so that
        // formatting-only drift disappears and truncated LLM output cannot
        // silently delete code.
        const rec = reconcile(fileContent, newContentRaw, { allowLargeDeletions: data.schemaVersion === 2 });

        if (rec.identicalAfterReconcile) {
            vscode.window.showInformationMessage(
                `DesignFix: the suggestion for ${path.basename(targetPath)} matches the current file ` +
                `(only whitespace/formatting differs) — nothing to apply.`
            );
            return;
        }

        if (rec.truncationSuspected) {
            vscode.window.showWarningMessage(
                `DesignFix: the raw suggestion would have deleted ${rec.keptDeletionLines} line(s) with no ` +
                `replacement (possibly truncated LLM output). Those original lines were kept; review the diff.`
            );
            console.warn(`DesignFix reconcile: ${rec.truncationDetail}`);
        }

        await this.openFixReview(
            targetPath,
            fileContent,
            rec,
            explanation,
            true,
            this.nextReviewId(),
            data.schemaVersion,
            'modify',
        );
    }

    /** Queue one validated edit batch for an atomic VS Code review. */
    private async applyMultiFileEdits(edits: any[], explanation?: string, schemaVersion?: number): Promise<void> {
        const resolved: { path: string; content: string; original?: string; operation?: string }[] = [];
        for (const edit of edits) {
            let p: string | undefined = edit?.filePath || edit?.fileToChange;
            const content: string = edit?.modifiedFileContent ?? edit?.code ?? '';
            if (!p || !content.trim()) {
                if (schemaVersion === 2) {
                    vscode.window.showErrorMessage('DesignFix: an edit is missing its path or content. Nothing was queued.');
                    return;
                }
                console.warn('Skipping edit with missing path or content:', edit);
                continue;
            }
            if (schemaVersion === 2 && edit?.operation !== 'modify' && edit?.operation !== 'create') {
                vscode.window.showErrorMessage(`DesignFix: unsupported edit operation for ${p}. Nothing was queued.`);
                return;
            }
            try {
                p = this.resolveWorkspaceTarget(p);
            } catch (error) {
                vscode.window.showErrorMessage(`Unable to review fix: ${(error as Error).message}`);
                return;
            }
            resolved.push({
                path: p,
                content,
                original: typeof edit?.originalFileContent === 'string' ? edit.originalFileContent : undefined,
                operation: edit?.operation,
            });
        }

        if (resolved.length === 0) {
            vscode.window.showErrorMessage('LLM fix contained no applicable file edits.');
            return;
        }

        const uniquePaths = new Set(resolved.map(r => path.normalize(r.path).toLowerCase()));
        if (uniquePaths.size !== resolved.length) {
            vscode.window.showErrorMessage('DesignFix: the fix contains duplicate file targets. Nothing was queued.');
            return;
        }

        // Validate the complete group before opening any review tab. Version 2
        // edits must still target the exact base snapshots used by the client.
        const prepared: { edit: typeof resolved[number]; originalContent: string | null }[] = [];
        for (const edit of resolved) {
            let originalContent: string | null = null;
            try {
                originalContent = await fs.readFile(edit.path, { encoding: 'utf8' });
            } catch {
                console.warn(`No existing file for ${edit.path}; treating it as a proposed creation.`);
            }

            if (schemaVersion === 2) {
                if (edit.operation === 'create') {
                    if (originalContent !== null) {
                        vscode.window.showErrorMessage(
                            `DesignFix: ${path.basename(edit.path)} already exists, so the create operation was rejected.`
                        );
                        return;
                    }
                } else {
                    if (originalContent === null || typeof edit.original !== 'string') {
                        vscode.window.showErrorMessage(
                            `DesignFix: the base snapshot for ${path.basename(edit.path)} is unavailable. Nothing was queued.`
                        );
                        return;
                    }
                    if (!sourceSnapshotsEqual(edit.original, originalContent)) {
                        vscode.window.showErrorMessage(
                            `DesignFix: ${path.basename(edit.path)} changed after the fix was generated. Regenerate the complete fix.`
                        );
                        return;
                    }
                }
            }

            prepared.push({edit, originalContent});
        }

        // Keep earlier pending reviews intact. Clearing the global array here
        // orphaned their tabs and made Accept/Reject controls disappear.
        const reviewId = this.nextReviewId();
        let opened = 0;
        const alreadySatisfied: string[] = [];
        const truncationWarnings: string[] = [];
        for (const item of prepared) {
            const r = item.edit;
            const originalContent = item.originalContent;

            if (originalContent === null) {
                // New file: nothing to reconcile against - review the proposed
                // content directly; accepting writes it as-is.
                const newDoc = await vscode.workspace.openTextDocument({ language: 'java', content: r.content });
                await vscode.window.showTextDocument(newDoc, { viewColumn: vscode.ViewColumn.Two, preview: false });
                const text = newDoc.getText();
                diffChunks.push({
                    range: new vscode.Range(newDoc.positionAt(0), newDoc.positionAt(0)),
                    newText: text,
                    originalText: '',
                    fullOriginalContent: '',
                    filePath: r.path,
                    startOffset: 0,
                    endOffset: text.length,
                    modifiedUri: newDoc.uri.toString(),
                    reviewId,
                    schemaVersion,
                    operation: r.operation || 'create',
                });
                opened++;
                continue;
            }

            const rec = reconcile(originalContent, r.content, { allowLargeDeletions: schemaVersion === 2 });

            // Nothing genuinely changes (already applied, or formatting-only).
            if (rec.identicalAfterReconcile) {
                alreadySatisfied.push(path.basename(r.path));
                continue;
            }
            if (rec.truncationSuspected) {
                truncationWarnings.push(`${path.basename(r.path)}: kept ${rec.keptDeletionLines} line(s)`);
                console.warn(`DesignFix reconcile (${r.path}): ${rec.truncationDetail}`);
            }

            await this.openFixReview(r.path, originalContent, rec, '', false, reviewId, schemaVersion, r.operation || 'modify');
            opened++;
        }

        await vscode.commands.executeCommand('setContext', 'designfix.reviewActive', diffChunks.length > 0);
        codeLensChangeEmitter.fire();

        if (opened > 0) {
            vscode.window.showInformationMessage(
                `DesignFix suggested one atomic fix across ${opened} file(s). Accepting or rejecting any tab resolves the whole fix.`
            );
            if (explanation) {
                vscode.window.setStatusBarMessage(`LLM explanation: ${explanation}`, 8000);
            }
        }

        if (truncationWarnings.length > 0) {
            vscode.window.showWarningMessage(
                `DesignFix: possible truncated suggestion; original lines were kept (${truncationWarnings.join('; ')}).`
            );
        }

        if (alreadySatisfied.length > 0) {
            vscode.window.showWarningMessage(
                `DesignFix: ${alreadySatisfied.length} file(s) already satisfied (only formatting differed): ${alreadySatisfied.join(', ')}.`
            );
        }

        if (opened === 0 && alreadySatisfied.length === 0) {
            vscode.window.showErrorMessage('DesignFix: no reviewable file edits were produced.');
        }
    }
}
