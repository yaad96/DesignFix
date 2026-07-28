"use strict";

// Shared plumbing and prompt fragments for the RQ1 prompt-variant scripts.
//
// The variants are cumulative: Prompt 1 is the baseline plus a sentence, Prompt 2
// is Prompt 1 plus an example, and so on. Each block and each instruction is
// therefore defined once here and composed by the variant scripts, so a wording
// change cannot land in one variant and miss the ones that build on it. What
// each variant composes stays visible in its own file.
//
// make_prompt_final.js shares the context loader but gets its text from the
// client's own fixPrompts.js.

const {
    fs, path, parseArgs, die, requiredString, positiveInteger, normalizePath, sha256Text,
} = require("../cline_common");
const {
    resolveRule, runRule, selectViolation, selectExample, gatherFixSiteFiles,
    measureFinalPromptExposure, removeSrcmlAnnotations,
} = require("../rule_engine");

// Sweep the .md describes for RQ1/RQ2: 2 model snapshots x 3 temperatures x 5
// trials per prompt variant. Recorded in --json so a runner does not have to
// re-derive it from the paper. The labels are the paper's own short names for
// the two snapshots, and run_prompt.js files results under them.
const SWEEP = {
    models: [
        { id: "gpt-4o-2024-08-06", label: "aug" },
        { id: "gpt-4o-2024-11-20", label: "nov" },
    ],
    temperatures: [0.5, 0.75, 1.0],
    trialsPerSetting: 5,
};

// ------------------------------------------------------------- prompt fragments

// Context blocks. The example is satisfiedResult[0].surroundingNodes and the
// surrounding block is the violation's own surroundingNodes, both byte-identical
// to what the Final prompt carries (see rule_engine.selectExample).
const ruleBlock = (ctx) => `Here is a design rule from the documentation:\n\n${ctx.ruleDescription}`;
const exampleBlock = (ctx) => `Here is an example from this codebase that follows it:\n\n${ctx.exampleSurrounding}`;
const violationBlock = (ctx) => `Here is code that violates it:\n\n${ctx.violationSnippet}`;
const surroundingBlock = (ctx) => `Here are some surrounding code snippets for more context:\n\n${ctx.violationSurrounding}`;

// Closing instructions, each quoted from the variant that introduces it in
// RQ1 & RQ2.md. Later variants reuse these rather than restating them, which is
// what makes "Prompt 1 appends X to the baseline prompt" true by construction.
const ASK = {
    // Baseline: "asked the model to suggest a fix".
    suggestFix: "Can you suggest a fix to make this code follow the design rule?",
    // Prompt 1, retained by Prompt 2.
    codeOnly: "Only output the lines of code needed to achieve the fix.",
    // Prompt 3, retained by Prompt 4.
    jsonExplanationAndCode: "Generate a short explanation and the code needed to achieve the fix. "
        + "Strictly output in JSON format with fields explanation and code.",
    // Prompt 5. The trailing JSON line is not in the .md quote; see make_prompt_5.js.
    inlineSurrounding: "Generate code, with the surrounding code included, to make this violation follow the rule. "
        + "Do not make modifications to the surrounding unless absolutely required. "
        + "Maintain proper whitespace with \\t and \\n. "
        + "Don't forget a brief explanation of your fix as well.\n"
        + "Strictly output in JSON format with fields explanation and code.",
};

const joinBlocks = (...blocks) => blocks.filter(Boolean).join("\n\n");

// ------------------------------------------------------------------------ help

function help(spec) {
    const contains = Object.entries(spec.contains)
        .filter(([, applies]) => applies)
        .map(([name]) => name)
        .join(", ");
    process.stdout.write(`
${spec.title}

${spec.summary}

Usage:
  node scripts/prompt_scripts/${spec.script} --rule=<id> \\
    --project-root="<path>" --violation-file="<path>"

Required:
  --rule=<id>              Rule index from the project's ruleTable.json.
  --project-root=<path>    Target Java project holding ruleTable.json. Never
                           inferred: several copies of each study project sit
                           side by side, so a guess would build the prompt from
                           the wrong corpus.
  --violation-file=<path>  Which violation to describe. Project-relative or
                           absolute; matched against the checker's own results.

Optional:
  --index=<n>              Which violation within that file (default 1). Needed
                           only where one file holds several violations of a rule.
  --list-violations        List this rule's violations, with their --index, and exit.
  --json                   Emit the prompt plus provenance as JSON.
  --refresh-cache          Recompute the cached checker result for this rule.
  --help

The prompt goes to stdout and progress to stderr, so "> file.txt" captures it.

This variant's output should contain: ${contains}.

The rule text, violating snippet, surrounding context and satisfying example are
derived by running the real checker (srcML plus the client's own ruleExecutor.js
in headless Chrome), so they are the same strings DesignFix would have produced.
Results are cached per rule against the exact bytes they came from, so editing
the corpus invalidates them on its own.
`.trimStart());
}

// -------------------------------------------------------------- context loading

/**
 * Resolve every input a variant might need for one violation.
 * @return {Promise<object|null>} null when the script already handled the run
 *                                (--list-violations).
 */
async function loadContext(flags, spec) {
    const ruleId = requiredString(flags.rule, "--rule=<id>");
    const projectRootArg = requiredString(flags["project-root"], "--project-root=<path>");
    const projectRoot = path.resolve(projectRootArg);
    if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
        die(`Project root is not an existing directory: ${projectRoot}`);
    }

    const ruleTablePath = path.join(projectRoot, "ruleTable.json");
    if (!fs.existsSync(ruleTablePath)) {
        die(`No ruleTable.json at ${ruleTablePath}. Point --project-root at the target Java project.`);
    }

    const listOnly = Boolean(flags["list-violations"]);
    const violationArg = listOnly ? null : requiredString(flags["violation-file"], "--violation-file=<path>");
    const index = flags.index !== undefined && flags.index !== true
        ? positiveInteger(flags.index, "--index") : 1;

    const rule = resolveRule(ruleTablePath, ruleId);
    console.error(`Rule ${rule.index}: ${rule.title || "(untitled)"}`);

    const run = await runRule({
        projectRoot,
        rule,
        refreshCache: Boolean(flags["refresh-cache"]),
    });
    console.error(run.cacheHit
        ? `Checker result reused from cache (${run.filesScanned} of ${run.filesInProject} Java file(s) in scope).`
        : `Checker run over ${run.filesScanned} of ${run.filesInProject} Java file(s).`);

    const relative = (filePath) => normalizePath(path.relative(projectRoot, filePath));

    if (listOnly) {
        const violating = run.rows.filter((row) => row.violated.length > 0);
        console.log(`Rule ${rule.index} violations: `
            + `${violating.reduce((n, row) => n + row.violated.length, 0)} across ${violating.length} file(s)`);
        let ordinal = 0;
        for (const row of violating) {
            console.log(`\n  ${relative(row.filePath)}  (${row.violated.length})`);
            row.violated.forEach((entry, i) => {
                ordinal += 1;
                const snippetLines = removeSrcmlAnnotations(entry.snippet).split("\n");
                console.log(`    violation_${String(ordinal).padStart(2, "0")}  --index=${i + 1}  ${snippetLines[0]}`);
                for (const line of snippetLines.slice(1)) console.log(`                            ${line}`);
            });
        }
        const satisfying = run.rows.filter((row) => row.satisfied.length > 0);
        console.log(`\nSatisfying examples: `
            + `${satisfying.reduce((n, row) => n + row.satisfied.length, 0)} across ${satisfying.length} file(s)`
            + `${satisfying.length ? `; default example comes from ${relative(satisfying[0].filePath)}` : ""}`);
        return null;
    }

    const picked = selectViolation(run.rows, projectRoot, violationArg, index);
    const example = selectExample(run.rows);

    // A variant that shows a positive example must never emit one with an empty
    // example block: that would silently degrade it into the previous variant and
    // corrupt exactly one row of the results table.
    if (spec.needsExample && !example) {
        die(`Rule ${rule.index} has no satisfying example anywhere in scope, so ${spec.variant} `
            + "cannot be built for it. Baseline and Prompt 1 do not need one.");
    }

    const fixSiteFiles = gatherFixSiteFiles(rule, picked.row.filePath, run.files, run.rows);

    return {
        rule,
        projectRoot,
        relative,
        rows: run.rows,
        files: run.files,
        cacheHit: run.cacheHit,
        ruleDescription: String(rule.description || "").trim(),
        violationFilePath: picked.row.filePath,
        violationIndex: picked.index,
        violationsInFile: picked.total,
        violationOrdinal: picked.ordinal,
        violationSnippet: removeSrcmlAnnotations(picked.entry.snippet),
        violationSurrounding: removeSrcmlAnnotations(picked.entry.surroundingNodes),
        exampleFilePath: example ? example.row.filePath : null,
        exampleSurrounding: example ? removeSrcmlAnnotations(example.entry.surroundingNodes) : null,
        exampleSnippet: example ? removeSrcmlAnnotations(example.entry.snippet) : null,
        fixSiteFiles,
        exposure: measureFinalPromptExposure(run.rows, picked.row, fixSiteFiles),
    };
}

// ------------------------------------------------------------------- provenance

function buildProvenance(ctx, spec, prompt) {
    return {
        promptVariant: spec.variant,
        ruleIndex: String(ctx.rule.index),
        ruleTitle: ctx.rule.title || "",
        violationFile: ctx.relative(ctx.violationFilePath),
        violationIndex: ctx.violationIndex,
        violationsInFile: ctx.violationsInFile,
        exampleFile: ctx.exampleFilePath ? ctx.relative(ctx.exampleFilePath) : null,
        exampleSource: ctx.exampleSurrounding ? "satisfiedResult[0].surroundingNodes" : null,
        blocks: {
            rule: true,
            example: Boolean(spec.needsExample),
            violationSnippet: true,
            surroundingContext: Boolean(spec.needsSurrounding),
            fullViolationFile: false,
            constraintXPath: false,
            relatedFixSiteFiles: false,
        },
        contains: spec.contains,
        // Non-zero means the Final prompt for this same violation would also see
        // other violations of this rule (through its full-file and related-file
        // blocks) that this variant never shows. Recorded so the analysis can
        // stratify instead of silently comparing unlike cases.
        finalPromptExposureForThisViolation: {
            ...ctx.exposure,
            relatedFilesThatViolate: ctx.exposure.relatedFilesThatViolate.map(ctx.relative),
        },
        suggestedSweep: SWEEP,
        promptSha256: sha256Text(prompt),
        size: { lines: prompt.split("\n").length, chars: prompt.length },
    };
}

// -------------------------------------------------------------------- entrypoint

/**
 * Run one prompt-variant script.
 * @param spec {{variant:string, script:string, title:string, summary:string,
 *               needsExample:boolean, needsSurrounding:boolean,
 *               contains:{codeFix:boolean, explanation:boolean, surroundingCode:boolean},
 *               build:(ctx:object)=>string}}
 */
async function runPromptScript(spec) {
    const { flags, positionals } = parseArgs(process.argv.slice(2));
    if (flags.help) { help(spec); process.exit(0); }
    if (positionals.length) die(`Unexpected positional arguments: ${positionals.join(", ")}`);

    const ctx = await loadContext(flags, spec);
    if (!ctx) return; // --list-violations already printed

    const prompt = spec.build(ctx);
    const provenance = buildProvenance(ctx, spec, prompt);

    if (ctx.exposure.total > 0) {
        console.error(`NOTE: the Final prompt for this violation would additionally see `
            + `${ctx.exposure.total} other violation(s) of rule ${ctx.rule.index}. This variant shows one.`);
    }

    process.stdout.write(flags.json
        ? `${JSON.stringify({ ...provenance, prompt }, null, 2)}\n`
        : `${prompt}\n`);

    console.error(`${spec.variant}: ${provenance.size.lines} lines, ${provenance.size.chars} chars.`);
}

function main(spec) {
    runPromptScript(spec).catch((error) => {
        console.error(`Error: ${error && error.message ? error.message : error}`);
        process.exit(1);
    });
}

module.exports = {
    main,
    loadContext,
    ruleBlock,
    exampleBlock,
    violationBlock,
    surroundingBlock,
    ASK,
    joinBlocks,
    SWEEP,
};
