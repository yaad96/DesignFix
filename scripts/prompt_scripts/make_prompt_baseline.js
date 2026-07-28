#!/usr/bin/env node
"use strict";

// RQ1 Baseline prompt.
//
// "The baseline prompt provided the minimal necessary context: it stated the
//  design rule, along with the code that violates the rule. The prompt then
//  simply asked the model to suggest a fix."  (RQ1 & RQ2.md)
//
// Minimal means minimal: no positive example, no surrounding context, no file
// paths.

const { main, ruleBlock, violationBlock, ASK, joinBlocks } = require("./prompt_common");

const SPEC = {
    variant: "baseline",
    script: "make_prompt_baseline.js",
    title: "RQ1 Baseline: rule plus violating code.",
    summary: "States the design rule and the violating code, then asks for a fix.",
    needsExample: false,
    needsSurrounding: false,
    contains: { codeFix: true, explanation: false, surroundingCode: false },
    build: (ctx) => joinBlocks(ruleBlock(ctx), violationBlock(ctx), ASK.suggestFix),
};

module.exports = SPEC;
if (require.main === module) main(SPEC);
