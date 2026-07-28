#!/usr/bin/env node
"use strict";

// RQ1 Prompt 5: Inline Code Context in Output.
//
// "We specifically instructed the model to 'Generate code, with the surrounding
//  code included, to make this violation follow the rule. Do not make
//  modifications to the surrounding unless absolutely required. Maintain proper
//  whitespace with \t and \n. Don't forget a brief explanation of your fix as
//  well.'"  (RQ1 & RQ2.md)
//
// Prompt 4's inputs; the ask moves from "the lines needed" to "the surrounding
// code with the fix applied in place".
//
// ASK.inlineSurrounding keeps the JSON output line from Prompts 3 and 4, which
// the .md does not restate here. It is needed because the .md scores this
// variant on explanation pass rate and says "Prompt 3 and beyond were evaluated
// on" it, which requires a separable explanation. Drop that line from
// prompt_common.js if Prompt 5 was actually run as free prose.

const {
    main, ruleBlock, exampleBlock, violationBlock, surroundingBlock, ASK, joinBlocks,
} = require("./prompt_common");

const SPEC = {
    variant: "prompt5",
    script: "make_prompt_5.js",
    title: "RQ1 Prompt 5: emit the fix in situ, with the surrounding code included.",
    summary: "Prompt 4's inputs, asking for the surrounding code returned with the fix applied inline.",
    needsExample: true,
    needsSurrounding: true,
    contains: { codeFix: true, explanation: true, surroundingCode: true },
    build: (ctx) => joinBlocks(
        ruleBlock(ctx),
        exampleBlock(ctx),
        violationBlock(ctx),
        surroundingBlock(ctx),
        ASK.inlineSurrounding,
    ),
};

module.exports = SPEC;
if (require.main === module) main(SPEC);
