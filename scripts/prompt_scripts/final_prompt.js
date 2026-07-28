"use strict";

// Assembly for the "Final Prompt": the two-step prompt DesignFix sends from
// DesignFix-client/src/activeLLM/suggestFix.js.
//
// The prompt text is not reproduced here. This builds the same inputs
// rulePanel.js builds and hands them to the client's own buildFixAnalysisPrompt
// and buildEditStructuringPrompt, so the output cannot drift from what the tool
// sends. Shared by make_prompt_final.js (print it) and run_prompt.js (send it).

const { loadClientPromptModules } = require("../rule_engine");

// suggestFix.js: step A produces a prose analysis, step B structures it into
// JSON edits. Step B is pinned low because it is a formatting step, where
// sampling variability only produces malformed output; a temperature sweep
// varies step A.
const TEMPERATURE_B = 0.2;

const SPEC = {
    variant: "final",
    script: "make_prompt_final.js",
    title: "Final Prompt: the two-step prompt DesignFix sends.",
    summary: "Rule, analyzer constraint, satisfying example, full violating file, surrounding context "
        + "and related fix-site files, then a JSON edit protocol in a second call.",
    // Unlike Prompts 2 to 5 this does not require an example: suggestFix sends an
    // empty example block when a rule has none, so refusing here would diverge
    // from the tool.
    needsExample: false,
    needsSurrounding: true,
    contains: { codeFix: true, explanation: true, surroundingCode: true },
};

// Same block shapes suggestFix.js builds before calling the prompt builders.
const relatedFileBlock = (file) => `<<<RELATED_FILE_PATH>>>
${file.filePath}
<<<END_RELATED_FILE_PATH>>>
<<<RELATED_FILE_REASON>>>
${file.reason || "related to this rule"}
<<<END_RELATED_FILE_REASON>>>

<<<RELATED_FILE_CONTENT>>>
${file.content}
<<<END_RELATED_FILE_CONTENT>>>`;

const candidateFileBlock = (file) => `<<<FILE_PATH>>>
${file.filePath}
<<<END_FILE_PATH>>>
<<<BASE_HASH>>>
${file.baseHash}
<<<END_BASE_HASH>>>
<<<ALLOW_CREATE>>>
${file.allowCreate ? "true" : "false"}
<<<END_ALLOW_CREATE>>>
<<<FILE_CONTENT>>>
${file.content}
<<<END_FILE_CONTENT>>>`;

function violationFileContentOf(ctx) {
    const file = ctx.files.find((candidate) => candidate.filePath === ctx.violationFilePath);
    return file ? file.content : "";
}

/** Call A: the prose analysis prompt. Fully derivable offline. */
function buildCallA(ctx) {
    const { buildFixAnalysisPrompt } = loadClientPromptModules();
    return buildFixAnalysisPrompt({
        rule: ctx.rule.description,
        constraintXPath: ctx.rule.constraintXPathQuery,
        example: ctx.exampleSurrounding || "",
        violation: ctx.violationSnippet,
        surroundingCode: ctx.violationSurrounding,
        exampleFilePath: ctx.exampleFilePath || "(none)",
        violationFilePath: ctx.violationFilePath,
        violationFileContent: violationFileContentOf(ctx),
        additionalFilesBlock: ctx.fixSiteFiles.length
            ? ctx.fixSiteFiles.map(relatedFileBlock).join("\n\n")
            : "(none)",
    });
}

/** Call B: structures Call A's answer into JSON edits, so it needs that answer. */
function buildCallB(ctx, responseA) {
    const { buildEditStructuringPrompt, EDIT_PROTOCOL_VERSION, buildCandidateManifest } = loadClientPromptModules();
    const candidateFiles = buildCandidateManifest([
        { filePath: ctx.violationFilePath, content: violationFileContentOf(ctx) },
        ...ctx.fixSiteFiles.map((file) => ({
            filePath: file.filePath,
            content: file.content,
            allowCreate: file.allowCreate === true,
        })),
    ]);
    return buildEditStructuringPrompt({
        rule: ctx.rule.description,
        constraintXPath: ctx.rule.constraintXPathQuery,
        responseA,
        originalFilesForStructuring: candidateFiles.map(candidateFileBlock).join("\n\n"),
        violationFilePath: ctx.violationFilePath,
        editProtocolVersion: EDIT_PROTOCOL_VERSION,
    });
}

function editProtocolVersion() {
    return loadClientPromptModules().EDIT_PROTOCOL_VERSION;
}

module.exports = { SPEC, TEMPERATURE_B, buildCallA, buildCallB, editProtocolVersion };
