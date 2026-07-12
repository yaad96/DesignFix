import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as fs from 'fs'; // Use fs/promises for readFile
import * as path from 'path';
import { WebSocketConstants } from './WebSocketConstants';
//import { MessageProcessor } from './MessageProcessor';
import { Constants } from './Constants';
import * as fs1 from 'fs';
import { FileChangeManager } from './FileChangeManager';
import { writeToFile, convertToXML } from './utilites';
import { LearnDesignRules } from './core/model/LearnDesignRules';

export class MiningRulesProcessor {
    private static instance: MiningRulesProcessor | null = null;
    private ws: WebSocket | null;
    private currentProjectPath: string;
    private learningDRPath: string;

    public readonly wsMessages: string[] = [
        //delete the content of the directory, the directory = drlearning in the root directory
        WebSocketConstants.RECEIVE_REFRESH_LEARN_DESIGN_RULES_DIRECTORY_MSG,
        //receive info about database, write into files
        WebSocketConstants.RECEIVE_LEARN_DESIGN_RULES_DATABASES_MSG,
        //if the message is too big, client breaks it in multiple pieces and we just have to keep appending to 
        //appropriate file
        WebSocketConstants.RECEIVE_LEARN_DESIGN_RULES_DATABASES_APPEND_MSG,
        //recieve features, write in appropriate file
        WebSocketConstants.RECEIVE_LEARN_DESIGN_RULES_FEATURES_MSG,
        //receive too long features,client breaks it up, write in file sequentially
        WebSocketConstants.RECEIVE_LEARN_DESIGN_RULES_FEATURES_APPEND_MSG,
        //receive something, write something
        WebSocketConstants.LEARN_DESIGN_RULES_HELPER_FILES_MSG,
        //client breaks a long message, sends to us, we process it
        WebSocketConstants.LEARN_DESIGN_RULES_HELPER_FILES_APPEND_MSG,
        //triggering the whole algorithm
        WebSocketConstants.RECEIVE_MINE_DESIGN_RULES_MSG
    ];

    public constructor(currentProjectPath: string, ws: WebSocket | null) {
        this.currentProjectPath = currentProjectPath;
        this.ws = ws;
        this.learningDRPath = path.join(this.currentProjectPath, Constants.LEARNING_DR_DIRECTORY);

    }

    public static getInstance(currentProjectPath: string = "", ws: WebSocket | null = null): MiningRulesProcessor {
        if (this.instance === null) {
            this.instance = new MiningRulesProcessor(currentProjectPath, ws);
        }
        return this.instance;
    }

    public updateProjectWs(projectPath: string, ws: WebSocket): void {
        this.currentProjectPath = projectPath;
        this.ws = ws;
        this.learningDRPath = path.join(this.currentProjectPath, Constants.LEARNING_DR_DIRECTORY);

    }

    public async writeDataToFileLearningDR(fileName: string, content: string) {
        //const directoryName = path.join(this.projectPath, this.directory);
        const filePath = path.join(this.learningDRPath, fileName);

        console.log("File Path: ",filePath);

        try {
            // Ensure the directory exists, if not, creates a one
            fs.mkdirSync(this.learningDRPath, { recursive: true });

            // Decide to append or overwrite based on file existence
            try {
                fs.accessSync(filePath); // Check if file exists
                // If no error, file exists. Append to the file.
                fs.appendFileSync(filePath, content, { encoding: 'utf8' });
                console.log(`Data successfully appended to ${fileName}`);
            } catch {
                // If error, file does not exist. Overwrite/create the file.
                fs.writeFileSync(filePath, content, { encoding: 'utf8' });
                console.log(`Data successfully written to ${fileName}`);
            }
        } catch (err) {
            console.error(`Error handling file operation for ${fileName}: ${err}`);
        }
    }

    public async processReceivedMessages(message: string): Promise<void> {
        const jsonData = JSON.parse(message.toString());
        //console.log("HERE");
        const command = jsonData.command;

        switch (command) {
            //delete the content of the directory, the directory = drlearning in the root directory
            case WebSocketConstants.RECEIVE_REFRESH_LEARN_DESIGN_RULES_DIRECTORY_MSG:
                try {
                    fs.rmSync(this.learningDRPath, { recursive: true, force: true });
                    console.log(`${this.learningDRPath} was successfully deleted.`);
                } catch (err) {
                    console.error(`Failed to delete ${this.learningDRPath}:`, err);
                }
                break;
            //receive info about database, write into files
            /*{
                "command": "RECEIVE_LEARN_DESIGN_RULES_FEATURES_MSG",
                "data": [
                  ["feature1.txt", "Feature 1 data..."],
                  ["feature2.txt", "Feature 2 data..."]
                ]
              }*/

            case WebSocketConstants.RECEIVE_LEARN_DESIGN_RULES_DATABASES_MSG:
            case WebSocketConstants.RECEIVE_LEARN_DESIGN_RULES_FEATURES_MSG:
            case WebSocketConstants.LEARN_DESIGN_RULES_HELPER_FILES_MSG:
                console.log("IN THE SWITCH CASE");
                var filePathData: any[] = jsonData.data;
                filePathData.forEach((item: any[]) => {
                    const filePath = item[0];
                    const fileData = item[1];
                    this.writeDataToFileLearningDR(filePath, fileData);
                });

                break;


            case WebSocketConstants.RECEIVE_LEARN_DESIGN_RULES_DATABASES_APPEND_MSG:
            case WebSocketConstants.RECEIVE_LEARN_DESIGN_RULES_FEATURES_APPEND_MSG:
            case WebSocketConstants.LEARN_DESIGN_RULES_HELPER_FILES_APPEND_MSG:
                var filePathData: any[] = jsonData.data;
                filePathData.forEach((item: any[]) => {
                    const filePath = item[0];
                    const fileData = item[1];
                    this.writeDataToFileLearningDR(filePath, fileData);
                });

                break;

            case WebSocketConstants.RECEIVE_MINE_DESIGN_RULES_MSG:
                LearnDesignRules.analyzeDatabases(this.currentProjectPath, jsonData.data.parameters, jsonData.data.algorithm)
                    .then((results: { [key: string]: string }) => {
                        console.log("Analysis Results:", results);
                        if (this.ws?.readyState === WebSocket.OPEN) {
                            this.ws.send(JSON.stringify({ 
                                command:WebSocketConstants.SEND_MINED_DESIGN_RULES,
                                data:{
                                    algorithm:jsonData.data.algorithm,
                                    minedFrequentItemSets:results
                                }
                             }));
                          } else {
                            console.warn('Skipping send: WebSocket not open');
                          }
                          

                    })
                    .catch((error: any) => {
                        console.error("Error during analysis:", error);
                    });
                break;
        }
    }




}