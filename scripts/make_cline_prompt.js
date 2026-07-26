#!/usr/bin/env node
"use strict";

const {
    fs, path, parseArgs, die, requiredString, positiveInteger, parseBoolean,
    sanitizeComponent, normalizeText, normalizePath, sha256Text, writeJson,
    nextRunNumber, tryGit, copyToClipboard, defaultDataRoot,
    resolveProjectRoot, resolveRuleTable, snapshotWorkspace, projectRelativePath,
} = require("./cline_common");

function help() {
    process.stdout.write(`
Generate a rule-specific prompt for the Cline VS Code extension and reserve
cline_data/rule_<id>/run_<NN>/ for the later collection step.

Usage:
  node scripts/make_cline_prompt.js --rule=11 --violation-file=<path> \\
    --snippet-file=<path> [options]

Required:
  --rule=<id>                 Rule index from the target project's ruleTable.json.
  --violation-file=<path>     File in which the checker reported the violation.

Violation code (optional; omit so the agent locates the snippet itself):
  --snippet=<text>            Violating code supplied inline.
  --snippet-file=<path>       Text file containing the violating code.
  --checker-output-file=<path>
                              Use the exact checker output as the visible report.
                              Rule ID is still read from ruleTable.json for logging.

Paths:
  --project-root=<path>       Target Java project. Auto-detected when possible.
                              Used, echoed to the console, and never recorded.
  --rule-table=<path>         Override ruleTable.json. Recorded relative to the
                              project root, or by basename if it lies outside.
  --data-root=<path>          Default: sibling cline_data at the workspace root.

Run control:
  --run=<N>                   Reserve a specific run number; otherwise use next.
  --overwrite-pending         Replace an existing run only if its status is pending.
  --snapshot=<true|false>     Save a baseline source snapshot; default: true.

Metadata/output:
  --model=<id>                Example: gpt-4o-2024-11-20.
  --cline-version=<version>
  --time-limit-min=<N>        Metadata only.
  --clipboard                 Copy generated prompt to clipboard.
  --out=<path>                Also write a separate prompt copy.
  --quiet                     Do not print the full prompt.
  --help

The visible prompt contains only checker-equivalent information: the rule and its
violation report. It carries no experiment identifiers, so it can be pasted into
Cline verbatim. The collection script maps the completed task to its reserved run
via explicit --rule/--run plus a prompt-hash check against this prompt.
It does not include a satisfying example, surrounding context, candidate fix
files, the complete violation file, or cross-file repair hints.

The reserved run records project-relative paths only: no absolute path, no
project root, and no timestamps are written into cline_data. Because of that,
collect_cline_task.js needs the project root passed to it (--project-root, or
DESIGNFIX_TARGET_PROJECT_ROOT, or a cwd holding ruleTable.json).
`.trimStart());
}

const { flags, positionals } = parseArgs(process.argv.slice(2));
if (flags.help) { help(); process.exit(0); }
if (positionals.length) die(`Unexpected positional arguments: ${positionals.join(", ")}`);

const ruleId = requiredString(flags.rule, "--rule=<id>");
const projectRoot = resolveProjectRoot(flags["project-root"]);
if (!projectRoot) die("Could not locate the target project. Pass --project-root=<path>.");

const ruleTablePath = resolveRuleTable(flags["rule-table"], projectRoot);
if (!ruleTablePath) die("Could not locate ruleTable.json. Pass --rule-table=<path>.");

let rules;
try {
    const parsed = JSON.parse(fs.readFileSync(ruleTablePath, "utf8"));
    rules = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rules) ? parsed.rules : [];
} catch (error) {
    die(`Failed to read ${ruleTablePath}: ${error.message}`);
}
const rule = rules.find((r) => r && String(r.index) === String(ruleId));
if (!rule) die(`Rule ${ruleId} was not found in ${ruleTablePath}.`);

const violationArg = requiredString(flags["violation-file"], "--violation-file=<path>");
let violationPath = path.isAbsolute(violationArg)
    ? path.resolve(violationArg)
    : path.resolve(projectRoot, violationArg);
if (!fs.existsSync(violationPath) || !fs.statSync(violationPath).isFile()) {
    die(`Violation file not found: ${violationPath}`);
}
const violationRelative = normalizePath(path.relative(projectRoot, violationPath));
if (violationRelative.startsWith("../") || violationRelative === "..") {
    die("The violation file must be inside project-root.");
}

const sourceChoices = [
    flags.snippet !== undefined && flags.snippet !== true,
    flags["snippet-file"] !== undefined && flags["snippet-file"] !== true,
    flags["checker-output-file"] !== undefined && flags["checker-output-file"] !== true,
].filter(Boolean).length;
if (sourceChoices > 1) {
    die("Choose at most one violation source: --snippet, --snippet-file, or --checker-output-file.");
}

let violationSnippet = "";
let exactCheckerOutput = null;
if (flags.snippet !== undefined && flags.snippet !== true) {
    violationSnippet = normalizeText(flags.snippet);
} else if (flags["snippet-file"] !== undefined && flags["snippet-file"] !== true) {
    const snippetPath = path.resolve(String(flags["snippet-file"]));
    if (!fs.existsSync(snippetPath)) die(`Snippet file not found: ${snippetPath}`);
    violationSnippet = normalizeText(fs.readFileSync(snippetPath, "utf8"));
} else if (flags["checker-output-file"] !== undefined && flags["checker-output-file"] !== true) {
    const checkerPath = path.resolve(String(flags["checker-output-file"]));
    if (!fs.existsSync(checkerPath)) die(`Checker-output file not found: ${checkerPath}`);
    exactCheckerOutput = normalizeText(fs.readFileSync(checkerPath, "utf8"));
}
if (exactCheckerOutput !== null && !exactCheckerOutput) die("The checker output is empty.");

const dataRoot = path.resolve(flags["data-root"] && flags["data-root"] !== true
    ? String(flags["data-root"])
    : defaultDataRoot());
const ruleDir = path.join(dataRoot, `rule_${sanitizeComponent(ruleId)}`);
const runNumber = flags.run !== undefined && flags.run !== true
    ? positiveInteger(flags.run, "--run")
    : nextRunNumber(ruleDir);
const runLabel = String(runNumber).padStart(2, "0");
const runDir = path.join(ruleDir, `run_${runLabel}`);

if (fs.existsSync(runDir)) {
    const existing = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf8")); } catch { return null; }
    })();
    if (!flags["overwrite-pending"] || existing?.status !== "pending") {
        die(`Run directory already exists: ${runDir}`);
    }
    fs.rmSync(runDir, { recursive: true, force: true });
}
fs.mkdirSync(runDir, { recursive: true });

const tags = Array.isArray(rule.tags) && rule.tags.length ? rule.tags.join(", ") : "(none)";
const description = rule.description || "(no description provided)";
const violatingCodeBlock = violationSnippet
    ? `\n\nViolating code:\n\`\`\`java\n${violationSnippet}\n\`\`\``
    : "";
const report = exactCheckerOutput !== null
    ? exactCheckerOutput
    : `Rule: ${rule.title || `Rule ${rule.index}`}\n\nDescription:\n${description}\n\nTags: ${tags}\n\nViolation file:\n${violationRelative}${violatingCodeBlock}`;

const prompt = `You are repairing one design-rule violation in this Java repository.

The project's design-rule checker reported the following violation:

<<<CHECKER_OUTPUT>>>
${report}
<<<END_CHECKER_OUTPUT>>>

Repair the reported violation in the repository.

Inspect the workspace and use repository search, file-reading and file-editing tools, and terminal commands as needed. Determine the appropriate repair location and implementation from the project itself. 

Make the smallest correct change that resolves the reported violation while preserving unrelated behavior and existing project conventions. Run the available design-rule checker, build, and relevant tests before finishing when those commands are available.

Do not ask the user for implementation guidance. Do not stop after only describing a patch: make the changes in the workspace. If a validation command is unavailable or cannot be run, continue using the available repository evidence and report that limitation.

When finished, briefly summarize:
1. the file or files changed;
2. why the change resolves the reported violation; and
3. the validation commands run and their results.`;

const snapshotEnabled = parseBoolean(flags.snapshot, "--snapshot", true);
// Recorded metadata is machine-independent on purpose: paths are relative to the
// target project and no wall-clock value is stored. The project root itself is
// only echoed to the console for the operator, never written into cline_data.
const metadata = {
    schemaVersion: 2,
    status: "pending",
    ruleId: String(rule.index),
    ruleTitle: rule.title || "",
    runNumber,
    runLabel,
    ruleTableRelativePath: projectRelativePath(projectRoot, ruleTablePath),
    violationFileRelativePath: violationRelative,
    model: flags.model && flags.model !== true ? String(flags.model) : "",
    clineVersion: flags["cline-version"] && flags["cline-version"] !== true ? String(flags["cline-version"]) : "",
    timeLimitMinutes: flags["time-limit-min"] && flags["time-limit-min"] !== true ? Number(flags["time-limit-min"]) : null,
    promptSha256: sha256Text(prompt),
    repository: {
        commit: tryGit(projectRoot, ["rev-parse", "HEAD"]),
        branch: tryGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
        statusBefore: tryGit(projectRoot, ["status", "--porcelain"]),
    },
    baselineSnapshotSaved: snapshotEnabled,
    modelVisibleInputs: {
        internalRuleId: false,
        internalRunId: false,
        ruleTitle: exactCheckerOutput === null,
        ruleDescription: exactCheckerOutput === null,
        ruleTags: exactCheckerOutput === null,
        violationFilePath: exactCheckerOutput === null,
        violationSnippet: exactCheckerOutput === null && violationSnippet !== "",
        exactCheckerOutput: exactCheckerOutput !== null,
        fullViolationFile: false,
        satisfyingExample: false,
        surroundingContext: false,
        candidateFixFiles: false,
        crossFileHint: false,
    },
};

fs.writeFileSync(path.join(runDir, "prompt.txt"), `${prompt}\n`, "utf8");
fs.writeFileSync(path.join(runDir, "checker_output.txt"), `${report}\n`, "utf8");
writeJson(path.join(runDir, "meta.json"), metadata);
if (snapshotEnabled) snapshotWorkspace(projectRoot, path.join(runDir, "baseline"));

if (flags.out && flags.out !== true) {
    const outPath = path.resolve(String(flags.out));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${prompt}\n`, "utf8");
}
if (flags.clipboard) {
    const tool = copyToClipboard(prompt);
    if (!tool) console.error("Warning: clipboard copy failed; use the saved prompt.txt file.");
    else console.error(`Prompt copied to clipboard using ${tool}.`);
}

console.error(`Reserved run: ${runDir}`);
console.error(`Rule ${rule.index}, run ${runLabel}`);
console.error(`Prompt saved: ${path.join(runDir, "prompt.txt")}`);
// Console only. The run folder stores no project path, so the collector has to
// be given the same root: pass it with --project-root when collecting.
console.error(`Project root used (not recorded): ${projectRoot}`);
if (!flags.quiet) process.stdout.write(`${prompt}\n`);
