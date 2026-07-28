#!/usr/bin/env node
"use strict";

// RQ1 Prompt 3: JSON with Explanation and Code.
//
// "We modified the request to: 'Generate a short explanation and the code needed
//  to achieve the fix. Strictly output in JSON format with fields explanation and
//  code.'"  (RQ1 & RQ2.md)
//
// Prompt 2's inputs; only the ask changes. First variant scored on explanation
// pass rate, being the first to ask for a rationale at all.

const {
    main, ruleBlock, exampleBlock, violationBlock, ASK, joinBlocks,
} = require("./prompt_common");

const SPEC = {
    variant: "prompt3",
    script: "make_prompt_3.js",
    title: "RQ1 Prompt 3: structured JSON output with an explanation.",
    summary: "Prompt 2's inputs, asking for JSON with explanation and code fields.",
    needsExample: true,
    needsSurrounding: false,
    contains: { codeFix: true, explanation: true, surroundingCode: false },
    build: (ctx) => joinBlocks(
        ruleBlock(ctx),
        exampleBlock(ctx),
        violationBlock(ctx),
        ASK.jsonExplanationAndCode,
    ),
};

module.exports = SPEC;
if (require.main === module) main(SPEC);
