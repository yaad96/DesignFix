#!/usr/bin/env node
"use strict";

// RQ1 Prompt 4: Additional Code Context as Input.
//
// "We appended to the prompt: 'Here are some surrounding code snippets for more
//  context:' followed by additional code excerpts, before asking for the fix
//  output (similar format as Prompt 3) ... In this prompt evaluation, we still
//  required JSON output with explanation and code."  (RQ1 & RQ2.md)
//
// Where surrounding-code pass rate starts being scored: the .md adds that metric
// after observing unintended edits to context in this variant.

const {
    main, ruleBlock, exampleBlock, violationBlock, surroundingBlock, ASK, joinBlocks,
} = require("./prompt_common");

const SPEC = {
    variant: "prompt4",
    script: "make_prompt_4.js",
    title: "RQ1 Prompt 4: Prompt 3 plus surrounding code as input.",
    summary: "Adds the enclosing class/method structure around the violation; JSON output retained.",
    needsExample: true,
    needsSurrounding: true,
    contains: { codeFix: true, explanation: true, surroundingCode: true },
    build: (ctx) => joinBlocks(
        ruleBlock(ctx),
        exampleBlock(ctx),
        violationBlock(ctx),
        surroundingBlock(ctx),
        ASK.jsonExplanationAndCode,
    ),
};

module.exports = SPEC;
if (require.main === module) main(SPEC);
