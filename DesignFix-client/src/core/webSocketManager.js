/**
 * Created by saharmehrpour on 9/5/17.
 */

import {Component} from "react";
import {connect} from "react-redux";


import {
    commitRuleSnapshot,
    receiveExpressionStatementXML,
    ignoreFileChange, updateFilePath,
    updateRuleTable, updateTagTable,
    updateWS,
    updateProjectHierarchyData, updatedMinedRules, updateProjectPath,
    updateLoadingGif, updateFocusedElementData, updateDoiInformation, requestMineRulesForElement
} from "../actions";
import {checkRulesForAll, runRulesByTypes} from "./ruleExecutor";
import {webSocketReceiveMessage} from "./coreConstants";
import {processReceivedFrequentItemSets} from "../miningRulesCore/postProcessing";
import {getDataForFocusedElement, processDoiInformation} from "../miningRulesCore/focusedElementProcessing";
import Utilities from "./utilities";
import {hashConst} from "../ui/uiConstants";
import {SnapshotAccumulator} from "./snapshotAccumulator";

class WebSocketManager extends Component {

    constructor(props) {
        super(props);

        let xmlData = []; // Last fully committed [{filePath: "", xml: ""}] snapshot.
        let ruleTable = [];
        let tagTable = [];
        const stagedSnapshot = new SnapshotAccumulator();
        const committedXml = new SnapshotAccumulator();
        let projectPath = "";
        let counter = 3;

        this.ws = null;
        if (!window.WebSocket) {
            alert("FATAL: WebSocket not natively supported. This demo will not work!");
            return;
        }

        let ws = new WebSocket("ws://localhost:8887");
        this.ws = ws;
        this.props.onUpdateWS(ws);

        // Do not clear the committed Redux state while a replacement snapshot
        // is in flight. Only its private staging area starts over here.
        ws.onopen = () => stagedSnapshot.reset();
        ws.onclose = () => {
            if (this.ws === ws) this.props.onLoadingGif(false);
        };

        ws.onmessage = async (e) => {

            let message = Utilities.parseJson(e.data, "the received message", {command: ""});

            //console.log("Received message: ");
            if (message.command !== "XML") {
                console.log("Received message: ", message);
            }
            
            switch (message.command) {


                case webSocketReceiveMessage.enter_chat_msg:
                    // ENTER begins an atomic replacement transaction. Reset XML,
                    // tags, and rules together so no value leaks across cycles.
                    stagedSnapshot.reset();
                    this.props.onLoadingGif(true);
                    break;

                case webSocketReceiveMessage.project_path_msg:
                    // data: projectPath
                    projectPath = message.data;
                    this.props.onProjectPathUpdate(projectPath);
                    break;

                case webSocketReceiveMessage.project_hierarchy_msg:
                    // data: {projectHierarchy}
                    this.props.onProjectHierarchy(message.data);
                    break;

                case webSocketReceiveMessage.xml_files_msg:
                    // data: {filePath: "", xml: ""}
                    stagedSnapshot.upsertXml(message.data);
                    break;

                case webSocketReceiveMessage.rule_table_msg:
                    // data: [ruleTable]
                    stagedSnapshot.setRuleTable(Utilities.parseJson(message.data, "ruleTable", []));
                    break;

                case webSocketReceiveMessage.tag_table_msg:
                    // data: [tagTable]
                    stagedSnapshot.setTagTable(Utilities.parseJson(message.data, "tagTable", []));
                    break;

                case webSocketReceiveMessage.verify_rules_msg:
                    // VERIFY_RULES commits even an empty project. Skipping an
                    // empty snapshot would retain stale violations and leave the
                    // loading indicator running forever.
                    const snapshot = stagedSnapshot.snapshot();
                    xmlData = snapshot.xmlFiles;
                    tagTable = snapshot.tagTable;
                    ruleTable = checkRulesForAll(xmlData, snapshot.ruleTable);
                    committedXml.replaceXmlFiles(xmlData);
                    this.props.onCommitRuleSnapshot(xmlData, tagTable, ruleTable);

                    // New extension versions attach the initiating reason here.
                    // A refresh remains on the current page; a source edit keeps
                    // the established code-changed UX without an incremental
                    // rule evaluation.
                    if (message.data && typeof message.data === "object" &&
                        message.data.reason === "code_change" && message.data.filePath) {
                        this.props.onFilePathChange(message.data.filePath);
                        window.location.hash = `#/${hashConst.codeChanged}`;
                    }
                    break;

                case webSocketReceiveMessage.update_xml_file_msg:
                    // Compatibility with older extension builds. Stage this
                    // delta privately; CHECK_RULES_FOR_FILE below converts it
                    // into the same full, atomic evaluation used by refreshes.
                    if (message.data && message.data["xml"] === "")
                        committedXml.deleteXml(message.data["filePath"]);
                    else
                        committedXml.upsertXml(message.data);
                    xmlData = committedXml.snapshot().xmlFiles;
                    break;

                case webSocketReceiveMessage.check_rules_for_file_msg:
                    // Legacy protocol fallback: deliberately run every rule.
                    // Cross-file rules cannot be evaluated consistently from a
                    // single target file.
                    let filePath = message.data;
                    ruleTable = checkRulesForAll(xmlData, ruleTable);
                    this.props.onFilePathChange(filePath);
                    this.props.onCommitRuleSnapshot(xmlData, tagTable, ruleTable);
                    window.location.hash = `#/${hashConst.codeChanged}`;
                    break;

                case webSocketReceiveMessage.update_tag_msg:
                    // data: {tagID: longNumber, tagInfo: {...}}
                    let newTag = message.data["tagInfo"];
                    let filteredTag = tagTable.filter((d) => d.tagName === newTag["tagName"]);
                    if (filteredTag.length === 0)
                        tagTable.push(newTag);
                    else
                        tagTable.filter((d) => d.tagName === newTag["tagName"])[0].detail = newTag["detail"];
                    window.location.hash = `#/${hashConst.tag}/` + data["tagID"];

                    break;
                case webSocketReceiveMessage.failed_update_tag_msg:
                    // data: {tagID: longNumber, tagInfo: {...}}
                    break;

                case webSocketReceiveMessage.update_rule_msg:
                    // data: {ruleID: longNumber, ruleInfo: {...}}
                    let updatedRule = message.data["ruleInfo"];
                    try {
                        let ruleIndex = -1;
                        ruleTable.forEach((d, i) => +d.index === +updatedRule.index ? ruleIndex = i : "");
                        ruleTable[ruleIndex] = runRulesByTypes(xmlData, updatedRule);
                        this.props.onUpdateRuleTable(ruleTable);
                    } catch (e) {
                        console.log(e);
                    }
                    break;

                case webSocketReceiveMessage.failed_update_rule_msg:
                    // data: {ruleID: longNumber, ruleInfo: {...}}
                    break;

                case webSocketReceiveMessage.xml_from_code_msg:
                    // data: {xmlText: "", messageID: ""}
                    this.props.onReceiveExprStmtXML(message.data);
                    break;

                case webSocketReceiveMessage.new_rule_msg:
                    // data: {ruleID: longNumber, ruleInfo: {...}}
                    let newAddedRule = message.data["ruleInfo"];
                    ruleTable.push(newAddedRule);
                    // received by RuleExecutor
                    ruleTable[ruleTable.length - 1] = runRulesByTypes(xmlData, newAddedRule);
                    this.props.onUpdateRuleTable(ruleTable);
                    break;

                case webSocketReceiveMessage.failed_new_rule_msg:
                    // data: {ruleID: longNumber, rule: {...}}
                    break;

                case webSocketReceiveMessage.new_tag_msg:
                    // data: {tagID: longNumber, tagInfo: {...}}
                    tagTable.push(message.data["tagInfo"]);
                    this.props.onUpdateTagTable(tagTable);
                    break;

                case webSocketReceiveMessage.failed_new_tag_msg:
                    // data: {tagID: longNumber, tag: {...}}
                    break;

                case webSocketReceiveMessage.file_change_in_ide_msg:
                    // data: "filePath"
            
                    let focusedFilePath = message.data;
                    console.log("File name: ");
                    console.log(focusedFilePath);
                    focusedFilePath = String(focusedFilePath);
                    
                    if(!focusedFilePath.includes("edit_fix_window")){
                        if (!this.props.ignoreFileChange) {
                            this.props.onFilePathChange(focusedFilePath);
                            window.location.hash = `#/${hashConst.rulesForFile}/` + focusedFilePath.replace(/\//g, "%2F");
                        } else {
                            counter--;
                            if (counter === 0) {
                                this.props.onFalsifyIgnoreFile();
                                counter = 3;
                            }
                        }                        
                    }

                    break;

                /* Mining Rules */

                case webSocketReceiveMessage.element_info_for_mine_rules:
                    window.location.hash = `#/${hashConst.learnDesignRules}/`;
                    let focusedElementFile = xmlData.filter(d => d.filePath === message.data["filePath"]);
                    if (focusedElementFile.length > 0) {
                        let focusedElementData = getDataForFocusedElement(
                            focusedElementFile[0], message.data["startOffset"]);
                        focusedElementData.filePath = message.data["filePath"].replace(projectPath, "");
                        this.props.onUpdateFocusedElementData(focusedElementData);
                    }
                    break;

                case webSocketReceiveMessage.doi_information:
                    // "recentVisitedFiles", "recentSearches", "recentVisitedElements"
                    let recentVisitedFiles = Utilities.parseJson(message.data["recentVisitedFiles"],
                        "recentVisitedFiles", []);
                    let recentSearchKeywords = Utilities.parseJson(message.data["recentSearches"],
                        "recentSearches", []);
                    let recentVisitedElements = Utilities.parseJson(message.data["recentVisitedElements"],
                        "recentVisitedElements", []);
                    let newDoiInformation = processDoiInformation(recentVisitedFiles, recentSearchKeywords,
                        recentVisitedElements, xmlData, this.props.projectPath);
                    this.props.onUpdateDoiInformation(newDoiInformation);

                    break;

                case webSocketReceiveMessage.request_mine_rules_for_element:
                    window.location.hash = `#/${hashConst.learnDesignRules}/`;
                    this.props.onRequestMineRulesForElement();
                    break;

                case webSocketReceiveMessage.mined_design_rules:
                    // "minedFrequentItemSets", "algorithm"
                    let output = message.data["minedFrequentItemSets"];
                    let algorithm = message.data["algorithm"];
                    processReceivedFrequentItemSets(output, algorithm, this.props.featureMetaData)
                        .then(processedRules => {
                            this.props.onUpdateMinedRules(processedRules);
                        }).catch(e => console.log("error happened in promise", e));
                    break;

                default:
            }
        };
    }

    render() {
        return null;
    }

    componentWillUnmount() {
        const ws = this.ws;
        this.ws = null;
        if (!ws) return;

        // Detach callbacks first so a late close/message from this obsolete
        // component cannot mutate the replacement connection's UI state.
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        if (ws.readyState === 0 || ws.readyState === 1)
            ws.close(1000, "WebSocketManager unmounted");
        this.props.onUpdateWS(null);
        this.props.onLoadingGif(false);
    }

}


// map state to props
function mapStateToProps(state) {
    return {
        ignoreFileChange: state.ignoreFileChange,
        projectPath: state.projectPath,
        featureMetaData: state.minedRulesState.featureMetaData
    };
}

function mapDispatchToProps(dispatch) {
    return {
        onLoadingGif: (status) => dispatch(updateLoadingGif(status)),
        onUpdateWS: (ws) => dispatch(updateWS(ws)),
        onProjectHierarchy: (hierarchyData) => dispatch(updateProjectHierarchyData(hierarchyData)),
        onProjectPathUpdate: (projectPath) => dispatch(updateProjectPath(projectPath)),
        onUpdateRuleTable: (ruleTable) => dispatch(updateRuleTable(ruleTable)),
        onUpdateTagTable: (tagTable) => dispatch(updateTagTable(tagTable)),
        onCommitRuleSnapshot: (xmlFiles, tagTable, ruleTable) =>
            dispatch(commitRuleSnapshot(xmlFiles, tagTable, ruleTable)),
        onFilePathChange: (filePath) => dispatch(updateFilePath(filePath)),
        onFalsifyIgnoreFile: () => dispatch(ignoreFileChange(false)),
        onReceiveExprStmtXML: (data) => dispatch(receiveExpressionStatementXML(data)),
        onUpdateFocusedElementData: (focusedElementData) => dispatch(updateFocusedElementData(focusedElementData)),
        onUpdateDoiInformation: (doiInformation) => dispatch(updateDoiInformation(doiInformation)),
        onRequestMineRulesForElement: () => dispatch(requestMineRulesForElement()),
        onUpdateMinedRules: (modifiedOutput) => dispatch(updatedMinedRules(modifiedOutput)),
    }
}

/**
 * Factory method to create a new WebSocketManager instance
 * @returns {WebSocketManager}
 */
export default connect(mapStateToProps, mapDispatchToProps)(WebSocketManager);
