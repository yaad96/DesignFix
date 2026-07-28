#!/usr/bin/env node
"use strict";

// RQ1 Prompt 2: Rule-Satisfying Example from the Codebase.
//
// "Prompt 2 built on Prompt 1 by adding a short code snippet from the same
//  codebase that correctly follows the rule ... Prompt 1's instruction to output
//  only the lines of code needed for the fix was retained, so the added positive
//  example was the only change between the two variants."  (RQ1 & RQ2.md)

const {
    main, ruleBlock, exampleBlock, violationBlock, ASK, joinBlocks,
} = require("./prompt_common");

const SPEC = {
    variant: "prompt2",
    script: "make_prompt_2.js",
    title: "RQ1 Prompt 2: Prompt 1 plus a rule-satisfying example from the codebase.",
    summary: "Adds a positive example from the same project; the code-only instruction is retained.",
    needsExample: true,
    needsSurrounding: false,
    contains: { codeFix: true, explanation: false, surroundingCode: false },
    build: (ctx) => joinBlocks(
        ruleBlock(ctx),
        exampleBlock(ctx),
        violationBlock(ctx),
        `${ASK.suggestFix}\n${ASK.codeOnly}`,
    ),
};

module.exports = SPEC;
if (require.main === module) main(SPEC);
