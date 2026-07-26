#!/usr/bin/env node
"use strict";

const {
    fs, path, parseArgs, die, readJson, writeJson, normalizePath, sanitizeComponent,
    defaultDataRoot,
} = require("./cline_common");

function help() {
    process.stdout.write(`
Reclaim disk by deleting the baseline source snapshot (baseline/files/) from runs
that are finished, keeping baseline/manifest.json.

The snapshot is ~98% of a run's bytes (about 52 MB and 2,300 files per run) but
only two things need the file bodies: extracting edited_files/*.original at
collection time, and using the tree as a restore reference. Everything else reads
manifest.json alone -- the workspace comparison (sha256), the analyzer's path
relativizer, and the collector's wrong-checkout check -- so the manifest is never
removed.

Usage:
  node scripts/prune_baseline_files.js --all --check
  node scripts/prune_baseline_files.js --all
  node scripts/prune_baseline_files.js --run-dir=cline_data/rule_1/run_01

Options:
  --all              Every rule_*/run_* folder under the data root.
  --run-dir=<path>   A single run folder.
  --data-root=<path> Default: sibling cline_data at the workspace root.
  --check            Report what would be deleted; delete nothing.
  --force            Prune even when a before-image is missing (see below).
  --quiet            Summary lines only.
  --help

A run is pruned only when all of these hold, because pruning is irreversible
short of re-running the task:
  1. meta.json says status "collected" -- a pending run still needs the sources.
  2. baseline/manifest.json exists and lists files -- otherwise pruning would
     leave no record of the pre-run tree at all.
  3. workspace_changes.json exists -- proof the comparison already ran.
  4. every modified/deleted file in that comparison has its edited_files/
     *.original before-image on disk. Without this, the pre-run content of a file
     the agent changed would be gone for good. --force overrides.

Pruned runs get "baselineFilesPruned": true in meta.json so the loss is auditable
and so collect_cline_task.js can warn if you later re-collect the same run.
`.trimStart());
}

// Mirrors the stem collect_cline_task.js builds for edited_files entries.
function originalPathFor(runDir, changePath, index) {
    const stem = `${String(index).padStart(2, "0")}_${sanitizeComponent(path.basename(changePath))}`;
    return path.join(runDir, "edited_files", `${stem}.original`);
}

function directorySize(dir) {
    let bytes = 0;
    let files = 0;
    if (!fs.existsSync(dir)) return { bytes, files };
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const inner = directorySize(full);
            bytes += inner.bytes;
            files += inner.files;
        } else if (entry.isFile()) {
            bytes += fs.statSync(full).size;
            files += 1;
        }
    }
    return { bytes, files };
}

function assess(runDir, force) {
    const meta = readJson(path.join(runDir, "meta.json"), null);
    if (!meta) return { skip: "no meta.json" };
    if (meta.status !== "collected") return { skip: `status "${meta.status}" (not collected)` };

    const filesDir = path.join(runDir, "baseline", "files");
    if (!fs.existsSync(filesDir)) return { skip: "baseline/files already absent" };

    const manifest = readJson(path.join(runDir, "baseline", "manifest.json"), null);
    if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) {
        return { refuse: "baseline/manifest.json is missing or empty, so the pre-run tree would leave no record" };
    }
    const changes = readJson(path.join(runDir, "workspace_changes.json"), null);
    if (!changes || !Array.isArray(changes.changes)) {
        return { refuse: "workspace_changes.json is missing, so the baseline comparison never ran" };
    }

    const missing = [];
    changes.changes.forEach((change, index) => {
        if (change.type !== "modified" && change.type !== "deleted") return;
        if (!fs.existsSync(originalPathFor(runDir, change.path, index + 1))) missing.push(change.path);
    });
    if (missing.length && !force) {
        return { refuse: `no before-image for ${missing.length} changed file(s): ${missing.slice(0, 3).join(", ")}` };
    }

    const size = directorySize(filesDir);
    return { prune: true, filesDir, size, missing, manifestCount: manifest.files.length };
}

const { flags, positionals } = parseArgs(process.argv.slice(2));
if (flags.help) { help(); process.exit(0); }
if (positionals.length) die(`Unexpected positional arguments: ${positionals.join(", ")}`);
const check = Boolean(flags.check);
const force = Boolean(flags.force);
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
    runDirs = [];
    if (!fs.existsSync(dataRoot)) die(`Data root not found: ${dataRoot}`);
    for (const ruleEntry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
        if (!ruleEntry.isDirectory() || !/^rule_/.test(ruleEntry.name)) continue;
        const ruleDir = path.join(dataRoot, ruleEntry.name);
        for (const runEntry of fs.readdirSync(ruleDir, { withFileTypes: true })) {
            if (runEntry.isDirectory() && /^run_\d+$/.test(runEntry.name)) runDirs.push(path.join(ruleDir, runEntry.name));
        }
    }
    if (!runDirs.length) die(`No rule_*/run_* folders found under ${dataRoot}`);
} else {
    help();
    die("Pass --all or --run-dir=<path>.");
}

let prunedRuns = 0;
let prunedBytes = 0;
let prunedFiles = 0;
const refusals = [];
const skips = [];

for (const runDir of runDirs.sort()) {
    const label = normalizePath(path.relative(dataRoot, runDir)) || runDir;
    const verdict = assess(runDir, force);
    if (verdict.skip) { skips.push(`${label}: ${verdict.skip}`); continue; }
    if (verdict.refuse) { refusals.push(`${label}: ${verdict.refuse}`); continue; }

    const mb = (verdict.size.bytes / 1048576).toFixed(1);
    if (!quiet) {
        console.log(`${label}: ${check ? "would free" : "freed"} ${mb} MB / ${verdict.size.files} file(s)`
            + `; manifest.json retained (${verdict.manifestCount} entries)`
            + (verdict.missing.length ? `; FORCED past ${verdict.missing.length} missing before-image(s)` : ""));
    }
    if (!check) {
        fs.rmSync(verdict.filesDir, { recursive: true, force: true });
        const metaPath = path.join(runDir, "meta.json");
        const meta = readJson(metaPath, null);
        if (meta) {
            meta.baselineFilesPruned = true;
            writeJson(metaPath, meta);
        }
    }
    prunedRuns += 1;
    prunedBytes += verdict.size.bytes;
    prunedFiles += verdict.size.files;
}

console.log(`\n${check ? "Would prune" : "Pruned"} ${prunedRuns} run(s): `
    + `${(prunedBytes / 1048576).toFixed(1)} MB across ${prunedFiles} file(s)${check ? " (nothing written)" : ""}`);
if (refusals.length) {
    console.log(`\nRefused ${refusals.length} run(s) -- pruning would lose the only copy of pre-run content:`);
    for (const reason of refusals) console.log(`- ${reason}`);
    console.log("Fix the underlying gap, or pass --force if the loss is acceptable.");
}
if (skips.length && !quiet) {
    console.log(`\nSkipped ${skips.length} run(s):`);
    for (const reason of skips) console.log(`- ${reason}`);
}
process.exit(refusals.length ? 1 : 0);
