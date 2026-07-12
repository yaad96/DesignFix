/**
 * Created by saharmehrpour on 9/6/17.
 */

import React, { Component, Fragment } from "react";
import { connect } from "react-redux";

import "../index.css";
import "../App.css";
import {
    Tab, Tabs, Badge, FormGroup, ControlLabel, Label, Collapse, Button
} from "react-bootstrap";
import { FaCaretDown, FaCaretUp } from "react-icons/fa";
import { MdEdit } from "react-icons/md";

import { changeEditMode, ignoreFileChange } from "../actions";
import Utilities from "../core/utilities";
import RulePad from "./RulePad/rulePad";
import { reduxStoreMessages } from "../reduxStoreConstants";
import { webSocketSendMessage } from "../core/coreConstants";
import { relatives } from "../core/ruleExecutorConstants";
import { hashConst, none_filePath } from "./uiConstants";

import { suggestFix} from "../activeLLM/suggestFix";
import Prism from 'prismjs';
import '../../src/prism-vs.css'; // Choose any theme you like

// Import the language syntax for Java
import 'prismjs/components/prism-java';

import WebSocketManager from "../core/webSocketManager";

class RulePanel extends Component {

    constructor(props) {
        super(props);
        this.ruleIndex = props.ruleIndex !== undefined ? props.ruleIndex : -1;
        /**
         * @type {null|{index:number, title:string, description:string, tags:[], grammar:string,
         * checkForFilesFolders:[string], checkForFilesFoldersConstraints:"INCLUDE"|"EXCLUDE"|"NONE",
         * processFilesFolders:"WITHIN",
         * quantifierXPathQuery:[], constraintXPathQuery:[], quantifierQueryType:string, constraintQueryType:string,
         * rulePanelState:{editMode:boolean, title:string, description:string, ruleTags:[], folderConstraint:string,
         * filesFolders:[],
         * constraintXPath:string, quantifierXPath:string, autoCompleteArray:[],
         * graphicalEditorState:{guiTree:{}, guiElements:{}, ruleType:string}},
         * xPathQueryResult:[{
         * data:{quantifierResult:[{filePath:string,snippet:string,xml:{fileName:string,
         * xml:string}}],
         * satisfied:number, satisfiedResult:[], violated:number, violatedResult:[]
         * changed:boolean,violatedChanged:string,satisfiedChanged:string,allChanged:string},
         * filePath:string
         * }]}}
         */
        this.ruleI = null;
        this.newRuleRequest = this.ruleIndex === -1;

        this.state = {
            openPanel: true,
            className: "rulePanelDiv" + (this.newRuleRequest ? " edit-bg" : ""),
            activeTab: 0,

            editMode: this.newRuleRequest,

            title: "",
            description: "",
            ruleTags: [],
            folderConstraint: "",
            filesFolders: [],
            tags: [],

            filePath: none_filePath
        };

        // existing rule
        if (!this.newRuleRequest && this.ruleIndex !== -1) {
            let indices = props.rules.map(d => d.index);
            let arrayIndex = indices.indexOf(this.ruleIndex);
            if (arrayIndex === -1)
                console.log(`error: rule with index ${this.ruleIndex} is not found in the ruleTable.
                Only ${indices.toString()} are found as indices.`);
            else {
                this.ruleI = props.rules[arrayIndex];
                this.state.title = this.ruleI.title;
                this.state.description = this.ruleI.description;
                this.state.ruleTags = this.ruleI.tags;
                this.state.folderConstraint = this.ruleI.checkForFilesFoldersConstraints;
                this.state.filesFolders = this.ruleI.checkForFilesFolders;
                this.state.tagTable = props.tagTable;

                this.state.editMode = this.ruleI.rulePanelState.editMode;
            }
        }

        this.caretClass = {
            true: { cursor: "pointer", color: "black" },
            false: { cursor: "pointer", color: "darkgrey" }
        };

        this.editIconClass = {
            true: { color: "#337ab7", cursor: "pointer" },
            false: { color: "black", cursor: "pointer" }
        };
    }

    render() {
        if (!this.ruleI && !this.state.editMode) return null;
        if (this.state.editMode)
            return (
                <RulePad ruleIndex={this.ruleIndex}
                    changeEditMode={() => this.changeEditMode()} />);
        return (
            <div className={this.state.className}>
                <FormGroup>
                    <div style={{ float: "right" }}>
                        <FaCaretUp size={20} onClick={() => this.setState({ openPanel: false })}
                            style={this.caretClass[this.state.openPanel.toString()]}
                            className={"react-icons"} />
                        <FaCaretDown size={20} onClick={() => this.setState({ openPanel: true })}
                            style={this.caretClass[(!this.state.openPanel).toString()]}
                            className={"react-icons"} />
                        <MdEdit size={20} style={this.editIconClass[this.state.editMode.toString()]}
                            onClick={() => this.changeEditMode()}
                            className={"react-icons"} />
                    </div>
                    <ControlLabel>{this.state.title}</ControlLabel>
                    <p>{this.state.description}</p>
                </FormGroup>
                <Collapse in={this.state.openPanel}>
                    <div>
                        <div style={{ paddingTop: "10px", clear: "both" }}>
                            {this.renderTags()}
                        </div>
                        <div style={{ paddingTop: "10px", clear: "both" }}>
                            <Tabs animation={true} id={"rules_" + this.ruleIndex}
                                activeKey={this.state.activeTab}
                                onSelect={(key) => {
                                    if (this.state.activeTab === key)
                                        this.setState({ activeTab: 0 });
                                    else
                                        this.setState({ activeTab: key });
                                }}>
                                <Tab eventKey={0} disabled>{ }</Tab>
                                <Tab eventKey={"satisfied"}
                                    title={this.renderTabHeader("satisfied")}>{this.renderListOfSnippets("satisfied")}</Tab>
                                <Tab eventKey={"violated"}
                                    title={this.renderTabHeader("violated")}>{this.renderListOfSnippets("violated")}</Tab>
                            </Tabs>
                        </div>
                    </div>
                </Collapse>
            </div>
        );
    }

    UNSAFE_componentWillReceiveProps(nextProps) {
        let newState = {};
        this.ruleIndex = nextProps.ruleIndex !== undefined ? nextProps.ruleIndex : -1;
        let arrayIndex = nextProps.rules.map(d => d.index).indexOf(this.ruleIndex);
        if (this.ruleIndex >= 0) {
            if (arrayIndex === -1)
                console.log(`error: rule with index ${this.ruleIndex} is not found in the ruleTable.
                Only ${nextProps.rules.map(d => d.index).toString()} are found as indices.`);
            else {
                this.ruleI = nextProps.rules[arrayIndex];
                newState = {
                    title: this.ruleI.title,
                    description: this.ruleI.description,
                    ruleTags: this.ruleI.tags,
                    folderConstraint: this.ruleI.checkForFilesFoldersConstraints,
                    filesFolders: this.ruleI.checkForFilesFolders,
                    editMode: false
                };
            }
        }

        if (nextProps.message === reduxStoreMessages.hash_msg) {
            let panelState = this.newUpdateStateUponCodeChange(nextProps.codeChanged, nextProps.filePath);
            this.setState({ ...panelState, ...newState, filePath: nextProps.filePath });
        }

        else if (nextProps.message === reduxStoreMessages.file_path_update_msg)
            this.setState({ ...newState, filePath: nextProps.filePath });

        else if (nextProps.message === reduxStoreMessages.change_edit_mode_msg) {
            let indices = nextProps.rules.map(d => d.index);
            let arrayIndex = indices.indexOf(this.ruleIndex);
            if (this.ruleIndex !== -1) {
                if (arrayIndex === -1)
                    console.log(`error: rule with index ${this.ruleIndex} is not found in the ruleTable.
                Only ${indices.toString()} are found as indices.`);
                else {
                    this.ruleI = nextProps.rules[arrayIndex];
                    newState.editMode = this.ruleI.rulePanelState.editMode;
                    this.setState({ ...newState, filePath: nextProps.filePath });
                }
            }
        }

        // existing rule
        else if (nextProps.message === reduxStoreMessages.update_rule_table_msg && this.ruleIndex !== -1) {
            if (arrayIndex !== -1) {
                if (this.ruleI.rulePanelState.editMode && !this.state.editMode) {
                    newState.editMode = true;
                    this.setState({ ...newState, filePath: nextProps.filePath });
                }

                else {
                    let panelState = this.newUpdateStateUponCodeChange(nextProps.codeChanged, nextProps.filePath);
                    this.setState({ ...newState, ...panelState, filePath: nextProps.filePath });
                }
            }
        }
    }

    /**
     * set the states "openPanel" and "className" after mounting.
     */
    componentDidMount() {
        let panelState = this.newUpdateStateUponCodeChange(this.props.codeChanged, this.state.filePath);
        this.setState(panelState);
    }

    /**
     * render the tab headers
     * @param group
     */
    renderTabHeader(group) {
        // sum up the number of satisfied and violated
        let totalSatisfied = 0, totalViolated = 0;
        for (let i = 0; i < this.ruleI.xPathQueryResult.length; i++) {
            totalSatisfied += this.ruleI.xPathQueryResult[i].data.satisfied;
            totalViolated += this.ruleI.xPathQueryResult[i].data.violated
        }

        let fileSatisfied = 0, fileViolated = 0;
        let file = this.ruleI.xPathQueryResult.filter(d => d.filePath === this.state.filePath);
        if (file.length > 0) {
            fileSatisfied = file[0].data.satisfied;
            fileViolated = file[0].data.violated;
        }

        switch (group) {
            case "all":
                return (
                    <span className="rulePanelGeneralTab">Matches
                        {this.state.filePath !== none_filePath ? (
                            <Fragment>
                                <Badge className="forAll">{fileSatisfied + fileViolated}</Badge>
                                <span style={{ color: "#777" }}>out of</span>
                                <Badge className="forAll">{totalSatisfied + totalViolated}</Badge>
                            </Fragment>
                        ) : (
                            <Badge className="forAll">{totalSatisfied + totalViolated}</Badge>
                        )}
                        <Badge className="forFile hidden">{ }</Badge>
                    </span>);
            case "satisfied":
                return (
                    <span className="rulePanelSatisfiedTab">Examples
                        {this.state.filePath !== none_filePath ? (
                            <Fragment>
                                <Badge className="forAll">{fileSatisfied}</Badge>
                                <span style={{ color: "#777" }}>out of</span>
                                <Badge className="forAll">{totalSatisfied}</Badge>
                            </Fragment>
                        ) : (
                            <Badge className="forAll">{totalSatisfied}</Badge>
                        )}
                        <Badge className="forFile hidden">{ }</Badge>
                    </span>);
            case "violated":
                return (
                    <span className="rulePanelViolatedTab">Violated
                        {this.state.filePath !== none_filePath ? (
                            <Fragment>
                                <Badge className="forAll">{fileViolated}</Badge>
                                <span style={{ color: "#777" }}>out of</span>
                                <Badge className="forAll">{totalViolated}</Badge>
                            </Fragment>
                        ) : (
                            <Badge className="forAll">{totalViolated}</Badge>
                        )}
                        <Badge className="forFile hidden">{ }</Badge>
                    </span>);
            default:
                break;
        }
    }

    /**
     * render tag badges
     */
    renderTags() {
        return (this.ruleI.tags).map((d, i) => {
            let tagFilter = this.state.tagTable.filter((tt) => tt.tagName === d);
            if (tagFilter.length !== 1) {
                return (
                    <div className="buttonDiv" key={i}>
                        <Label>{d}</Label>
                    </div>)
            }
            return (
                <div className="buttonDiv" key={i}>
                    <Label onClick={() => window.location.hash = `#/${hashConst.tag}/${tagFilter[0].ID}`}>{d}</Label>
                </div>)
        });
    }

    /**
     * create a list div node for quantifier and satisfied result and wrap them in a div
     * @param group {string}
     */
    renderListOfSnippets(group) {

        let otherFilesList = [], fileList = [];
        let file = this.ruleI.xPathQueryResult.filter(d => d.filePath === this.state.filePath);

        let exampleSnippet = null;
        let exampleFoundInOpenFile = false;
        let exampleFilePath = null;

        switch (group) {
            case "all":
                if (this.state.filePath !== none_filePath) {
                    if (file.length > 0)
                        fileList = file[0].data.quantifierResult;
                }
                for (let i = 0; i < this.ruleI.xPathQueryResult.length; i++) {
                    if (this.ruleI.xPathQueryResult[i].filePath === this.state.filePath) continue;
                    otherFilesList = otherFilesList.concat(this.ruleI.xPathQueryResult[i].data.quantifierResult)
                }
                break;
            case "satisfied":
                if (this.state.filePath !== none_filePath) {
                    if (file.length > 0)
                        fileList = file[0].data.satisfiedResult;
                }
                for (let i = 0; i < this.ruleI.xPathQueryResult.length; i++) {
                    if (this.ruleI.xPathQueryResult[i].filePath === this.state.filePath) continue;
                    otherFilesList = otherFilesList.concat(this.ruleI.xPathQueryResult[i].data.satisfiedResult)
                }
                break;
            case "violated":
                if (this.state.filePath !== none_filePath) {
                    if (file.length > 0)
                        fileList = file[0].data.violatedResult;
                }
                for (let i = 0; i < this.ruleI.xPathQueryResult.length; i++) {
                    // NOTE: added example snippet
                    if (
                        exampleSnippet == null &&
                        this.ruleI.xPathQueryResult[i].data.satisfiedResult.length > 0
                    ) {
                        try {
                            exampleSnippet =
                                this.ruleI.xPathQueryResult[i].data.satisfiedResult[0]
                                    .surroundingNodes;
                            exampleFilePath = this.ruleI.xPathQueryResult[i].filePath;
                        } catch (e) {
                            console.log(e);
                        }
                    }
                    if (this.ruleI.xPathQueryResult[i].filePath === this.state.filePath) {
                        // NOTE: added example snippet
                        if (
                            (exampleSnippet == null || !exampleFoundInOpenFile) &&
                            this.ruleI.xPathQueryResult[i].data.satisfiedResult.length > 0
                        ) {
                            try {
                                exampleSnippet =
                                    this.ruleI.xPathQueryResult[i].data.satisfiedResult[0]
                                        .surroundingNodes;
                                exampleFoundInOpenFile = true;
                                exampleFilePath = this.ruleI.xPathQueryResult[i].filePath;
                            } catch (e) {
                                console.log(e);
                            }
                            continue;
                        }
                    }
                    otherFilesList = otherFilesList.concat(
                        this.ruleI.xPathQueryResult[i].data.violatedResult,
                    );
                }
                break;
            default:
                break;
        }

        let returnList = (list) => {
            if (list.length === 0)
                return (<h5>No snippet</h5>);
            return list.map((d, i) => {
                return (
                    <SnippetView
                        xmlFiles={this.props.xmlFiles}
                        key={i}
                        d={d}
                        rule={this.ruleI}
                        snippetGroup={group}
                        exampleSnippet={exampleSnippet}
                        exampleFilePath={exampleFilePath}
                        description={this.state.description}
                        ws={this.props.ws}
                        onIgnoreFile={this.props.onIgnoreFile}
                    />
                );
            });
        };

        let headerText = group === "all" ? "Matches" : group === "satisfied" ?
            "Example Snippet" : "Violated snippet";

        return (
            <div>
                {this.state.filePath !== none_filePath ? (
                    <Fragment>
                        <h4>{headerText + " for this file"}</h4>
                        <div>{returnList(fileList)}</div>
                        <h4>{headerText + " for other files"}</h4>
                    </Fragment>
                ) : null}
                <div>{returnList(otherFilesList)}</div>
            </div>
        )
    }


    /**
     * compute the className and state of the panel after the code is changed
     * @param codeChanged
     * @param filePath path of the open file
     * @returns {*}
     */
    newUpdateStateUponCodeChange(codeChanged, filePath) {
        if (!codeChanged) {
            let open;
            if (filePath === none_filePath)
                open = true;
            else
                open = this.ruleI.xPathQueryResult.filter(d => d.filePath === filePath).length > 0;
            return {
                className: "rulePanelDiv" + (this.newRuleRequest ? " edit-bg" : ""),
                openPanel: open
            };
        }

        let file = this.ruleI.xPathQueryResult.filter(d => d.filePath === filePath);
        let ruleIFile = file.length !== 0 ? file[0].data : {};
        if (ruleIFile.allChanged === relatives.greater && ruleIFile.satisfiedChanged === relatives.none
            && ruleIFile.violatedChanged === relatives.none) {
            return { openPanel: true, className: "rulePanelDiv blue-bg" };
        }
        if (ruleIFile.satisfiedChanged === relatives.greater)
            return { openPanel: true, className: "rulePanelDiv green-bg" };

        if (ruleIFile.violatedChanged === relatives.greater)
            return { openPanel: true, className: "rulePanelDiv red-bg" };

        if (file.length > 0)
            return { openPanel: true, className: "rulePanelDiv" };

        if (ruleIFile.violated === 0)
            return { openPanel: false, className: "rulePanelDiv" };

        return { openPanel: false, className: "rulePanelDiv" };
    }

    /**
     * change edit mode, set the states
     */
    changeEditMode() {
        this.props.onChangeEditMode(this.ruleIndex, !this.state.editMode)
    }
}

// map state to props
function mapStateToProps(state) {
    return {
        xmlFiles: state.xmlFiles,
        rules: state.ruleTable,
        tagTable: state.tagTable,
        codeChanged: state.currentHash[0] === hashConst.codeChanged,
        filePath: [hashConst.rulesForFile, hashConst.codeChanged].indexOf(state.currentHash[0]) !== -1 ?
            (state.openFilePath) : none_filePath,
        ws: state.ws,
        message: state.message
    };
}

function mapDispatchToProps(dispatch) {
    return {
        onIgnoreFile: (shouldIgnore) => dispatch(ignoreFileChange(shouldIgnore)),
        onChangeEditMode: (ruleIndex, newEditMode) => dispatch(changeEditMode(ruleIndex, newEditMode))
    }
}

export default connect(mapStateToProps, mapDispatchToProps)(RulePanel);


class SnippetView extends Component {
    constructor(props) {
        super(props);
        this.state = {
            snippetGroup: props.snippetGroup,
            d: props.d,
            description: props.description,
            exampleSnippet: props.exampleSnippet,
            exampleFilePath: props.exampleFilePath,
            suggestedSnippet: null,
            suggestionCreated: false,
            snippetExplanation: null,
            suggestionFileName: null,
            llmModifiedFileContent: null,
            suggestedEdits: null,
            fixButtonClicked: false,
            originalFileContent: ''
        };
        //this.onReceiveEditFixContent = this.onReceiveEditFixContent.bind(this);
    }

    saveConversationToSessionStorage = (key, conversationHistory) => {
        sessionStorage.setItem(key, JSON.stringify(conversationHistory));
    }

    getConversationFromSessionStorage = (key) => {
        const history = sessionStorage.getItem(key);
        return history ? JSON.parse(history) : [];
    }

    clearConversationFromSessionStorage = (key) => {
        sessionStorage.removeItem(key);
    }

    /**
     * Gather files (other than the violation file) that provide the context
     * needed to fix a (possibly cross-file) rule. Ordered by signal strength:
     *   1. Satisfying-example files  — files that already PASS this rule, i.e.
     *      the correct pattern shown in real, compilable context (from the
     *      rule's xPathQueryResult[].data.satisfiedResult).
     *   2. Constraint-named classes  — classes named in the constraint XPath
     *      (e.g. a central registry/servlet the fix must edit).
     *   3. Scoped folder files       — other files under the rule's checked
     *      folders, as a last resort.
     * Returns [{ filePath, content, reason }], de-duped and capped.
     */
    gatherFixSiteFiles = (rule, violationFilePath) => {
        const xmlFiles = this.props.xmlFiles || [];
        if (!rule || xmlFiles.length === 0) return [];

        const MAX_FILES = 4; // hard cap to protect the token budget
        const normalizePath = (p) => (p || '').replace(/\\/g, '/');
        const violationNorm = normalizePath(violationFilePath);

        const picked = new Map(); // normalizedPath -> { filePath, content, reason }

        const findByPath = (targetPath) => {
            const norm = normalizePath(targetPath);
            let match = xmlFiles.find((f) => normalizePath(f.filePath) === norm);
            if (match) return match;
            const base = norm.split('/').pop();
            return xmlFiles.find((f) => normalizePath(f.filePath).endsWith(`/${base}`));
        };

        const addFile = (file, reason) => {
            if (!file) return false;
            if (picked.size >= MAX_FILES) return false;
            const norm = normalizePath(file.filePath);
            if (norm === violationNorm) return false;
            if (picked.has(norm)) return false;
            picked.set(norm, {
                filePath: file.filePath,
                content: Utilities.removeSrcmlAnnotations(file.xml),
                reason,
            });
            return true;
        };

        // 1) Class names referenced by the constraint XPath (excluding <TEMP>).
        //    For cross-file rules the constraint names the file where the fix
        //    actually belongs (e.g. the central CrowdServlet registry), so this
        //    is the HIGHEST-priority signal and must be gathered first — before
        //    the cap can be consumed by lower-value example files.
        const constraintXPath = Array.isArray(rule.constraintXPathQuery)
            ? rule.constraintXPathQuery.join(' ')
            : (rule.constraintXPathQuery || '');
        const classNames = new Set();
        const re = /text\(\)\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
        let m;
        while ((m = re.exec(constraintXPath)) !== null) {
            const name = m[1];
            if (name && name !== '<TEMP>') classNames.add(name);
        }
        classNames.forEach((name) => {
            const wanted = `${name.toLowerCase()}.java`;
            const match = xmlFiles.find((f) => normalizePath(f.filePath).split('/').pop().toLowerCase() === wanted);
            addFile(match, `named in the rule constraint (${name}) - likely fix site`);
        });

        // 2) Satisfying-example files: files that already PASS this rule, shown as
        //    the correct pattern in real context. Secondary to the fix site, and
        //    limited so they cannot crowd out more important files.
        const results = Array.isArray(rule.xPathQueryResult) ? rule.xPathQueryResult : [];
        let exampleCount = 0;
        const MAX_EXAMPLES = 2;
        for (const entry of results) {
            if (exampleCount >= MAX_EXAMPLES || picked.size >= MAX_FILES) break;
            const data = entry && entry.data;
            if (!data || !Array.isArray(data.satisfiedResult) || data.satisfiedResult.length === 0) continue;
            if (normalizePath(entry.filePath) === violationNorm) continue;
            if (addFile(findByPath(entry.filePath), 'satisfies this rule (correct example)')) exampleCount++;
        }

        // 3) Files under the rule's checked folders that are NOT in the violation
        //    file's own folder. Last-resort scope fill, tightly capped.
        const folders = Array.isArray(rule.checkForFilesFolders) ? rule.checkForFilesFolders : [];
        const violationFolder = violationNorm.substring(0, violationNorm.lastIndexOf('/'));
        const MAX_FOLDER_FILES = 2;
        for (const folder of folders) {
            if (picked.size >= MAX_FILES) break;
            const f = normalizePath(folder);
            if (!f || violationFolder.indexOf(f) !== -1) continue; // skip the violation's own folder
            let count = 0;
            for (const file of xmlFiles) {
                if (count >= MAX_FOLDER_FILES || picked.size >= MAX_FILES) break;
                if (normalizePath(file.filePath).indexOf(f) !== -1) {
                    if (addFile(file, 'in the rule scope')) count++;
                }
            }
        }

        return Array.from(picked.values());
    }

    handleSuggestion = async (
        rule,
        example,
        snippet,
        surroundingCode,
        exampleFilePath,
        violationFilePath,
        key
    ) => {
        const parsedSnippet = Utilities.removeSrcmlAnnotations(snippet);
        const parsedExample = Utilities.removeSrcmlAnnotations(example);
        const parsedSurroundingCode = Utilities.removeSrcmlAnnotations(surroundingCode);

        const normalizePath = (filePath) => filePath.replace(/\\/g, '/');
        const targetPath = normalizePath(violationFilePath);
        let violationFileContent = '';
        if (this.props.xmlFiles && this.props.xmlFiles.length > 0) {
            const matchingFile = this.props.xmlFiles.find((file) => normalizePath(file.filePath) === targetPath);
            if (matchingFile) {
                violationFileContent = Utilities.removeSrcmlAnnotations(matchingFile.xml);
            } else {
                const targetFileName = targetPath.split('/').pop();
                const fallbackMatch = this.props.xmlFiles.find((file) => normalizePath(file.filePath).endsWith(`/${targetFileName}`));
                if (fallbackMatch) {
                    violationFileContent = Utilities.removeSrcmlAnnotations(fallbackMatch.xml);
                }
            }
        }

        // Resolve candidate fix-site files (cross-file rules) from rule metadata.
        const fixSiteFiles = this.gatherFixSiteFiles(this.props.rule, violationFilePath);

        this.setState({ fixButtonClicked: true, originalFileContent: violationFileContent });

        // prevent multiple calls to suggestFix
        if (!this.state.suggestionCreated) {
            const conversationHistory = await suggestFix(
                rule,
                parsedExample,
                parsedSnippet,
                parsedSurroundingCode,
                exampleFilePath,
                violationFilePath,
                violationFileContent,
                fixSiteFiles,
                this.setState.bind(this),
            );

            this.saveConversationToSessionStorage(key, conversationHistory);

            // notify the component that this snippet now has a suggested fix
            this.setState({ suggestionCreated: true });
        }
    };



    handleEditFix = async (suggestionFileName, uniqueKey) => {

        const convHistory = this.getConversationFromSessionStorage(uniqueKey);
        //console.log("convHistory");
        //console.log(convHistory);


        const xmlFiles = this.props.xmlFiles;



        // Function to extract the file name from the filePath
        const extractFileName = (filePath) => {
            const parts = filePath.split('/');
            return parts[parts.length - 1];
        };

        // Iterate over xmlFiles to find the matching file
        const matchingFile = xmlFiles.find(file => extractFileName(file.filePath) === suggestionFileName);
        let codeOfSuggestionFile = '';

        if (matchingFile) {
            console.log("Found matching file:");
            //console.log(matchingFile.xml);
            codeOfSuggestionFile = Utilities.removeSrcmlAnnotations(matchingFile.xml);
            // Do something with the matchingFile.xml here

            //console.log("before getting into normalizeFunction");
            //console.log(codeOfSuggestionFile);

            //console.log("after normalizeFunction");
            //console.log(codeOfSuggestionFile);
        } else {
            console.log("No matching file found");
        }
        //console.log("Matching file content");
        //console.log(codeOfSuggestionFile);
        const originalCode = Utilities.removeSrcmlAnnotations(this.state.d.surroundingNodes);
        const modifiedCode = convHistory.data.modifiedFileContent;
        const diff = this.generateDiff(originalCode, modifiedCode);
        //console.log("THE DIFF");
        //console.log(diff);



        // Define the processDiff function inside handleEditFix
        const processDiff = (diffArray) => {
            return diffArray.map(diff => {
                let message = '';
                if (diff.type === 'added') {
                    message = 'This line was added by you as part of solution: ';
                } else if (diff.type === 'removed') {
                    message = 'This line was removed by you as part of solution: ';
                }
                return message + diff.text;
            });
        };

        const processedDiff = processDiff(diff);

        // Join all the elements into a single string with each element on a separate line
        const resultText = processedDiff.join('\n');

        console.log(resultText);

        const response = await editFix(codeOfSuggestionFile, resultText, this.setState.bind(this));
    }

    generateDiff = (originalCode, modifiedCode) => {
        const normalizeForComparison = (line) => line.replace(/^\s+/, '').replace(/\s+$/, '');
        const originalLines = originalCode.split('\n');
        const modifiedLines = modifiedCode.split('\n');

        const originalCounts = new Map();
        originalLines.forEach((line) => {
            const key = normalizeForComparison(line);
            originalCounts.set(key, (originalCounts.get(key) || 0) + 1);
        });

        const remainingOriginalCounts = new Map(originalCounts);
        const diff = [];

        modifiedLines.forEach((line) => {
            const key = normalizeForComparison(line);
            const remaining = remainingOriginalCounts.get(key) || 0;
            if (remaining > 0) {
                remainingOriginalCounts.set(key, remaining - 1);
            } else {
                diff.push({ type: 'added', text: line });
            }
        });

        originalLines.forEach((line) => {
            const key = normalizeForComparison(line);
            const remaining = remainingOriginalCounts.get(key) || 0;
            if (remaining > 0) {
                diff.push({ type: 'removed', text: line });
                remainingOriginalCounts.set(key, remaining - 1);
            }
        });

        console.log('DIFF');
        console.log(diff);

        return diff;
    };

    renderDiff = () => {
        const highlightCode = (code) => {
            return Prism.highlight(code, Prism.languages.java, 'java');
        };

        const renderDiffLines = (diff) => (
            <div className="diff-container" style={{ fontFamily: 'monospace', whiteSpace: 'pre', border: '1px solid #d6d6d6', borderRadius: '7px', padding: '1px' }}>
                {diff.map((line, index) => (
                    <div
                        key={index}
                        style={{
                            backgroundColor: 'white'
                        }}
                    >
                        <span style={{ color: line.type === 'added' ? 'green' : 'red' }}>
                            {line.type === 'added' ? '+' : '-'}
                        </span>
                        <span dangerouslySetInnerHTML={{ __html: highlightCode(line.text) }}></span>
                    </div>
                ))}
            </div>
        );

        // Multi-file fix: render one diff block per changed file.
        const edits = this.state.suggestedEdits;
        if (Array.isArray(edits) && edits.length > 0) {
            const fileName = (fp) => (fp || '').replace(/\\/g, '/').split('/').pop();
            return (
                <div>
                    {edits.map((edit, i) => {
                        const diff = this.generateDiff(edit.originalFileContent || '', edit.modifiedFileContent || '');
                        return (
                            <div key={i} style={{ marginBottom: '8px' }}>
                                <p style={{ fontWeight: 'bold', margin: '4px 0' }}>{fileName(edit.filePath)}</p>
                                {renderDiffLines(diff)}
                            </div>
                        );
                    })}
                </div>
            );
        }

        // Legacy single-file fix.
        const originalCode = this.state.originalFileContent;
        const modifiedCode = this.state.suggestedSnippet || '';
        const diff = this.generateDiff(originalCode, modifiedCode);
        return renderDiffLines(diff);
    };


    render() {
        const uniqueKey = this.state.d.filePath;
        const apiKey = localStorage.getItem("OPENAI_API_KEY");

        const titleStyle = {
            color: "#333",
            fontSize: "1.10em",
            width: "100%",
            fontWeight: "bold",
        };

        const buttonStyle = {
            marginTop: "2px",
            marginRight: "2.5px",
            backgroundColor: "#777",
            color: "white",
            border: "none",
            borderRadius: "5px",
            paddingRight: "5px",
            paddingLeft: "5px",
            fontWeight: "bold",
            cursor: "pointer",
            outline: "none",
        };

        const buttonParent = {
            position: "relative",
            //top: "0",
            //right: "0",
            zIndex: "1",
        };

        const containerStyle = {
            display: "flex",
            flexDirection: "column",
            width: "100%",
            padding: "10px",
            border: "1px solid grey",
            marginTop: "2px",
            borderRadius: "5px"
        };

        const paneStyle = {
            padding: "10px",
            borderBottom: "1px solid grey",
            marginTop: "2px",
            borderRadius: "0px"
        };

        const highlightCode = (code) => {
            return Prism.highlight(code, Prism.languages.java, 'java');
        };

        const wrapperStyle = {
            display: 'flex',
            alignItems: 'center',
            width: '100%',
        };

        const contentStyle = {
            flex: 1,
        };

        return (
            <section>
                <div
                    data-file-path={this.state.d.filePath}
                    className="snippetDiv"
                    style={{ position: "relative" }}
                >
                    <div
                        className="link"
                        style={paneStyle}
                        onClick={() => {
                            this.props.onIgnoreFile(true);
                            Utilities.sendToServer(
                                this.props.ws,
                                webSocketSendMessage.snippet_xml_msg,
                                this.state.d.xml,
                            );
                        }}
                    >
                        <h2 style={titleStyle}>Violated Code Snippet </h2>
                        <div style={wrapperStyle}>
                            <pre
                                className="content"
                                style={contentStyle}
                                dangerouslySetInnerHTML={{ __html: highlightCode(Utilities.removeSrcmlAnnotations(this.state.d.snippet)) }}
                            />



                            <span style={buttonParent}>
                                {/* render the following IF this is a violation of a rule and there is no fix yet */}
                                {this.state.snippetGroup === "violated" &&
                                    apiKey !== null &&
                                    apiKey !== "" &&
                                    !this.state.suggestedSnippet && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation(); // Prevent the div's onClick from firing
                                                this.handleSuggestion(
                                                    this.state.description,
                                                    this.state.exampleSnippet,
                                                    this.state.d.snippet,
                                                    this.state.d.surroundingNodes,
                                                    this.state.exampleFilePath,
                                                    this.state.d.filePath,
                                                    uniqueKey
                                                );
                                            }}
                                            style={{ ...buttonStyle, backgroundColor: '#3B71CA', color: 'white' }}
                                        >
                                            Fix ✨
                                        </button>
                                    )}
                            </span>
                        </div>
                    </div>

                    {!this.state.suggestionCreated && this.state.fixButtonClicked && (
                        <h2 style={{ color: 'black', fontSize: '1.25em', fontWeight: 'bold', textAlign: 'center' }}>Loading Fix...</h2>
                    )}

                    {this.state.suggestionCreated && this.state.suggestedSnippet && (
                        <div style={containerStyle}>
                            {/*<div style={paneStyle}>*/}
                            {/*                                <h2 style={titleStyle}>Suggested Fix:</h2>
                                <pre
                                    className="content"
                                    dangerouslySetInnerHTML={{ __html: highlightCode(this.state.suggestedSnippet) }}
                                />*/}

                            <div style={paneStyle}>

                                <h2 style={titleStyle}>Suggestion Location:</h2>
                                <p
                                    className="content"
                                    style={{
                                        fontFamily: 'monospace',
                                        whiteSpace: 'pre-wrap',
                                        overflowWrap: 'anywhere',
                                        wordBreak: 'break-word',
                                    }}
                                    dangerouslySetInnerHTML={{ __html: highlightCode(this.state.suggestionFileName) }}
                                />
                            </div>


                            <div style={paneStyle}>
                                <h2 style={titleStyle}>Suggested Fix:</h2>
                                {this.renderDiff()}
                            </div>

                            <div style={paneStyle}>
                                <h2 style={titleStyle}>Explanation:</h2>
                                <p
                                    className="content"
                                    style={{
                                        fontFamily: 'monospace',
                                        whiteSpace: 'pre-wrap',
                                        overflowWrap: 'anywhere',
                                        wordBreak: 'break-word',
                                    }}
                                    dangerouslySetInnerHTML={{
                                        __html: this.state.snippetExplanation,
                                    }}
                                />
                            </div>



                            <div style={{
                                display: 'flex',
                                justifyContent: 'center',
                                gap: '5px',
                                padding: '2px',
                                //border: '1px solid grey',
                                //borderRadius: '5px',
                                marginTop: '2px'
                            }}>
                                <button
                                    onClick={() => {
                                        this.props.onIgnoreFile(true);
                                        if (!this.state.llmModifiedFileContent) {
                                            console.warn('No LLM fix available to accept.');
                                            return;
                                        }
                                        const llmPayload = {
                                            ...this.state.llmModifiedFileContent,
                                            data: {
                                                ...this.state.llmModifiedFileContent.data,
                                                originalFileContent: this.state.originalFileContent,
                                                log: this.state.llmModifiedFileContent.data.log ? {
                                                    ...this.state.llmModifiedFileContent.data.log,
                                                    ruleId: (this.props.rule && this.props.rule.index !== undefined) ? this.props.rule.index : undefined,
                                                    ruleTitle: (this.props.rule && this.props.rule.title) ? this.props.rule.title : '',
                                                } : undefined,
                                            }
                                        };
                                        Utilities.sendToServer(
                                            this.props.ws,
                                            webSocketSendMessage.llm_modified_file_content,
                                            {
                                                llmModifiedFileContent: llmPayload,
                                                originalFileContent: this.state.originalFileContent
                                            }

                                        );
                                        console.log(this.state.llmModifiedFileContent);
                                    }}
                                    style={{ ...buttonStyle, backgroundColor: '#3B71CA', color: 'white' }}
                                >
                                    Accept Fix
                                </button>
                                {/*<button
                                    onClick={(e) => {
                                        e.stopPropagation(); // Prevent the div's onClick from firing
                                        Utilities.sendToServer(
                                            this.props.ws,
                                            webSocketSendMessage.send_llm_snippet_msg,
                                            {
                                                suggestedSnippet: this.state.suggestedSnippet,
                                                snippetExplanation:this.state.snippetExplanation,
                                                //violatedCode: Utilities.removeSrcmlAnnotations(this.state.d.surroundingNodes)
                                            }

                                        );
                                    }}
                                    style={{ ...buttonStyle, marginLeft: '10px', backgroundColor: '#9FA6B2', color: 'white' }} // Inline styling for the new button
                                >
                                    Edit Fix
                                </button>

                                <button
                                    onClick={(e) => {
                                        e.stopPropagation(); // Prevent the div's onClick from firing
                                        this.handleEditFix(
                                            this.state.suggestionFileName,
                                            uniqueKey
                                        );
                                    }}
                                    style={{ ...buttonStyle, marginLeft: '10px', backgroundColor: 'green', color: 'white' }} // Inline styling for the new button
                                >
                                    Regenerate Fix
                                </button>*/}


                            </div>

                        </div>
                    )}
                </div>
            </section>
        );
    }
    UNSAFE_componentWillReceiveProps(nextProps) {
        this.setState({
            snippetGroup: nextProps.snippetGroup,
            d: nextProps.d,
            description: nextProps.description,
            exampleSnippet: nextProps.exampleSnippet,
            exampleFilePath: nextProps.exampleFilePath
        });
    }
}
