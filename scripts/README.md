# DesignFix–Cline agentic-baseline scripts

These scripts implement the manual workflow used in the experiment:

1. Generate a rule-specific prompt.
2. Paste it into the Cline VS Code extension GUI.
3. Let Cline complete the task in the target Java workspace.
4. Run the collector.
5. The collector reads the newest completed Cline task and saves its logs to
   `cline_data/rule_<id>/run_<NN>/`.

The prompt carries no experiment identifiers, so it can be pasted into Cline
verbatim and is a faithful record of exactly what the agent saw. Map the
completed task to its reserved run with explicit `--rule`/`--run`; the collector
verifies the task's prompt against the reserved prompt (`promptSha256`) before
writing, and refuses to collect on a mismatch unless `--allow-prompt-mismatch`
is passed.

## Repository placement

The scripts live in the `scripts/` folder at the workspace root (beside the
`DesignFix-client` and `DesignFix-Extension` repos). Paths are resolved relative
to that location, and collected runs are written to a sibling `cline_data/`:

```text
workspace-root/
├── scripts/                 (make_cline_prompt.js, collect_cline_task.js, cline_common.js)
├── DesignFix-client/
├── DesignFix-Extension/
├── data/                    (DesignFix fix logs)
└── cline_data/              (Cline baseline logs)

../CrowdCoding-ActiveDocumentation/   (target Java project, sibling of workspace-root)
```

The scripts use only built-in Node.js modules. No `npm install` is needed for
them beyond the Node installation already used by the project.

## 1. Generate and reserve a run

Create a small file containing only the violating code, for example
`study_inputs/rule_11_violation.txt`.

PowerShell example:

```powershell
node scripts/make_cline_prompt.js `
  --rule=11 `
  --project-root="C:\Research\CrowdCoding-ActiveDocumentation" `
  --violation-file="src\com\crowdcoding\entities\NewEntity.java" `
  --snippet-file="study_inputs\rule_11_violation.txt" `
  --model="gpt-4o-2024-11-20" `
  --cline-version="YOUR_CLINE_VERSION" `
  --time-limit-min=20 `
  --clipboard
```

The script:

- reads rule 11 from the target project's `ruleTable.json`;
- creates the exact prompt;
- reserves `../cline_data/rule_11/run_01/`;
- saves a pre-Cline source snapshot;
- writes the prompt and metadata;
- copies the prompt to the clipboard.

You may use an inclusive source line range instead of a snippet file:

```powershell
--start-line=25 --end-line=29
```

Or supply the exact checker report shown in the DesignFix UI:

```powershell
--checker-output-file="study_inputs\rule_11_checker_output.txt"
```

Do not combine the checker-output option with the snippet options.

## 2. Run Cline

Open only the target Java project in VS Code. Start a fresh Cline task, paste the
prompt, and allow the same approvals in every run. Do not provide repair hints
or answer implementation questions.

For a clean baseline, remove or disable task-specific `.clinerules`, memories,
MCP tools, or instruction files that were not part of the original study
workspace.

## 3. Collect the completed task

After Cline finishes, identify the run explicitly and pass the project the run
was performed in:

```powershell
node scripts/collect_cline_task.js --rule=11 --run=1 `
  --project-root="C:\Research\CrowdCoding-ActiveDocumentation"
```

`--project-root` is required because a run folder records no absolute project
path (see [Recorded paths and timestamps](#recorded-paths-and-timestamps)). It
falls back to `DESIGNFIX_TARGET_PROJECT_ROOT`, `CROWDCODING_PROJECT_ROOT`, or a
working directory that contains `ruleTable.json`, and the collector refuses to
proceed if the supplied root does not match the run's own baseline snapshot, so a
root pointing at the wrong checkout fails before anything is written rather than
recording a foreign workspace's diff. The generator prints the root it used
(`Project root used (not recorded)`) so the same value can be passed here.

The collector selects the newest completed repair task, verifies its prompt
matches the reserved run's prompt, and refuses to collect on a mismatch (pass
`--allow-prompt-mismatch` only after manually confirming the task). It
auto-discovers the Cline global-storage folder; if it cannot, pass it directly:

```powershell
node scripts/collect_cline_task.js --rule=11 --run=1 `
  --project-root="C:\Research\CrowdCoding-ActiveDocumentation" `
  --cline-storage="$env:APPDATA\Code\User\globalStorage\saoudrizwan.claude-dev"
```

You can first inspect all matching candidates:

```powershell
node scripts/collect_cline_task.js --rule=11 --run=1 --list
```

The listing is ordered newest-first (`newestFirstRank: 1` is the task the
collector would pick). Or pass a known task folder:

```powershell
node scripts/collect_cline_task.js --rule=11 --run=1 `
  --project-root="C:\Research\CrowdCoding-ActiveDocumentation" `
  --cline-task-dir="C:\...\globalStorage\saoudrizwan.claude-dev\tasks\TASK_ID"
```

## Collected run contents

A completed run contains:

```text
cline_data/rule_11/run_01/
├── meta.json
├── prompt.txt
├── checker_output.txt
├── baseline/
│   ├── manifest.json
│   └── files/...
├── cline_prompt_extracted.txt
├── cline_conversation.txt
├── cline_usage_fields.json
├── cline_source_files.json
├── cline_task_raw/...
├── raw_task_manifest.json
├── workspace_changes.json
├── edited_files/
│   ├── 01_File.java.original
│   └── 01_File.java.modified
├── git_status_after.txt
├── git_diff_after.patch
└── process_metrics.json        (added by analyze_cline_run.js)
```

The baseline comparison is more reliable than using Git alone when the injected
violation was already an uncommitted workspace change before Cline started.

## Recorded paths and timestamps

Everything the harness generates carries **project-relative paths only**: no
absolute path, no project root, and no timestamp. `meta.json` therefore records
`violationFileRelativePath` and `ruleTableRelativePath` instead of the absolute
paths and `projectRoot` of earlier versions (`schemaVersion: 2`), the baseline
manifest holds only `path`/`sha256`/`size` (change detection is content-based, so
it needs no clock or file mtimes), and `process_metrics.json` keeps elapsed
seconds (`durationSeconds`, `timeToFirstEditSeconds`) without the clock values
they were derived from. Absolute paths that Cline itself logged are relativized
against the run's own baseline snapshot: the longest tail of the logged path that
names a snapshot file wins, `file:///` URIs are decoded first, and a path
matching nothing is reduced to its basename with a warning. That includes path
arguments inside recorded terminal commands, so
`powershell -File F:\...\CrowdCoding-Runner\run.ps1 compile` is stored as
`powershell -File CrowdCoding-Runner/run.ps1 compile`; the verbatim command stays
in `cline_task_raw/`.

Two deliberate exceptions:

- The verbatim Cline logs under `cline_task_raw/` (and the extracted prompt and
  normalized conversation drawn from them) are the agent's own evidence and are
  never rewritten. They contain Cline's absolute paths and per-message
  timestamps, which is also where `analyze_cline_run.js` reads the clock from.
- `clineTask.taskId` is kept, because it is the only handle mapping a run to the
  raw logs it came from, even though Cline derives that id from epoch
  milliseconds.

To audit or migrate existing runs:

```powershell
node scripts/sanitize_cline_data.js --all --check   # report only, exits 1 on a finding
node scripts/sanitize_cline_data.js --all           # strip legacy fields in place
node scripts/analyze_cline_run.js --all             # regenerate process_metrics.json
```

The migration removes the fields listed above from runs collected by earlier
versions of the scripts, converts a legacy absolute `ruleTablePath` to a relative
`ruleTableRelativePath`, and leaves derived durations intact. `--check` is worth
running before archiving or publishing the data.

Both modes also print a `Preserved verbatim` tally: how many absolute paths and
dates remain inside the evidence files that are never rewritten
(`cline_task_raw/`, `cline_conversation.txt`, `cline_prompt_extracted.txt`, and
the `edited_files/` byte copies). Those counts do not fail `--check`; they are
there so the exception is visible rather than implied. Note that
`edited_files/*.original|.modified` can legitimately be full of absolute paths
when the agent edited such a file — a javac `@sources.txt` argfile, for
example — because they are exact copies of project files, and rewriting them
would contradict `git_diff_after.patch`.

## 4. Compute process metrics

After collecting one or more runs:

```powershell
node scripts/analyze_cline_run.js --all
```

This reads each collected run's `cline_task_raw/` logs and writes
`process_metrics.json` into the run folder plus a
`cline_data/process_metrics_summary.csv` aggregate. Per run it derives:
elapsed duration and time to first successful edit, API requests, tool
calls by type with failure/denial counts, files read (successful reads only —
failed path guesses and directory searches are reported separately), files
read/edited beyond the violation site, terminal commands, token usage and
cost, and whether `attempt_completion` was actually invoked. It also
cross-checks the edit-tool log against the baseline workspace diff and the
claimed `--model` against the model id Cline actually recorded, emitting
warnings on any mismatch. A single run can be analyzed with
`--run-dir=cline_data/rule_<id>/run_<NN>`.

## 5. List a rule's violations without the dashboard

```powershell
node scripts/list_rule_snippets.js --rule=1 --project-root="<testing_project>"
node scripts/list_rule_snippets.js --rule=1 --project-root="<testing_project>" --show-satisfying
node scripts/list_rule_snippets.js --rule=1 --project-root="<testing_project>" --json
```

Prints the violating snippets for one rule, grouped by project-relative file path,
exactly as the dashboard's **Violated** tab lists them; `--show-satisfying` adds
the **Examples** tab. Both `--rule` and `--project-root` are required and the
project is never inferred — no environment variable, no working-directory sniffing,
no filesystem search. Several copies of the same study project exist side by side
(backups, an untouched original, older versions), so an inferred root would
silently report a violation set belonging to a different project.

It does not reimplement the checker. It rebuilds the extension's inputs — one
srcML document per `.java` file, using the bundled srcML with the same
`--max-threads 1 --in-order --language Java` flags and the same absolute
forward-slash paths that go over the WebSocket — then runs the client's own
`core/ruleExecutor.js` inside headless Chrome over the DevTools protocol. A real
browser engine is required: every rule query is `src:`-prefixed and jsdom's
`Document.evaluate` ignores namespace resolvers, so a Node-only port would report
zero violations for every rule. Chrome or Edge is located automatically
(`--browser=<path>` or `CHROME_PATH` to override); no npm dependency is added.

The rule's own `checkForFilesFolders` filter is applied before conversion, so a
scoped rule converts only the files it can match (rule 1: 8 files instead of 125,
about a second end to end). A rule whose XPath does not compile is reported as an
error rather than as zero violations — the executor signals that case by appending
to the rule's description instead of throwing.

## Repeated runs

Run the generator again without `--run`; it automatically reserves `run_02`,
then `run_03`, and so on. The prompt carries that run number, so the collector
cannot accidentally save a task into the wrong run folder.

## Between runs

Restore the target project to its violation state before starting the next
run, and always collect a run **before** reverting or starting another task:
the collector compares the workspace as it exists at collection time, so
collecting after a revert records an empty diff. Each run's pre-run source
tree is saved under `run_<NN>/baseline/files/` if a restore reference is
needed. `tempExprFile.java`, `tempResultXmlFile.xml`, `temptestfile.java`,
and `output.xml` (DesignFix scratch files) are excluded from snapshots and
diffs.

## Important methodological behavior

The Cline prompt includes the rule title, description, tags, violation path, and
violating snippet, mirroring the normal checker-facing information. It does not
include DesignFix's rule-satisfying example, extracted surrounding context,
full file content, preselected fix-site files, or cross-file hints. Cline must
find those from the repository through its own agentic tools.
