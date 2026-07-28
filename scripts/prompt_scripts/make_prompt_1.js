#!/usr/bin/env node
"use strict";

// RQ1 Prompt 1: Code-Only Fix Output.
//
// "Prompt 1 appends: 'Only output the lines of code needed to achieve the fix.'
//  to the baseline prompt."  (RQ1 & RQ2.md)
//
// Everything else is held constant, so the baseline-to-Prompt-1 difference
// isolates the output-format instruction. Scored on code fix only: the
// instruction forbids the prose an explanation metric would need.

const { main, ruleBlock, violationBlock, ASK, joinBlocks } = require("./prompt_common");

const SPEC = {
    variant: "prompt1",
    script: "make_prompt_1.js",
    title: "RQ1 Prompt 1: baseline plus a code-only output instruction.",
    summary: "The baseline prompt with 'Only output the lines of code needed to achieve the fix.' appended.",
    needsExample: false,
    needsSurrounding: false,
    contains: { codeFix: true, explanation: false, surroundingCode: false },
    build: (ctx) => joinBlocks(
        ruleBlock(ctx),
        violationBlock(ctx),
        `${ASK.suggestFix}\n${ASK.codeOnly}`,
    ),
};

module.exports = SPEC;
if (require.main === module) main(SPEC);
