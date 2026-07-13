#!/usr/bin/env node
"use strict";

const {
    fs, path, parseArgs, die, readJson, writeJson, normalizePath, defaultDataRoot,
} = require("./cline_common");

function help() {
    process.stdout.write(`
Compute per-run process metrics from the raw Cline logs saved by
collect_cline_task.js (cline_task_raw/). Writes process_metrics.json into each
run folder and, with --all, a process_metrics_summary.csv at the data root.

Usage:
  node scripts/analyze_cline_run.js --run-dir=cline_data/rule_11/run_01
  node scripts/analyze_cline_run.js --all [--data-root=<path>]

Options:
  --run-dir=<path>   Analyze a single collected run folder.
  --all              Analyze every collected run under the data root.
  --data-root=<path> Default: sibling cline_data next to the repo folders.
  --quiet            Do not print the per-run summary table.
  --help

Metrics are derived from api_conversation_history.json (tool calls and their
results, per-request token/cost), ui_messages.json (wall-clock timestamps,
completion events), task_metadata.json (actual model), meta.json (violation
site), and workspace_changes.json (on-disk ground truth for edits).
`.trimStart());
}

// Tools whose invocation Cline encodes as XML blocks in assistant text.
const PATH_TOOLS = new Set([
    "read_file", "write_to_file", "replace_in_file",
    "search_files", "list_files", "list_code_definition_names",
]);
const EDIT_TOOLS = new Set(["write_to_file", "replace_in_file"]);
const DIR_TOOLS = new Set(["search_files", "list_files", "list_code_definition_names"]);
const ALL_TOOLS = [
    ...PATH_TOOLS,
    "execute_command", "browser_action", "use_mcp_tool", "access_mcp_resource",
    "ask_followup_question", "attempt_completion", "new_task", "plan_mode_respond",
];
const TOOL_BLOCK_RE = new RegExp(
    `<(${ALL_TOOLS.join("|")})>([\\s\\S]*?)</\\1>`, "g",
);
const RESULT_HEADER_RE = /^\[([a-z_]+)(?: for '([^']*)')?\] Result:/m;

function messageText(message) {
    return (message && Array.isArray(message.content) ? message.content : [])
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("\n");
}

function innerTag(block, tag) {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
    return m ? m[1].trim() : null;
}

function classifyResult(resultText) {
    if (resultText === null) return "no-result";
    const head = resultText.slice(0, 400);
    if (/The user denied this operation/i.test(head)) return "denied";
    if (/The tool execution failed/i.test(head)) return "failed";
    if (/^<error>/m.test(head)) return "failed";
    return "ok";
}

function normalizeRel(p, projectRoot) {
    let value = normalizePath(String(p || "")).trim();
    if (projectRoot) {
        const rootNorm = normalizePath(projectRoot).replace(/\/+$/, "");
        if (value.toLowerCase().startsWith(`${rootNorm.toLowerCase()}/`)) {
            value = value.slice(rootNorm.length + 1);
        }
    }
    return value.replace(/^\.\//, "");
}

function analyzeRun(runDir, quiet) {
    const meta = readJson(path.join(runDir, "meta.json"));
    if (!meta) return { skipped: `no meta.json in ${runDir}` };
    if (meta.status !== "collected") return { skipped: `status "${meta.status}" (not collected): ${runDir}` };

    const rawDir = path.join(runDir, "cline_task_raw");
    const api = readJson(path.join(rawDir, "api_conversation_history.json"));
    const ui = readJson(path.join(rawDir, "ui_messages.json"));
    const taskMeta = readJson(path.join(rawDir, "task_metadata.json"), {});
    const workspaceChanges = readJson(path.join(runDir, "workspace_changes.json"), null);
    if (!Array.isArray(api) || !Array.isArray(ui)) {
        return { skipped: `missing/invalid raw logs in ${rawDir}` };
    }

    const warnings = [];
    const projectRoot = meta.projectRoot || "";
    const violationRel = normalizeRel(meta.violationFileRelativePath || "", projectRoot);
    const violationKey = violationRel.toLowerCase();

    // ---- Tool interactions: pair each assistant tool block with the result
    // in the next user message ("[<tool> for '<path>'] Result:").
    const interactions = [];
    for (let i = 0; i < api.length; i += 1) {
        const message = api[i];
        if (message.role !== "assistant") continue;
        const text = messageText(message);
        const nextUser = api[i + 1] && api[i + 1].role === "user" ? api[i + 1] : null;
        const nextText = nextUser ? messageText(nextUser) : null;
        TOOL_BLOCK_RE.lastIndex = 0;
        let match;
        while ((match = TOOL_BLOCK_RE.exec(text)) !== null) {
            const [, tool, block] = match;
            const rawPath = PATH_TOOLS.has(tool) ? innerTag(block, "path") : null;
            const command = tool === "execute_command" ? innerTag(block, "command") : null;
            let resultText = null;
            if (nextText !== null) {
                const header = RESULT_HEADER_RE.exec(nextText);
                if (header && header[1] === tool) {
                    resultText = nextText.slice(header.index);
                } else if (header) {
                    resultText = nextText.slice(header.index);
                    warnings.push(`result header tool "${header[1]}" != invoked tool "${tool}" (message ${i})`);
                }
            }
            interactions.push({
                messageIndex: i,
                ts: message.ts ?? null,
                resultTs: nextUser ? nextUser.ts ?? null : null,
                tool,
                path: rawPath ? normalizeRel(rawPath, projectRoot) : null,
                command: command || undefined,
                result: classifyResult(resultText),
            });
        }
    }

    const byResult = (tools, result) => interactions.filter(
        (x) => tools.has(x.tool) && x.result === result,
    );
    const uniquePaths = (list) => {
        const seen = new Map();
        for (const x of list) if (x.path && !seen.has(x.path.toLowerCase())) seen.set(x.path.toLowerCase(), x.path);
        return [...seen.values()];
    };

    const readsOk = byResult(new Set(["read_file"]), "ok");
    const readsFailed = interactions.filter((x) => x.tool === "read_file" && x.result !== "ok");
    const editsOk = byResult(EDIT_TOOLS, "ok");
    const editsFailedOrDenied = interactions.filter((x) => EDIT_TOOLS.has(x.tool) && x.result !== "ok");
    const searches = interactions.filter((x) => DIR_TOOLS.has(x.tool));
    const terminal = interactions.filter((x) => x.tool === "execute_command");

    const filesReadOk = uniquePaths(readsOk);
    const filesEditedByTool = uniquePaths(editsOk);
    const readsBeyondSite = filesReadOk.filter((p) => p.toLowerCase() !== violationKey);
    const editsBeyondSite = filesEditedByTool.filter((p) => p.toLowerCase() !== violationKey);

    // ---- Ground truth from the baseline comparison, when present.
    const changedOnDisk = workspaceChanges && Array.isArray(workspaceChanges.changes)
        ? workspaceChanges.changes.map((c) => ({ path: c.path, type: c.type }))
        : null;
    if (changedOnDisk) {
        const toolSet = new Set(filesEditedByTool.map((p) => p.toLowerCase()));
        const diskSet = new Set(changedOnDisk.map((c) => c.path.toLowerCase()));
        for (const p of diskSet) if (!toolSet.has(p)) warnings.push(`file changed on disk but not via a logged edit tool: ${p}`);
        for (const p of toolSet) if (!diskSet.has(p)) warnings.push(`edit tool succeeded but file unchanged against baseline: ${p}`);
    }
    if (terminal.length) {
        warnings.push(`${terminal.length} terminal command(s) executed; verify none modified files outside the baseline comparison`);
    }

    // ---- Timing (ui_messages timestamps are the task's own clock).
    const uiTs = ui.map((u) => u.ts).filter((t) => Number.isFinite(t));
    const startTs = uiTs.length ? Math.min(...uiTs) : null;
    const endTs = uiTs.length ? Math.max(...uiTs) : null;
    const firstEdit = editsOk[0] || null;
    const firstEditTs = firstEdit ? (firstEdit.resultTs ?? firstEdit.ts) : null;

    // ---- Tokens and cost from per-request assistant metrics.
    const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
    for (const message of api) {
        if (message.role !== "assistant" || !message.metrics) continue;
        const tokens = message.metrics.tokens || {};
        usage.requests += 1;
        usage.inputTokens += tokens.prompt || 0;
        usage.outputTokens += tokens.completion || 0;
        usage.cachedTokens += tokens.cached || 0;
        usage.cost += message.metrics.cost || 0;
    }

    // ---- Completion: an actual attempt_completion invocation, not a mention.
    const completionInvocation = interactions.find((x) => x.tool === "attempt_completion") || null;
    const completionUiEvent = ui.some((u) => (u.say || u.ask) === "completion_result");

    // ---- Actual model versus the model claimed at generation time.
    const modelsUsed = [...new Set(
        (Array.isArray(taskMeta.model_usage) ? taskMeta.model_usage : [])
            .map((m) => `${m.model_provider_id || "?"}/${m.model_id || "?"}`),
    )];
    const actualModelIds = [...new Set(
        (Array.isArray(taskMeta.model_usage) ? taskMeta.model_usage : []).map((m) => m.model_id).filter(Boolean),
    )];
    if (meta.model && actualModelIds.length && !actualModelIds.includes(meta.model)) {
        warnings.push(`claimed model "${meta.model}" != actual model_id(s) [${actualModelIds.join(", ")}] from task_metadata.json`);
    }

    const metrics = {
        schemaVersion: 1,
        analyzedAt: new Date().toISOString(),
        ruleId: meta.ruleId,
        runLabel: meta.runLabel,
        clineTaskId: meta.clineTask ? meta.clineTask.taskId : null,
        model: { claimed: meta.model || null, actual: modelsUsed },
        timing: {
            startTs,
            endTs,
            durationSeconds: startTs !== null && endTs !== null ? Math.round((endTs - startTs) / 1000) : null,
            timeToFirstEditSeconds: startTs !== null && firstEditTs !== null
                ? Math.round((firstEditTs - startTs) / 1000)
                : null,
        },
        turns: { apiRequests: usage.requests, assistantMessages: api.filter((m) => m.role === "assistant").length },
        tools: {
            totalToolCalls: interactions.length,
            byTool: interactions.reduce((acc, x) => { acc[x.tool] = (acc[x.tool] || 0) + 1; return acc; }, {}),
            failedOrDenied: interactions.filter((x) => x.result === "failed" || x.result === "denied").length,
        },
        navigation: {
            violationFile: violationRel || null,
            filesReadOk,
            fileReadFailures: readsFailed.map((x) => ({ path: x.path, result: x.result })),
            searchCalls: searches.map((x) => ({ tool: x.tool, target: x.path })),
            terminalCommands: terminal.map((x) => ({ command: x.command || "", result: x.result })),
            filesReadBeyondViolationSite: readsBeyondSite,
            uniqueFilesReadOk: filesReadOk.length,
            uniqueFilesReadBeyondViolationSite: readsBeyondSite.length,
        },
        edits: {
            filesEditedByTool,
            filesEditedBeyondViolationSite: editsBeyondSite,
            failedOrDeniedEditAttempts: editsFailedOrDenied.length,
            changedFilesOnDisk: changedOnDisk,
        },
        usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens, cost: Number(usage.cost.toFixed(6)) },
        completion: {
            attemptCompletionInvoked: Boolean(completionInvocation),
            completionResultUiEvent: completionUiEvent,
        },
        warnings,
    };

    writeJson(path.join(runDir, "process_metrics.json"), metrics);
    if (!quiet) {
        const t = metrics.timing;
        console.log([
            `rule ${metrics.ruleId} ${metrics.runLabel}`.padEnd(16),
            `dur ${t.durationSeconds ?? "?"}s`.padEnd(10),
            `firstEdit ${t.timeToFirstEditSeconds ?? "-"}s`.padEnd(15),
            `req ${usage.requests}`.padEnd(8),
            `tools ${metrics.tools.totalToolCalls}`.padEnd(10),
            `readOk ${filesReadOk.length}(+${readsBeyondSite.length} beyond)`.padEnd(20),
            `edits ${filesEditedByTool.length}`.padEnd(9),
            `$${metrics.usage.cost}`,
            warnings.length ? `WARN(${warnings.length})` : "",
        ].join(" "));
    }
    return { metrics };
}

function csvEscape(value) {
    const s = String(value ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const { flags, positionals } = parseArgs(process.argv.slice(2));
if (flags.help) { help(); process.exit(0); }
if (positionals.length) die(`Unexpected positional arguments: ${positionals.join(", ")}`);
const quiet = Boolean(flags.quiet);

if (flags["run-dir"] && flags["run-dir"] !== true) {
    const runDir = path.resolve(String(flags["run-dir"]));
    if (!fs.existsSync(runDir)) die(`Run directory not found: ${runDir}`);
    const { metrics, skipped } = analyzeRun(runDir, quiet);
    if (skipped) die(skipped);
    console.log(`Wrote ${path.join(runDir, "process_metrics.json")}`);
    if (metrics.warnings.length) console.log(`Warnings:\n- ${metrics.warnings.join("\n- ")}`);
} else if (flags.all) {
    const dataRoot = path.resolve(flags["data-root"] && flags["data-root"] !== true
        ? String(flags["data-root"])
        : defaultDataRoot());
    if (!fs.existsSync(dataRoot)) die(`Data root not found: ${dataRoot}`);
    const rows = [];
    const skips = [];
    for (const ruleEntry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
        if (!ruleEntry.isDirectory() || !/^rule_/.test(ruleEntry.name)) continue;
        const ruleDir = path.join(dataRoot, ruleEntry.name);
        for (const runEntry of fs.readdirSync(ruleDir, { withFileTypes: true })) {
            if (!runEntry.isDirectory() || !/^run_\d+$/.test(runEntry.name)) continue;
            const { metrics, skipped } = analyzeRun(path.join(ruleDir, runEntry.name), quiet);
            if (skipped) { skips.push(skipped); continue; }
            rows.push(metrics);
        }
    }
    const header = [
        "ruleId", "run", "clineTaskId", "modelActual", "durationSeconds", "timeToFirstEditSeconds",
        "apiRequests", "toolCalls", "toolFailures", "filesReadOk", "filesReadBeyondSite",
        "searchCalls", "terminalCommands", "filesEdited", "filesEditedBeyondSite",
        "changedFilesOnDisk", "inputTokens", "outputTokens", "cachedTokens", "costUsd",
        "attemptCompletionInvoked", "warnings",
    ];
    const lines = [header.join(",")];
    for (const m of rows) {
        lines.push([
            m.ruleId, m.runLabel, m.clineTaskId, m.model.actual.join(";"),
            m.timing.durationSeconds, m.timing.timeToFirstEditSeconds,
            m.turns.apiRequests, m.tools.totalToolCalls, m.tools.failedOrDenied,
            m.navigation.uniqueFilesReadOk, m.navigation.uniqueFilesReadBeyondViolationSite,
            m.navigation.searchCalls.length, m.navigation.terminalCommands.length,
            m.edits.filesEditedByTool.length, m.edits.filesEditedBeyondViolationSite.length,
            m.edits.changedFilesOnDisk ? m.edits.changedFilesOnDisk.length : "",
            m.usage.inputTokens, m.usage.outputTokens, m.usage.cachedTokens, m.usage.cost,
            m.completion.attemptCompletionInvoked, m.warnings.join(" | "),
        ].map(csvEscape).join(","));
    }
    const csvPath = path.join(dataRoot, "process_metrics_summary.csv");
    fs.writeFileSync(csvPath, `${lines.join("\n")}\n`, "utf8");
    console.log(`\nAnalyzed ${rows.length} run(s). Summary: ${csvPath}`);
    if (skips.length) console.log(`Skipped:\n- ${skips.join("\n- ")}`);
} else {
    help();
    die("Pass --run-dir=<path> or --all.");
}
