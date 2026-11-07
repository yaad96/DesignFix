# DesignFix (Preview)

DesignFix checks a Java project against design rules written as XPath queries over the code's srcML representation, and uses an LLM to suggest a fix for each violation. You review every suggested fix in a VS Code diff and accept or reject it.

## Getting started

1. Open a Java project folder that has `ruleTable.json` and `tagTable.json` at its root. DesignFix starts automatically in such folders and adds **DesignFix** to the status bar.
2. Run **DesignFix: Set OpenAI API Key** from the Command Palette. The key is kept in VS Code's secret storage on your machine.
3. Click **DesignFix** in the status bar, or run **DesignFix: Open Dashboard**. The dashboard opens in your browser and loads the project.
4. Under **Violated Rules**, pick a violation and click **Fix**.
5. Review the proposed change in the VS Code diff, then choose **DesignFix: Accept Fix** or **DesignFix: Reject Fix** in the editor title bar.

## How it works

1. The extension converts each `.java` file in the workspace to srcML with the bundled srcML 0.9.5.
2. The dashboard, served by the extension on your machine, checks each rule in `ruleTable.json` and lists the violations, each paired with an example of the rule being followed elsewhere in the same project.
3. When you click **Fix**, the dashboard sends the violation and its context to the OpenAI API through the extension, which adds your key.
4. The extension shows the proposed edit as a diff. Nothing changes on disk until you accept it.

## Requirements

- **Windows x64** for the bundled srcML. On macOS or Linux, install srcML **0.9.5** yourself (not 1.x, which changes the XML the rules depend on) and point the `designfix.srcmlPath` setting at it.
- **Microsoft Visual C++ Redistributable (x64)** on Windows, which srcML needs: https://aka.ms/vs/17/release/vc_redist.x64.exe. DesignFix tells you if it is missing.
- **An OpenAI API key.**
- **A trusted workspace.** DesignFix does not run in Restricted Mode.

## Commands

| Command | What it does |
| --- | --- |
| DesignFix: Open Dashboard | Opens the dashboard in your browser (also the **DesignFix** status bar item). |
| DesignFix: Set OpenAI API Key | Stores your key in VS Code secret storage. |
| DesignFix: Clear OpenAI API Key | Removes the stored key. |
| DesignFix: Accept Fix / Reject Fix | Applies or discards the fix under review (editor title bar). |
| DesignFix: Mine Rules | Experimental. Suggests rules from your code (editor context menu in Java files). Needs Java and `spmf.jar` in the project root. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `designfix.srcmlPath` | empty | Path to a srcML 0.9.5 executable. Empty uses the bundled Windows srcML, or `/usr/local/bin/srcml` (macOS) and `/usr/bin/srcml` (Linux). |
| `designfix.dashboard.port` | `0` | Port for the local dashboard server. `0` picks a free port. |
| `designfix.fixLogs.enabled` | `false` | Save a record of each accepted fix (prompts, model responses, and the original and modified files) for research use. |
| `designfix.fixLogs.directory` | empty | Where to save fix records. Empty uses the extension's storage folder. |
| `designfix.devSocket.enabled` | `false` | Also accept a dashboard run from source (`npm start`) on port 8887. |

## Privacy and security

- Nothing is sent to OpenAI until you click **Fix**. Each fix then makes two requests (model `gpt-4o-2024-11-20`). They contain the rule's description and XPath query, the full content of the file with the violation, a rule-following example from your project, and up to four related files from your project.
- Your API key stays in VS Code's secret storage. The extension adds it to requests to `api.openai.com`; it is never sent to the browser.
- The dashboard server listens on `127.0.0.1` only and answers only the dashboard's own page, so other computers and other websites cannot use it.
- The dashboard loads nothing from third-party servers, and DesignFix collects no telemetry.
- Accepted fixes are not recorded unless you turn on `designfix.fixLogs.enabled`.

## Known limitations

- This is a preview release, tested on Windows.
- The bundled srcML is Windows-only.
- Rules are written in `ruleTable.json`. See https://github.com/yaad96/DesignFix-VSCode for the format and for running DesignFix from source.

## License

MIT. The third-party components in this extension (srcML and its libraries, and the dashboard's packages) and their licenses are listed in `THIRD_PARTY_NOTICES.md`, included in the extension.

Developed by the DevX lab at George Mason University. DesignFix builds on ActiveDocumentation and RulePad.
