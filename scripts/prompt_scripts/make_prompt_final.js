#!/usr/bin/env node
"use strict";

// Print the Final (two-step) prompt for one violation. The assembly lives in
// final_prompt.js, shared with run_prompt.js.
//
// Call A is fully derivable offline. Call B embeds the model's Call A answer, so
// it needs --response-a-file.

const { fs, path, parseArgs, die, sha256Text } = require("../cline_common");
const { loadContext, SWEEP } = require("./prompt_common");
const { SPEC, buildCallA, buildCallB, editProtocolVersion } = require("./final_prompt");

function help() {
    process.stdout.write(`
${SPEC.title}

${SPEC.summary}

Usage:
  node scripts/prompt_scripts/make_prompt_final.js --rule=9 \\
    --project-root="<path>" --violation-file="<path>"

Required and common flags match the other prompt scripts; run any of them with
--help for the full list. Specific to this one:

  --call=A|B               Which of the two prompts to print (default A).
  --response-a-file=<path> The model's Call A answer. Required for --call=B,
                           which embeds it verbatim.
`.trimStart());
}

function readResponseA(flags) {
    if (!flags["response-a-file"] || flags["response-a-file"] === true) {
        die("--call=B embeds the model's Call A answer, so it needs --response-a-file=<path>.");
    }
    const responsePath = path.resolve(String(flags["response-a-file"]));
    if (!fs.existsSync(responsePath)) die(`Response A file not found: ${responsePath}`);
    return { text: fs.readFileSync(responsePath, "utf8"), path: responsePath };
}

async function main() {
    const { flags, positionals } = parseArgs(process.argv.slice(2));
    if (flags.help) { help(); process.exit(0); }
    if (positionals.length) die(`Unexpected positional arguments: ${positionals.join(", ")}`);

    const call = String(flags.call && flags.call !== true ? flags.call : "A").toUpperCase();
    if (!["A", "B"].includes(call)) die("--call must be A or B.");

    const ctx = await loadContext(flags, SPEC);
    if (!ctx) return; // --list-violations already printed

    let prompt;
    let responseAPath = null;
    if (call === "A") {
        prompt = buildCallA(ctx);
    } else {
        const responseA = readResponseA(flags);
        responseAPath = responseA.path;
        prompt = buildCallB(ctx, responseA.text);
    }

    if (!ctx.exampleSurrounding) {
        console.error("WARNING: this rule has no satisfying example anywhere in scope, so the example "
            + "block is empty, exactly as it would be in the tool.");
    }
    if (ctx.exposure.total > 0) {
        console.error(`WARNING: this Final prompt also exposes ${ctx.exposure.total} other violation(s) of rule `
            + `${ctx.rule.index} (${ctx.exposure.extraInViolationFile} in the violating file, `
            + `${ctx.exposure.inRelatedFiles} in related files). Prompts baseline-5 show one violation only.`);
    }

    const provenance = {
        promptVariant: SPEC.variant,
        call,
        ruleIndex: String(ctx.rule.index),
        ruleTitle: ctx.rule.title || "",
        violationFile: ctx.relative(ctx.violationFilePath),
        violationIndex: ctx.violationIndex,
        violationsInFile: ctx.violationsInFile,
        exampleFile: ctx.exampleFilePath ? ctx.relative(ctx.exampleFilePath) : null,
        exampleSource: ctx.exampleSurrounding ? "satisfiedResult[0].surroundingNodes" : null,
        blocks: {
            rule: true,
            example: Boolean(ctx.exampleSurrounding),
            violationSnippet: true,
            surroundingContext: true,
            fullViolationFile: true,
            constraintXPath: true,
            relatedFixSiteFiles: ctx.fixSiteFiles.length > 0,
        },
        contains: SPEC.contains,
        relatedFiles: ctx.fixSiteFiles.map((file) => ({
            path: ctx.relative(file.filePath),
            reason: file.reason,
        })),
        finalPromptExposureForThisViolation: {
            ...ctx.exposure,
            relatedFilesThatViolate: ctx.exposure.relatedFilesThatViolate.map(ctx.relative),
        },
        editProtocolVersion: editProtocolVersion(),
        responseAFile: responseAPath,
        suggestedSweep: SWEEP,
        promptSha256: sha256Text(prompt),
        size: { lines: prompt.split("\n").length, chars: prompt.length },
    };

    process.stdout.write(flags.json
        ? `${JSON.stringify({ ...provenance, prompt }, null, 2)}\n`
        : `${prompt}\n`);

    console.error(`Call ${call}: ${provenance.size.lines} lines, ${provenance.size.chars} chars.`);
}

main().catch((error) => {
    console.error(`Error: ${error && error.message ? error.message : error}`);
    process.exit(1);
});
