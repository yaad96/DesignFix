#!/usr/bin/env node
"use strict";

const {
    fs, path, parseArgs, die, positiveInteger, sanitizeComponent, normalizeText,
    normalizePath, sha256Text, writeJson, readJson, defaultDataRoot, tryGit,
    discoverClineStorageDirs, findTaskDirs, maxMtimeRecursive, walkFiles,
    flattenStrings, collectNumericFields, compareWorkspaceToBaseline, looksBinary,
} = require("./cline_common");

const RULE_RE = /designfix_rule_id\s*:\s*([A-Za-z0-9._-]+)/i;
const RUN_RE = /designfix_run_id\s*:\s*0*(\d+)/i;

function help() {
    process.stdout.write(`
Collect the newest completed Cline task for a reserved run and fill
cline_data/rule_<id>/run_<NN>/ with the Cline logs, a normalized conversation,
usage observations, and workspace changes.

The prompt carries no experiment marker, so identify the run explicitly with
--rule and --run. The collector selects the newest completed repair task and
verifies its prompt matches the reserved run's prompt before writing anything.

Usage:
  node scripts/collect_cline_task.js --rule=<id> --run=<N> [options]

Common options:
  --rule=<id>                 Rule of the reserved run to collect. Required
                              unless the task still carries a legacy marker.
  --run=<N>                   Reserved run number to collect. Required unless
                              the task still carries a legacy marker.
  --cline-storage=<path>      Cline extension global-storage directory.
                              Usually auto-discovered.
  --cline-task-dir=<path>     Directly use a known Cline task folder.
  --data-root=<path>          Default: sibling cline_data next to client repo.
  --project-root=<path>       Override the project path saved by the generator.
  --allow-incomplete          Collect even without completion evidence.
  --allow-prompt-mismatch     Proceed even if the task prompt does not match the
                              reserved prompt (use only after manual review).
  --overwrite                 Replace already-collected data for the run.
  --include-checkpoints       Copy checkpoint/cache folders too (can be large).
  --list                      List matching task candidates without collecting.
  --help

If auto-discovery fails on Windows, pass for example:
  --cline-storage="%APPDATA%\\Code\\User\\globalStorage\\saoudrizwan.claude-dev"
`.trimStart());
}

const { flags, positionals } = parseArgs(process.argv.slice(2));
if (flags.help) { help(); process.exit(0); }
if (positionals.length) die(`Unexpected positional arguments: ${positionals.join(", ")}`);

const expectedRule = flags.rule && flags.rule !== true ? String(flags.rule) : null;
const expectedRun = flags.run !== undefined && flags.run !== true ? positiveInteger(flags.run, "--run") : null;
const dataRoot = path.resolve(flags["data-root"] && flags["data-root"] !== true ? String(flags["data-root"]) : defaultDataRoot());

function taskTextFiles(taskDir) {
    const excluded = new Set([".git", "node_modules", "checkpoints", "cache", "browser", "screenshots"]);
    return walkFiles(taskDir, { excludedDirs: excluded })
        .filter((f) => /\.(json|jsonl|txt|md|log)$/i.test(f) || /messages|history|task|state/i.test(path.basename(f)))
        .filter((f) => {
            try { return fs.statSync(f).size <= 32 * 1024 * 1024; } catch { return false; }
        });
}

function readTaskCorpus(taskDir) {
    const files = [];
    const strings = [];
    const numericFields = [];
    let combined = "";
    for (const filePath of taskTextFiles(taskDir)) {
        let text;
        try { text = fs.readFileSync(filePath, "utf8"); } catch { continue; }
        const rel = normalizePath(path.relative(taskDir, filePath));
        files.push({ path: rel, size: Buffer.byteLength(text), sha256: sha256Text(text) });
        combined += `\n\n===== ${rel} =====\n${text}`;
        try {
            const parsed = JSON.parse(text);
            flattenStrings(parsed, strings, [rel]);
            collectNumericFields(parsed, numericFields, [rel]);
        } catch {
            strings.push({ path: rel, value: text });
        }
    }
    return { files, strings, numericFields, combined };
}

function completionEvidence(corpus) {
    const text = corpus.combined.toLowerCase();
    const patterns = [
        /"say"\s*:\s*"completion_result"/,
        /"type"\s*:\s*"completion_result"/,
        /attempt_completion/,
        /task[_ ]?completed/,
        /"completedat"\s*:/,
        /"completion_result"/,
    ];
    const hits = patterns.filter((p) => p.test(text)).map(String);
    return { completed: hits.length > 0, hits };
}

function choosePrompt(strings, ruleId, runNumber) {
    // When ruleId/runNumber are supplied (marker present) filter by them; when
    // null (marker removed) fall back to any repair-style prompt.
    const candidates = strings
        .map((s) => s.value)
        .filter((s) => typeof s === "string" && (RULE_RE.test(s) || /<<<CHECKER_OUTPUT>>>|Repair the reported violation/i.test(s)))
        .filter((s) => !ruleId || new RegExp(`designfix_rule_id\\s*:\\s*${String(ruleId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(s))
        .filter((s) => !runNumber || new RegExp(`designfix_run_id\\s*:\\s*0*${runNumber}\\b`, "i").test(s));
    candidates.sort((a, b) => {
        const score = (s) => (s.includes("<<<CHECKER_OUTPUT>>>") ? 100000 : 0) + (s.includes("Repair the reported violation") ? 50000 : 0) + s.length;
        return score(b) - score(a);
    });
    return candidates[0] ? normalizeText(candidates[0]) : "";
}

function collapseWhitespace(text) {
    return String(text).replace(/\s+/g, " ").trim();
}

// Confirm the selected Cline task actually ran this run's reserved prompt. The
// prompt carries no experiment marker, so --rule/--run only target the run
// folder; this containment check (all whitespace collapsed, so it tolerates
// Cline's <task> wrapper and appended environment details) is what verifies the
// mapping and catches paste errors or same-rule trial mixups.
function verifyPromptMatch(reservedPrompt, taskCombinedText) {
    const needle = collapseWhitespace(reservedPrompt);
    const haystack = collapseWhitespace(taskCombinedText);
    if (!needle) return { verified: false, method: "containment", reason: "reserved prompt is empty or missing" };
    if (haystack.includes(needle)) return { verified: true, method: "containment" };
    return { verified: false, method: "containment", reason: "reserved prompt text was not found in the Cline task log" };
}

// Non-fatal integrity check: does prompt.txt still hash to the value recorded at
// generation time? Tolerates line-ending variation so it does not false-alarm.
function reservedPromptIntegrityOk(reservedPrompt, recordedSha) {
    if (!recordedSha || !reservedPrompt) return true;
    const variants = [
        reservedPrompt.replace(/\n+$/, ""),
        reservedPrompt.replace(/\r\n/g, "\n").replace(/\n+$/, ""),
    ];
    return variants.some((v) => sha256Text(v) === recordedSha);
}

function summarizeUsage(fields) {
    // Sum per-request token/cost fields into totals. Cline records the same
    // numbers in more than one log file (api_conversation_history.json and
    // ui_messages.json), so restrict summation to a single source file to
    // avoid double counting. Prefer api_conversation_history.json.
    const bySource = new Map();
    for (const field of fields) {
        const source = String(field.path).split(".")[0];
        if (!bySource.has(source)) bySource.set(source, []);
        bySource.get(source).push(field);
    }
    const preferred = [...bySource.keys()].sort((a, b) => {
        const rank = (s) => (/api_conversation_history/i.test(s) ? 2 : /ui_messages/i.test(s) ? 1 : 0);
        return rank(b) - rank(a);
    })[0];
    const chosen = preferred ? bySource.get(preferred) : [];

    const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
    const counts = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
    for (const field of chosen) {
        const key = String(field.key);
        if (/^(prompt|tokensin|input)$/i.test(key)) { totals.inputTokens += field.value; counts.inputTokens += 1; }
        else if (/^(completion|tokensout|output)$/i.test(key)) { totals.outputTokens += field.value; counts.outputTokens += 1; }
        else if (/^(cached|cachereads)$/i.test(key)) { totals.cachedTokens += field.value; counts.cachedTokens += 1; }
        else if (/^cost$/i.test(key)) { totals.cost += field.value; counts.cost += 1; }
    }
    return {
        note: "Totals summed from a single Cline log file to avoid double counting. Input=prompt/tokensIn, Output=completion/tokensOut, Cached=cached/cacheReads.",
        sourceFile: preferred || null,
        requestCount: Math.max(counts.inputTokens, counts.outputTokens, counts.cost),
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        totalTokens: totals.inputTokens + totals.outputTokens,
        cachedTokens: totals.cachedTokens,
        cost: totals.cost,
    };
}

function conversationText(strings) {
    const useful = strings
        .filter((entry) => entry.value && entry.value.trim())
        .filter((entry) => /message|content|text|ask|say|prompt|response/i.test(entry.path))
        .map((entry) => ({ path: entry.path, value: normalizeText(entry.value) }))
        .filter((entry) => entry.value.length >= 2)
        .filter((entry, index, arr) => arr.findIndex((x) => x.value === entry.value) === index);
    return useful.map((entry) => `--- ${entry.path} ---\n${entry.value}`).join("\n\n");
}

function buildCandidate(taskDir) {
    const corpus = readTaskCorpus(taskDir);
    const ruleMatch = RULE_RE.exec(corpus.combined);
    const runMatch = RUN_RE.exec(corpus.combined);
    const hasMarker = Boolean(ruleMatch);
    // The marker is optional. Without it, identify the run from --rule/--run
    // flags and only consider tasks that look like a repair task, so unrelated
    // Cline history is not swept up.
    const looksLikeRepair = /<<<CHECKER_OUTPUT>>>|Repair the reported violation/i.test(corpus.combined);
    if (!hasMarker && !looksLikeRepair) return null;
    const ruleId = ruleMatch ? ruleMatch[1] : expectedRule;
    const runNumber = runMatch ? Number(runMatch[1]) : expectedRun;
    if (ruleId == null || runNumber == null) return null;
    const completion = completionEvidence(corpus);
    return {
        taskDir,
        taskId: path.basename(taskDir),
        ruleId,
        runNumber,
        modifiedAtMs: maxMtimeRecursive(taskDir),
        modifiedAt: new Date(maxMtimeRecursive(taskDir)).toISOString(),
        completion,
        corpus,
        prompt: choosePrompt(corpus.strings, hasMarker ? ruleId : null, hasMarker ? runNumber : null),
    };
}

let taskDirs;
if (flags["cline-task-dir"] && flags["cline-task-dir"] !== true) {
    const direct = path.resolve(String(flags["cline-task-dir"]));
    if (!fs.existsSync(direct)) die(`Cline task directory not found: ${direct}`);
    taskDirs = [direct];
} else {
    const storageDirs = discoverClineStorageDirs(flags["cline-storage"]);
    if (!storageDirs.length) {
        die("No Cline global-storage directory was found. Pass --cline-storage=<path> or --cline-task-dir=<path>.");
    }
    taskDirs = findTaskDirs(storageDirs);
}

let candidates = taskDirs.map(buildCandidate).filter(Boolean);
if (expectedRule) candidates = candidates.filter((c) => String(c.ruleId) === expectedRule);
if (expectedRun) candidates = candidates.filter((c) => c.runNumber === expectedRun);
candidates.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);

if (flags.list) {
    process.stdout.write(`${JSON.stringify(candidates.map((c) => ({
        taskDir: c.taskDir,
        taskId: c.taskId,
        ruleId: c.ruleId,
        runNumber: c.runNumber,
        modifiedAt: c.modifiedAt,
        completed: c.completion.completed,
    })), null, 2)}\n`);
    process.exit(0);
}

if (!candidates.length) die("No matching Cline task was found. If the prompt has no embedded marker, pass --rule=<id> --run=<N> (and optionally --cline-task-dir=<path>) so the task can be identified.");
let selected = candidates.find((c) => c.completion.completed);
if (!selected && flags["allow-incomplete"]) selected = candidates[0];
if (!selected) {
    die(`Found ${candidates.length} matching task(s), but none had completion evidence. Use --allow-incomplete only after manually confirming completion.`);
}
if (!selected.runNumber) die("Could not determine the run number. Pass --run=<N> (and --rule=<id>) so the collected task maps to a reserved run directory.");

const ruleIdSafe = sanitizeComponent(selected.ruleId);
const runLabel = String(selected.runNumber).padStart(2, "0");
const runDir = path.join(dataRoot, `rule_${ruleIdSafe}`, `run_${runLabel}`);
if (!fs.existsSync(runDir)) {
    die(`Reserved run directory does not exist: ${runDir}\nRun make_cline_prompt.js first with the same rule/run.`);
}
const metaPath = path.join(runDir, "meta.json");
const existingMeta = readJson(metaPath, {});
if (existingMeta.status === "collected" && !flags.overwrite) {
    die(`Run ${runDir} is already collected. Pass --overwrite to replace collection outputs.`);
}
if (existingMeta.ruleId && String(existingMeta.ruleId) !== String(selected.ruleId)) {
    die(`Rule mismatch: reserved=${existingMeta.ruleId}, Cline task=${selected.ruleId}.`);
}
if (existingMeta.runNumber && Number(existingMeta.runNumber) !== selected.runNumber) {
    die(`Run mismatch: reserved=${existingMeta.runNumber}, Cline task=${selected.runNumber}.`);
}

// Verify the selected task ran this run's reserved prompt before doing any work.
const reservedPromptPath = path.join(runDir, "prompt.txt");
const reservedPrompt = fs.existsSync(reservedPromptPath) ? fs.readFileSync(reservedPromptPath, "utf8") : "";
if (!reservedPromptIntegrityOk(reservedPrompt, existingMeta.promptSha256)) {
    console.error("Warning: prompt.txt no longer matches the promptSha256 recorded at generation; it may have been edited after the run was reserved.");
}
// Match against DECODED string values (Cline stores the prompt JSON-escaped, so
// corpus.combined has literal \\n sequences; corpus.strings holds parsed values).
const taskDecodedText = selected.corpus.strings.map((s) => s.value).join("\n");
const promptMatch = verifyPromptMatch(reservedPrompt, taskDecodedText);
if (!promptMatch.verified && !flags["allow-prompt-mismatch"]) {
    die(`Prompt verification failed for rule ${selected.ruleId} run ${runLabel}: ${promptMatch.reason}.\n`
        + `The selected task (${selected.taskId}, newest completed repair task) does not contain this run's reserved prompt.\n`
        + `Collect the correct run, or pass --allow-prompt-mismatch to override after manually confirming the task.`);
}
if (!promptMatch.verified) {
    console.error(`Warning: proceeding despite prompt mismatch (--allow-prompt-mismatch): ${promptMatch.reason}.`);
}

const rawDir = path.join(runDir, "cline_task_raw");
if (fs.existsSync(rawDir)) fs.rmSync(rawDir, { recursive: true, force: true });
fs.mkdirSync(rawDir, { recursive: true });
const includeCheckpoints = Boolean(flags["include-checkpoints"]);
const skipDirs = new Set([".git", "node_modules"]);
if (!includeCheckpoints) {
    for (const d of ["checkpoints", "cache", "browser", "screenshots"]) skipDirs.add(d);
}
const rawManifest = { copied: [], skipped: [] };
function copyTaskTree(src, dst, rel = "") {
    let entries = [];
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const source = path.join(src, entry.name);
        const relative = rel ? `${rel}/${entry.name}` : entry.name;
        const target = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            if (skipDirs.has(entry.name)) {
                rawManifest.skipped.push({ path: relative, reason: "excluded directory" });
                continue;
            }
            fs.mkdirSync(target, { recursive: true });
            copyTaskTree(source, target, relative);
        } else if (entry.isFile()) {
            const stat = fs.statSync(source);
            if (stat.size > 100 * 1024 * 1024) {
                rawManifest.skipped.push({ path: relative, reason: "file larger than 100 MB", size: stat.size });
                continue;
            }
            fs.copyFileSync(source, target);
            rawManifest.copied.push({ path: relative, size: stat.size });
        }
    }
}
copyTaskTree(selected.taskDir, rawDir);
writeJson(path.join(runDir, "raw_task_manifest.json"), rawManifest);

if (selected.prompt) fs.writeFileSync(path.join(runDir, "cline_prompt_extracted.txt"), `${selected.prompt}\n`, "utf8");
const conversation = conversationText(selected.corpus.strings);
fs.writeFileSync(path.join(runDir, "cline_conversation.txt"), `${conversation}\n`, "utf8");
writeJson(path.join(runDir, "cline_usage_fields.json"), {
    note: "All token/cost/cache numeric fields found in Cline JSON logs. Raw logs are authoritative; fields are not summed because Cline schemas may contain repeated totals.",
    fields: selected.corpus.numericFields,
});
writeJson(path.join(runDir, "cline_usage_stats.json"), summarizeUsage(selected.corpus.numericFields));
writeJson(path.join(runDir, "cline_source_files.json"), selected.corpus.files);

const projectRoot = path.resolve(flags["project-root"] && flags["project-root"] !== true
    ? String(flags["project-root"])
    : existingMeta.projectRoot || "");
if (!projectRoot || !fs.existsSync(projectRoot)) {
    die("Project root is unavailable. Pass --project-root=<path> or regenerate the reserved run with the current generator.");
}

const baselineDir = path.join(runDir, "baseline");
let changes = [];
if (fs.existsSync(path.join(baselineDir, "manifest.json"))) {
    const comparison = compareWorkspaceToBaseline(projectRoot, baselineDir);
    changes = comparison.changes;
    writeJson(path.join(runDir, "workspace_changes.json"), {
        comparedAt: new Date().toISOString(),
        changeCount: changes.length,
        changes: changes.map((c) => ({
            path: c.path,
            type: c.type,
            beforeSha256: c.before?.sha256 || null,
            afterSha256: c.after?.sha256 || null,
            beforeSize: c.before?.size ?? null,
            afterSize: c.after?.size ?? null,
        })),
    });

    const editedDir = path.join(runDir, "edited_files");
    if (fs.existsSync(editedDir)) fs.rmSync(editedDir, { recursive: true, force: true });
    fs.mkdirSync(editedDir, { recursive: true });
    let index = 0;
    for (const change of changes) {
        index += 1;
        const base = sanitizeComponent(path.basename(change.path));
        const stem = `${String(index).padStart(2, "0")}_${base}`;
        const originalPath = path.join(baselineDir, "files", ...change.path.split("/"));
        const currentPath = path.join(projectRoot, ...change.path.split("/"));
        if (fs.existsSync(originalPath)) fs.copyFileSync(originalPath, path.join(editedDir, `${stem}.original`));
        if (fs.existsSync(currentPath) && fs.statSync(currentPath).isFile()) {
            const buffer = fs.readFileSync(currentPath);
            if (!looksBinary(buffer)) fs.copyFileSync(currentPath, path.join(editedDir, `${stem}.modified`));
        }
    }
}

const gitStatus = tryGit(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
const gitDiff = tryGit(projectRoot, ["diff", "--binary", "--no-ext-diff"]);
fs.writeFileSync(path.join(runDir, "git_status_after.txt"), `${gitStatus || ""}\n`, "utf8");
fs.writeFileSync(path.join(runDir, "git_diff_after.patch"), `${gitDiff || ""}\n`, "utf8");

const collectedAt = new Date().toISOString();
const finalMeta = {
    ...existingMeta,
    status: "collected",
    collectedAt,
    clineTask: {
        taskId: selected.taskId,
        sourceDirectory: selected.taskDir,
        modifiedAt: selected.modifiedAt,
        completionEvidence: selected.completion,
        promptVerification: promptMatch,
        reservedPromptSha256: existingMeta.promptSha256 || null,
        extractedPromptSha256: selected.prompt ? sha256Text(selected.prompt) : null,
        rawFilesCopied: rawManifest.copied.length,
        rawFilesSkipped: rawManifest.skipped.length,
    },
    workspaceAfter: {
        projectRoot,
        commit: tryGit(projectRoot, ["rev-parse", "HEAD"]),
        branch: tryGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
        status: gitStatus || "",
        changedFilesAgainstBaseline: changes.map((c) => ({ path: c.path, type: c.type })),
    },
};
writeJson(metaPath, finalMeta);

console.log(`Collected Cline task: ${selected.taskId}`);
console.log(`Rule ${selected.ruleId}, run ${runLabel}`);
console.log(`Saved to: ${runDir}`);
console.log(`Workspace changes against baseline: ${changes.length}`);
