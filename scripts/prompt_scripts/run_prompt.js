#!/usr/bin/env node
"use strict";

// Send a generated prompt to the OpenAI API and record the response.
//
// The key is read from DesignFix-client/.env (OPENAI_API_KEY), the same file the
// dev proxy reads, so it is never passed on the command line and never lands in
// the results.
//
// Results are filed by the dimensions of the sweep:
//
//   <out-dir>/prompt_<id>/model-<label>/temp_<value>/rule_<nn>/violation_<nn>/
//       prompt.txt      the prompt, identical for every run here
//       run_<nn>.json   one response per run
//
// Reruns top up to --trials rather than repeating work, so an interrupted sweep
// resumes by rerunning the same command.
//
// The Final variant runs both calls: Call A at the requested temperature, then
// Call B built from the actual Call A answer, matching suggestFix.js.

const {
    fs, path, parseArgs, die, requiredString, positiveInteger, sanitizeComponent,
    readJson, writeJson, resolveWorkspaceRoot,
} = require("../cline_common");
const { loadContext, SWEEP } = require("./prompt_common");
const { SPEC: FINAL_SPEC, TEMPERATURE_B, buildCallA, buildCallB } = require("./final_prompt");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ENV_FILE = path.resolve(__dirname, "..", "..", "DesignFix-client", ".env");
const MAX_ATTEMPTS = 3;

// Each variant writes into its own <out-dir>/prompt_<nn>/ folder, numbered in
// the order RQ1 introduces them: the baseline first, then Prompts 1 to 5, then
// the Final two-step prompt. `final` has no module entry; its spec and builders
// come from final_prompt.js because it is two calls rather than one.
const VARIANTS = {
    baseline: { dir: "prompt_00", module: "./make_prompt_baseline" },
    prompt1: { dir: "prompt_01", module: "./make_prompt_1" },
    prompt2: { dir: "prompt_02", module: "./make_prompt_2" },
    prompt3: { dir: "prompt_03", module: "./make_prompt_3" },
    prompt4: { dir: "prompt_04", module: "./make_prompt_4" },
    prompt5: { dir: "prompt_05", module: "./make_prompt_5" },
    final: { dir: "prompt_final", module: null },
};

// Keeps one decimal on a whole number so the folder reads temp_1.0, matching
// temp_0.5 and temp_0.75. String(1.0) would otherwise give "1".
const formatTemperature = (temperature) => (Number.isInteger(temperature) ? `${temperature}.0` : String(temperature));

function help() {
    process.stdout.write(`
Send a prompt variant to the OpenAI API and record the response.

Usage:
  node scripts/prompt_scripts/run_prompt.js --variant=prompt3 --rule=9 \\
    --project-root="<path>" --violation-file="<path>" \\
    --model=gpt-4o-2024-11-20 --temperature=0.5 --trials=5

Required:
  --variant=<name>         One of: ${Object.keys(VARIANTS).join(", ")}.
  --rule, --project-root, --violation-file
                           As for the prompt scripts.

Optional:
  --index=<n>              Which violation within that file (default 1).
  --model=<id>             One of: ${SWEEP.models.map((m) => m.id).join(", ")}.
                           Default ${SWEEP.models[1].id}.
  --temperature=<n>        One of: ${SWEEP.temperatures.map(formatTemperature).join(", ")}. Default 0.5.
                           For final this is Call A's; Call B is pinned at
                           ${TEMPERATURE_B}, as in suggestFix.js.
  --trials=<n>             How many runs this violation should end up with
                           (default 1). Existing runs count toward it.
  --out-dir=<path>         Default <workspace-root>/rq1.
  --overwrite              Add --trials more runs regardless of what exists.
  --dry-run                Build and record nothing; print what would be sent.
  --help

Output:
  <out-dir>/prompt_<id>/model-<label>/temp_<value>/rule_<nn>/violation_<nn>/
      prompt.txt      the prompt, identical for every run here
      run_<nn>.json   one response per run

  prompt_<id>     ${Object.entries(VARIANTS).map(([name, v]) => `${v.dir}=${name}`).join(", ")}
  model-<label>   ${SWEEP.models.map((m) => `model-${m.label}=${m.id}`).join(", ")}
  temp_<value>    ${SWEEP.temperatures.map((t) => `temp_${formatTemperature(t)}`).join(", ")}
  violation_<nn>  position among the rule's violations, in checker order;
                  --list-violations prints the mapping

The API key is read from DesignFix-client/.env. Set OPENAI_API_KEY in the
environment to override it.

Only the Final variant's Call B requests JSON response format, matching
suggestFix.js. Prompts 3 to 5 ask for JSON in words alone, so the format
deviations RQ1 reports remain observable rather than being suppressed by the API.
`.trimStart());
}

/** Mirrors readApiKey in DesignFix-client/src/setupProxy.js. */
function readApiKey() {
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
    let contents;
    try {
        contents = fs.readFileSync(ENV_FILE, "utf8");
    } catch {
        die(`No API key. Add an OPENAI_API_KEY=... line to ${ENV_FILE}, or set OPENAI_API_KEY.`);
    }
    for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1 || line.slice(0, eq).trim() !== "OPENAI_API_KEY") continue;
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (value.trim()) return value.trim();
    }
    return die(`No OPENAI_API_KEY line in ${ENV_FILE}.`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One chat completion, with the same retry shape suggestFix.js uses: three
 * attempts, longer backoff on 429 so throttling is not made worse.
 */
async function complete({ apiKey, model, temperature, prompt, jsonMode }) {
    const body = {
        model,
        temperature,
        messages: [{ role: "user", content: prompt }],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    };
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        let response;
        try {
            response = await fetch(OPENAI_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify(body),
            });
        } catch (error) {
            lastError = error.message;
            await sleep(1000 * attempt);
            continue;
        }
        if (response.ok) {
            const json = await response.json();
            const choice = json.choices[0];
            return {
                text: choice.message.content,
                finishReason: choice.finish_reason,
                usage: json.usage || {},
            };
        }
        lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
        if (attempt < MAX_ATTEMPTS) {
            await sleep(response.status === 429 ? 5000 * attempt : 1000 * attempt);
        }
    }
    throw new Error(`OpenAI request failed after ${MAX_ATTEMPTS} attempts. ${lastError}`);
}

const pad2 = (value) => String(value).padStart(2, "0");

// Model and temperature folders name the condition itself rather than an index,
// because which snapshot and which temperature produced a result is the
// comparison RQ1 makes and should be readable straight off the path. Anything
// outside the sweep is rejected rather than filed somewhere arbitrary.
function modelDir(model) {
    const entry = SWEEP.models.find((candidate) => candidate.id === model);
    if (!entry) die(`--model=${model} is not in the sweep. Use one of: ${SWEEP.models.map((m) => m.id).join(", ")}.`);
    return `model-${entry.label}`;
}

function temperatureDir(temperature) {
    if (!SWEEP.temperatures.includes(temperature)) {
        die(`--temperature=${temperature} is not in the sweep. `
            + `Use one of: ${SWEEP.temperatures.map(formatTemperature).join(", ")}.`);
    }
    return `temp_${formatTemperature(temperature)}`;
}

const ruleDir = (ruleIndex) => `rule_${pad2(sanitizeComponent(ruleIndex))}`;

/**
 * Runs already recorded in this violation folder, and the next free run number.
 * Reading the folder is the whole resume mechanism: a run file exists only after
 * its request came back, so an interrupted sweep resumes by rerunning the same
 * command.
 */
function scanRuns(dir) {
    if (!fs.existsSync(dir)) return { completed: 0, nextRun: 1 };
    let highest = 0;
    let completed = 0;
    for (const name of fs.readdirSync(dir)) {
        const match = /^run_(\d+)\.json$/.exec(name);
        if (!match) continue;
        highest = Math.max(highest, Number(match[1]));
        const record = readJson(path.join(dir, name), null);
        if (record && !record.error) completed += 1;
    }
    return { completed, nextRun: highest + 1 };
}

async function main() {
    const { flags, positionals } = parseArgs(process.argv.slice(2));
    if (flags.help) { help(); process.exit(0); }
    if (positionals.length) die(`Unexpected positional arguments: ${positionals.join(", ")}`);

    const variant = requiredString(flags.variant, "--variant=<name>");
    const entry = VARIANTS[variant];
    if (!entry) die(`Unknown --variant=${variant}. Use one of: ${Object.keys(VARIANTS).join(", ")}.`);
    const isFinal = variant === "final";
    const spec = isFinal ? FINAL_SPEC : require(entry.module);

    const model = flags.model && flags.model !== true ? String(flags.model) : "gpt-4o-2024-11-20";
    const temperature = flags.temperature !== undefined && flags.temperature !== true
        ? Number(flags.temperature) : 0.5;
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        die("--temperature must be a number between 0 and 2.");
    }
    const trials = flags.trials !== undefined && flags.trials !== true
        ? positiveInteger(flags.trials, "--trials") : 1;
    const outDir = path.resolve(flags["out-dir"] && flags["out-dir"] !== true
        ? String(flags["out-dir"])
        : path.join(resolveWorkspaceRoot(), "rq1"));
    const dryRun = Boolean(flags["dry-run"]);

    const ctx = await loadContext(flags, spec);
    if (!ctx) return; // --list-violations already printed

    const promptA = isFinal ? buildCallA(ctx) : spec.build(ctx);
    const violationFile = ctx.relative(ctx.violationFilePath);
    const runsDir = path.join(outDir, entry.dir, modelDir(model), temperatureDir(temperature),
        ruleDir(ctx.rule.index), `violation_${pad2(ctx.violationOrdinal)}`);

    if (dryRun) {
        console.error(`Dry run: ${variant}, rule ${ctx.rule.index}, ${violationFile}, `
            + `${model} @ ${temperature}, ${trials} run(s).`);
        console.error(`${isFinal ? "Call A" : "Prompt"}: ${promptA.split("\n").length} lines, `
            + `${promptA.length} chars.`);
        if (isFinal) console.error(`Call B would follow at temperature ${TEMPERATURE_B}.`);
        console.error(`Would write to ${runsDir}`);
        return;
    }

    const apiKey = readApiKey();
    fs.mkdirSync(runsDir, { recursive: true });

    // The prompt is identical for every run of this violation, so it lives once
    // beside them rather than inside each record. For final that is Call A;
    // Call B embeds the model's Call A answer and so differs per run.
    fs.writeFileSync(path.join(runsDir, "prompt.txt"), promptA, "utf8");

    const scan = scanRuns(runsDir);
    let runNumber = scan.nextRun;
    const remaining = flags.overwrite ? trials : Math.max(0, trials - scan.completed);
    if (remaining < trials) {
        console.error(`${scan.completed} run(s) already recorded here; doing ${remaining} more.`);
    }

    for (let done = 0; done < remaining; done += 1, runNumber += 1) {
        const record = {
            variant,
            model,
            temperature,
            rule: String(ctx.rule.index),
            violationFile,
            violationIndex: ctx.violationIndex,
            run: runNumber,
            contains: spec.contains,
        };

        try {
            const responseA = await complete({
                apiKey, model, temperature, prompt: promptA, jsonMode: false,
            });
            // A truncated answer is not a wrong answer, and scoring it as one
            // would corrupt the pass rate. Record it as an error instead, which
            // also leaves the run to be redone on the next pass.
            if (responseA.finishReason === "length") throw new Error("Response hit the output limit.");

            if (isFinal) {
                const promptB = buildCallB(ctx, responseA.text);
                const responseB = await complete({
                    apiKey, model, temperature: TEMPERATURE_B, prompt: promptB, jsonMode: true,
                });
                if (responseB.finishReason === "length") throw new Error("Call B hit the output limit.");
                record.promptB = promptB;
                record.response = { A: responseA.text, B: responseB.text };
            } else {
                record.response = responseA.text;
            }
            record.error = null;
        } catch (error) {
            record.response = null;
            record.error = error.message;
        }

        writeJson(path.join(runsDir, `run_${pad2(runNumber)}.json`), record);
        console.error(record.error
            ? `run_${pad2(runNumber)}: FAILED, ${record.error}`
            : `run_${pad2(runNumber)}: ok`);
    }

    console.error(`Runs written to ${runsDir}`);
}

main().catch((error) => {
    console.error(`Error: ${error && error.message ? error.message : error}`);
    process.exit(1);
});
