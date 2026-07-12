# DesignFix–Cline agentic-baseline scripts

These scripts implement the manual workflow used in the experiment:

1. Generate a rule-specific prompt.
2. Paste it into the Cline VS Code extension GUI.
3. Let Cline complete the task in the target Java workspace.
4. Run the collector.
5. The collector reads the latest completed Cline task and saves its logs to
   `cline_data/rule_<id>/run_<NN>/`.

The prompt contains `designfix_rule_id` and `designfix_run_id`, as requested.
The collector uses those markers for deterministic mapping.

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

After Cline finishes:

```powershell
node scripts/collect_cline_task.js
```

The collector auto-discovers the Cline global-storage folder. If it cannot,
pass it directly:

```powershell
node scripts/collect_cline_task.js `
  --cline-storage="$env:APPDATA\Code\User\globalStorage\saoudrizwan.claude-dev"
```

You can first inspect all matching candidates:

```powershell
node scripts/collect_cline_task.js --list
```

Or pass a known task folder:

```powershell
node scripts/collect_cline_task.js `
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
└── git_diff_after.patch
```

The baseline comparison is more reliable than using Git alone when the injected
violation was already an uncommitted workspace change before Cline started.

## Repeated runs

Run the generator again without `--run`; it automatically reserves `run_02`,
then `run_03`, and so on. The prompt carries that run number, so the collector
cannot accidentally save a task into the wrong run folder.

## Important methodological behavior

The Cline prompt includes the rule title, description, tags, violation path, and
violating snippet, mirroring the normal checker-facing information. It does not
include DesignFix's rule-satisfying example, extracted surrounding context,
full file content, preselected fix-site files, or cross-file hints. Cline must
find those from the repository through its own agentic tools.
