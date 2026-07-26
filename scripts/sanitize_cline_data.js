#!/usr/bin/env node
"use strict";

const {
    fs, path, parseArgs, die, readJson, writeJson, normalizePath, defaultDataRoot,
} = require("./cline_common");

function help() {
    process.stdout.write(`
Strip machine paths and timestamps from already-collected runs, and verify that
none remain. Run folders are supposed to carry project-relative paths only: no
absolute path, no project root, no clock value.

Usage:
  node scripts/sanitize_cline_data.js --all
  node scripts/sanitize_cline_data.js --all --check
  node scripts/sanitize_cline_data.js --run-dir=cline_data/rule_1/run_01

Options:
  --all              Process every rule_*/run_* folder under the data root.
  --run-dir=<path>   Process a single run folder.
  --data-root=<path> Default: sibling cline_data at the workspace root.
  --check            Report only; write nothing. Exits 1 if anything is found.
  --quiet            Print the summary lines only.
  --help

Removed when present:
  meta.json                projectRoot, ruleTablePath, violationFilePath,
                           collectedAt, clineTask.sourceDirectory,
                           clineTask.modifiedAt, workspaceAfter.projectRoot
  baseline/manifest.json   createdAt, projectRoot, files[].mtimeMs
  workspace_changes.json   comparedAt
  process_metrics.json     analyzedAt, timing.startTs, timing.endTs

An absolute ruleTablePath is converted to a relative ruleTableRelativePath before
being dropped, so the file name survives in relative form.

Scope: only the JSON the harness generates, plus process_metrics_summary.csv.
The verbatim Cline logs under cline_task_raw/, the extracted prompt, and the
normalized conversation are the agent's own evidence and are never rewritten;
analyze_cline_run.js also reads their clock values to derive durations. Snapshot
sources under baseline/files/ and edited_files/ are code, not metadata, and are
likewise left alone. Cline's own task id is kept: it is the only handle mapping a
run to its raw logs, even though Cline derives it from epoch milliseconds.
`.trimStart());
}

const REMOVED_KEY_PATHS = {
    "meta.json": [
        ["projectRoot"], ["ruleTablePath"], ["violationFilePath"], ["collectedAt"],
        ["clineTask", "sourceDirectory"], ["clineTask", "modifiedAt"],
        ["workspaceAfter", "projectRoot"],
    ],
    "baseline/manifest.json": [["createdAt"], ["projectRoot"]],
    "workspace_changes.json": [["comparedAt"]],
    "process_metrics.json": [["analyzedAt"], ["timing", "startTs"], ["timing", "endTs"]],
};

// Scanned for residue after stripping. Relative to a run folder, except the CSV,
// which lives at the data root.
const SCANNED_RUN_FILES = [
    "meta.json", "baseline/manifest.json", "workspace_changes.json",
    "process_metrics.json", "raw_task_manifest.json", "cline_source_files.json",
    "cline_usage_fields.json", "cline_usage_stats.json",
];

// Cline task ids are epoch milliseconds, but they are identifiers: dropping them
// would break the mapping from a run to the raw logs it was collected from.
const ALLOWED_TIME_KEYS = new Set(["taskId", "clineTaskId"]);

const ABS_WINDOWS_RE = /\b[A-Za-z]:[\\/]/;
const ABS_POSIX_RE = /(?:^|\s)\/(?:home|Users|mnt|media|opt|srv|var|tmp|root)\//;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const EPOCH_MS_RE = /^1\d{12}$/;

function looksLikeTimeKey(key) {
    if (ALLOWED_TIME_KEYS.has(key)) return false;
    if (/^[A-Za-z0-9]*?(?:At|Ts|Timestamp|Time|Date)$/.test(key)) return true;
    return /mtime|ctime|birthtime|epoch/i.test(key);
}

function deleteKeyPath(root, keyPath) {
    let node = root;
    for (let i = 0; i < keyPath.length - 1; i += 1) {
        if (!node || typeof node !== "object") return false;
        node = node[keyPath[i]];
    }
    const last = keyPath[keyPath.length - 1];
    if (!node || typeof node !== "object" || !(last in node)) return false;
    delete node[last];
    return true;
}

function scanValue(value, keyPath, leaks, key = "") {
    if (typeof value === "string") {
        if (ABS_WINDOWS_RE.test(value) || ABS_POSIX_RE.test(value)) {
            leaks.push({ kind: "absolute-path", keyPath, sample: value.slice(0, 160) });
        }
        if (ISO_DATE_RE.test(value) || (EPOCH_MS_RE.test(value) && !ALLOWED_TIME_KEYS.has(key))) {
            leaks.push({ kind: "timestamp", keyPath, sample: value.slice(0, 160) });
        }
        return;
    }
    if (typeof value === "number") {
        if (!ALLOWED_TIME_KEYS.has(key) && (looksLikeTimeKey(key) || (value >= 1e12 && value <= 4e12))) {
            leaks.push({ kind: "timestamp", keyPath, sample: String(value) });
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => scanValue(item, `${keyPath}[${index}]`, leaks, key));
        return;
    }
    if (value && typeof value === "object") {
        for (const [childKey, childValue] of Object.entries(value)) {
            if (looksLikeTimeKey(childKey) && (childValue === null || typeof childValue !== "object")) {
                leaks.push({ kind: "timestamp", keyPath: keyPath ? `${keyPath}.${childKey}` : childKey, sample: String(childValue) });
                continue;
            }
            scanValue(childValue, keyPath ? `${keyPath}.${childKey}` : childKey, leaks, childKey);
        }
    }
}

function stripRunFolder(runDir) {
    const removed = [];
    for (const [relative, keyPaths] of Object.entries(REMOVED_KEY_PATHS)) {
        const filePath = path.join(runDir, ...relative.split("/"));
        const json = readJson(filePath, null);
        if (!json) continue;
        let changed = false;

        if (relative === "meta.json" && json.ruleTablePath && !json.ruleTableRelativePath) {
            json.ruleTableRelativePath = normalizePath(path.basename(String(json.ruleTablePath)));
            removed.push(`${relative}: ruleTablePath -> ruleTableRelativePath=${json.ruleTableRelativePath}`);
            changed = true;
        }
        for (const keyPath of keyPaths) {
            if (!deleteKeyPath(json, keyPath)) continue;
            removed.push(`${relative}: ${keyPath.join(".")}`);
            changed = true;
        }
        if (relative === "baseline/manifest.json" && Array.isArray(json.files)) {
            let mtimes = 0;
            for (const entry of json.files) {
                if (entry && typeof entry === "object" && "mtimeMs" in entry) { delete entry.mtimeMs; mtimes += 1; }
            }
            if (mtimes) { removed.push(`${relative}: files[].mtimeMs (${mtimes} entries)`); changed = true; }
        }
        if (relative === "meta.json" && json.schemaVersion !== 2) {
            json.schemaVersion = 2;
            changed = true;
        }
        if (relative === "process_metrics.json" && json.schemaVersion !== 2) {
            json.schemaVersion = 2;
            changed = true;
        }
        if (changed) writeJson(filePath, json);
    }
    return removed;
}

function scanRunFolder(runDir) {
    const leaks = [];
    for (const relative of SCANNED_RUN_FILES) {
        const filePath = path.join(runDir, ...relative.split("/"));
        const json = readJson(filePath, null);
        if (json === null) continue;
        const fileLeaks = [];
        scanValue(json, "", fileLeaks);
        for (const leak of fileLeaks) leaks.push({ file: relative, ...leak });
    }
    return leaks;
}

// Files whose bytes are evidence, not metadata: byte copies of project files and
// verbatim agent text. They are counted and reported, never rewritten, so
// "nothing remains" is never claimed about content nobody is allowed to edit.
const ABS_WINDOWS_G = /\b[A-Za-z]:[\\/]/g;
const ISO_DATE_G = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g;
const LOCAL_DATE_G = /\b\d{1,2}\/\d{1,2}\/\d{4},? +\d{1,2}:\d{2}/g;

function countMatches(text, re) {
    const found = text.match(re);
    return found ? found.length : 0;
}

function textFilesUnder(dir, maxBytes = 8 * 1024 * 1024) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...textFilesUnder(full, maxBytes));
        else if (entry.isFile() && fs.statSync(full).size <= maxBytes) results.push(full);
    }
    return results;
}

function scanPreservedContent(runDir) {
    const groups = [
        { label: "cline_conversation.txt", files: [path.join(runDir, "cline_conversation.txt")], why: "verbatim Cline text, read by no script" },
        { label: "cline_prompt_extracted.txt", files: [path.join(runDir, "cline_prompt_extracted.txt")], why: "hashed by clineTask.extractedPromptSha256" },
        { label: "edited_files/", files: textFilesUnder(path.join(runDir, "edited_files")), why: "byte copies of the project files the agent edited" },
        { label: "cline_task_raw/", files: textFilesUnder(path.join(runDir, "cline_task_raw")), why: "the agent's own logs; durations and model id are read from them" },
    ];
    const report = [];
    for (const group of groups) {
        let absolute = 0;
        let dates = 0;
        let counted = 0;
        for (const filePath of group.files) {
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
            let text;
            try { text = fs.readFileSync(filePath, "utf8"); } catch { continue; }
            counted += 1;
            absolute += countMatches(text, ABS_WINDOWS_G);
            dates += countMatches(text, ISO_DATE_G) + countMatches(text, LOCAL_DATE_G);
        }
        if (counted && (absolute || dates)) report.push({ ...group, absolute, dates, counted });
    }
    return report;
}

function scanSummaryCsv(dataRoot) {
    const csvPath = path.join(dataRoot, "process_metrics_summary.csv");
    if (!fs.existsSync(csvPath)) return [];
    const leaks = [];
    const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
        if (ABS_WINDOWS_RE.test(line) || ABS_POSIX_RE.test(line)) {
            leaks.push({ file: "process_metrics_summary.csv", kind: "absolute-path", keyPath: `line ${index + 1}`, sample: line.slice(0, 160) });
        }
        if (ISO_DATE_RE.test(line)) {
            leaks.push({ file: "process_metrics_summary.csv", kind: "timestamp", keyPath: `line ${index + 1}`, sample: line.slice(0, 160) });
        }
    });
    return leaks;
}

function findRunDirs(dataRoot) {
    const runDirs = [];
    if (!fs.existsSync(dataRoot)) return runDirs;
    for (const ruleEntry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
        if (!ruleEntry.isDirectory() || !/^rule_/.test(ruleEntry.name)) continue;
        const ruleDir = path.join(dataRoot, ruleEntry.name);
        for (const runEntry of fs.readdirSync(ruleDir, { withFileTypes: true })) {
            if (runEntry.isDirectory() && /^run_\d+$/.test(runEntry.name)) runDirs.push(path.join(ruleDir, runEntry.name));
        }
    }
    return runDirs.sort();
}

const { flags, positionals } = parseArgs(process.argv.slice(2));
if (flags.help) { help(); process.exit(0); }
if (positionals.length) die(`Unexpected positional arguments: ${positionals.join(", ")}`);
const check = Boolean(flags.check);
const quiet = Boolean(flags.quiet);
const dataRoot = path.resolve(flags["data-root"] && flags["data-root"] !== true
    ? String(flags["data-root"])
    : defaultDataRoot());

let runDirs;
if (flags["run-dir"] && flags["run-dir"] !== true) {
    const runDir = path.resolve(String(flags["run-dir"]));
    if (!fs.existsSync(runDir)) die(`Run directory not found: ${runDir}`);
    runDirs = [runDir];
} else if (flags.all) {
    runDirs = findRunDirs(dataRoot);
    if (!runDirs.length) die(`No rule_*/run_* folders found under ${dataRoot}`);
} else {
    help();
    die("Pass --all or --run-dir=<path>.");
}

let removedTotal = 0;
const allLeaks = [];
const preserved = [];
for (const runDir of runDirs) {
    const label = normalizePath(path.relative(dataRoot, runDir));
    const removed = check ? [] : stripRunFolder(runDir);
    removedTotal += removed.length;
    const leaks = scanRunFolder(runDir);
    for (const leak of leaks) allLeaks.push({ run: label, ...leak });
    for (const group of scanPreservedContent(runDir)) preserved.push({ run: label, ...group });
    if (!quiet) {
        if (removed.length) console.log(`${label}: removed ${removed.length} field(s)\n  - ${removed.join("\n  - ")}`);
        else if (!check) console.log(`${label}: already clean`);
        if (leaks.length) console.log(`${label}: ${leaks.length} remaining item(s)`);
    }
}
for (const leak of scanSummaryCsv(dataRoot)) allLeaks.push({ run: ".", ...leak });

console.log(`\nRuns processed: ${runDirs.length}${check ? " (check only, nothing written)" : `, fields removed: ${removedTotal}`}`);
if (preserved.length && !quiet) {
    console.log("\nPreserved verbatim (evidence, never rewritten):");
    for (const group of preserved) {
        console.log(`- ${group.run}/${group.label}: ${group.absolute} absolute path(s), ${group.dates} date(s)`
            + ` across ${group.counted} file(s) -- ${group.why}`);
    }
}
if (allLeaks.length) {
    console.log(`\nRemaining absolute paths or timestamps in generated metadata: ${allLeaks.length}`);
    for (const leak of allLeaks) {
        console.log(`- [${leak.kind}] ${leak.run}/${leak.file} :: ${leak.keyPath} = ${leak.sample}`);
    }
    if (allLeaks.some((leak) => leak.file === "process_metrics.json" || leak.file === "process_metrics_summary.csv")) {
        console.log("\nprocess_metrics.json is derived, so anything left in it is fixed by regenerating rather than"
            + " stripping: run `node scripts/analyze_cline_run.js --all` (older metrics kept tool paths and terminal"
            + " command arguments verbatim; the current analyzer relativizes both).");
    }
    process.exit(1);
}
console.log("No absolute path or timestamp remains in the generated run metadata"
    + " (allowed: Cline's epoch-derived task id, which joins a run to its raw logs).");
