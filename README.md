# DesignFix

DesignFix is an LLM-assisted design-rule–violation detector and repair tool for Java projects. It continuously checks your codebase against a set of author-defined design rules, surfaces violations in a web dashboard, and uses an LLM to suggest minimal fixes that you can review and apply.

DesignFix has two components that run together:

| Component | Folder | Role | Default port |
|-----------|--------|------|--------------|
| **Extension** | `DesignFix-Extension/` | VS Code extension. Watches the target Java project, converts each `.java` file to srcML XML, hosts a WebSocket server, and streams file/rule data to the web app. | WebSocket `8887` |
| **Client (web app)** | `DesignFix-client/` | React dashboard. Receives the XML, runs the XPath rule checks in-browser, shows violated rules, and drives the LLM fix workflow. | HTTP `9010` |

They talk to each other over a WebSocket (`ws://localhost:8887`).

---

## 1. Prerequisites

0. **Windows machine**
1. **Node.js** (v16+ recommended) and **npm**.
2. **VS Code** `^1.86.0`.
3. **srcML `0.9.5`** — the tool that converts Java to XML.
   > ⚠️ **Use srcML 0.9.5, not 1.1.0.** Version 1.1.0 wraps class inheritance in a `<super_list>` element, which breaks every rule that uses `src:super/src:extends` (inheritance-based rules silently report 0 violations). All rules in this project were authored against 0.9.5.
   - The extension resolves the srcML binary from `DesignFix-Extension/src/Constants.ts`:
     - Windows: `SRCML_PATH_WINDOWS`
   - If your srcML lives elsewhere, update the matching constant.
4. **An OpenAI API key** (only needed for the LLM "suggest fix" feature). Add it to the gitignored `DesignFix-client/.env` as `OPENAI_API_KEY=your-key`. The web app's dev server reads it from there and injects it into the OpenAI proxy, so the key never reaches the browser.
5. **A target Java project** to analyze. It must contain a `ruleTable.json` (the design rules) and a `tagTable.json` at its root — these are loaded by the extension on connect.

---

## 2. One-time setup

Install dependencies for both components.

```powershell
# From the repository root: "DesignFix-Extension + Client"

# Extension
cd "DesignFix-Extension"
npm install
npm run compile        # compiles TypeScript in src/ to out/

# Client
cd "..\DesignFix-client"
npm install
```

---

## 3. Running the tool

You need **three** things running: the extension (in an Extension Development Host), the web app, and the target Java project opened inside the Extension Development Host.

### 3a. Start the extension (Extension Development Host)

1. Open the `DesignFix-Extension/` folder in VS Code.
2. Compile if you have not already, or run the watch task:
   ```powershell
   cd "DesignFix-Extension"
   npm run compile     # or: npm run watch
   ```
3. Press **F5** ("Run Extension"). This launches a second VS Code window — the **Extension Development Host** — with the DesignFix extension loaded (it activates `onStartupFinished`).
4. In that new window, **open your target Java project folder** (File → Open Folder). The extension analyzes `workspaceFolders[0]`, so the Java project must be the workspace root there.

> 🔁 **Every time you run `npm run compile`, you must relaunch the Extension Development Host (stop it and press F5 again).** The running host keeps the old build until relaunched.

### 3b. Start the web app

```powershell
cd "DesignFix-client"
npm run start-Windows      # macOS: npm run start-Mac | Linux: npm run start-Linux
```

- Serves the dashboard at **http://localhost:9010**.
- The Windows/Linux scripts set `NODE_OPTIONS=--openssl-legacy-provider` (required for the older React build).

### 3c. Connect

Open **http://localhost:9010** in your browser. On page load the client opens the WebSocket to the extension (`8887`). The extension then:

1. Sends the project path and folder hierarchy.
2. Converts **all** `.java` files to srcML XML and streams them.
3. Sends the tag table and rule table.
4. Triggers a full rule verification.

While this runs, the dashboard shows **"Loading Rules and Preprocessing."** Wait until that heading disappears before trusting any counts.

---

## 4. Using the dashboard

Left navigation:

- **Table of Contents** — overview.
- **All Rules** — every rule with satisfied/violated status.
- **Violated Rules** — only rules with at least one violation, each showing an **Examples** count and a **Violated** count. Expand a card and open the **Violated** tab to see the offending code snippet(s) and file.
- **Learn Design Rules** — rule documentation.
- **DesignFix LLM status** (top navigation) shows whether your OpenAI key is loaded. You do not enter the key in the browser: add it to the gitignored `DesignFix-client/.env` as `OPENAI_API_KEY=your-key`. The dev server reads that file and injects the key into the OpenAI proxy, so it stays server-side.

---

## 5. Requesting and applying a fix

1. Go to **Violated Rules** and expand the rule you want to fix; open its **Violated** tab to see the violating snippet and file.
2. **Provide your OpenAI key** once by adding `OPENAI_API_KEY=your-key` to `DesignFix-client/.env` (gitignored). The dev server picks it up automatically on the next request; no browser entry is needed. The top navigation shows "key loaded" when it is set.
3. Click the **Fix** action on the violation. The client calls `suggestFix()` ([DesignFix-client/src/activeLLM/suggestFix.js](DesignFix-client/src/activeLLM/suggestFix.js)), sending the LLM:
   - the design rule,
   - a rule-satisfying example (and its file path),
   - the surrounding class/method context,
   - the full original file content and its path,
   - the violation snippet.
   The LLM returns a **fully rewritten file** plus an explanation, constrained to change only the minimal lines needed.
4. Review the suggestion in the dashboard, then click **Accept Fix** to send it to the VS Code extension. This does **not** change the project file yet.
5. In the Extension Development Host, review the native VS Code diff between the file on disk and the suggested version.
6. Select **DesignFix: Accept Fix** to save the change, or **DesignFix: Reject Fix** to discard the suggestion. Accepting saves the reconciled change to the target file; rejecting leaves the file unchanged.
7. The extension watches the saved `.java` file, reconverts it to srcML, and asks the client to recheck the affected rules. If the dashboard does not update after a few seconds, reload the web page.

> The OpenAI call goes through a local proxy (`/openai-proxy/v1`) to avoid browser CORS issues. The proxy is configured in the client's dev server (`setupProxy.js`), which also injects your API key from `OPENAI_API_KEY` in `DesignFix-client/.env` so the key stays server-side and never reaches the browser.

---

## 6. Running DesignFix with CrowdCoding

This workflow uses two folders, referred to by generic placeholders in the commands below:

- `<testing_project>`: the working copy that DesignFix analyzes and where fixes are applied. For example, currently `F:\CrowdCoding-ActiveDocumentation`.
- `<original_copy_project>`: the backup that holds the seeded baseline and is the restore source. For example, currently `F:\Backup_CrowdCode`.

### 6.0 First-time build/run of the CrowdCoding app (either copy, any machine)

The CrowdCoding app builds and serves through its portable `CrowdCoding-Runner`, which targets whatever project folder it sits inside:

- **JDK 8** (Temurin 8: <https://adoptium.net/temurin/releases/?version=8>). The old `dev_appserver` runs only on Java 8. It is auto-detected in the standard install directories, or set `CROWDCODING_JAVA8_HOME`.
- **Internet access** for the first `setup.cmd`. It downloads the GAE SDK 1.9.98, ECJ, and Guava (about 120 MB, SHA-checksummed from Maven Central). If the copy already ships an extracted `CrowdCoding-Runner\tools\` toolchain, `setup.cmd` is effectively a no-op.

```powershell
Set-Location "<project>\CrowdCoding-Runner"   # the working copy OR the backup
.\setup.cmd                # one-time per machine
.\run.cmd compile-strict   # compile only (the LLM-fix gate)
.\run.cmd                  # compile + serve at http://localhost:8888  (admin: /_ah/admin)
```

**Expected output on the untouched seeded baseline. Neither result below is a real failure:**

- `.\run.cmd compile-strict` exits **`-1`**, not `0`. The seeded **Rule 2** violation (`MicrotaskCommand.CreateChallengeReview` does not implement the abstract `execute(Microtask, String)`) is deliberate. The gate passes when `tools\compile.log` contains **only** this one error. Exit `0` appears only after a correct Rule 2 fix.
- `.\run.cmd` starts the server, but every app page returns **HTTP 500**. The seeded **Rule 12** violation (`Worker` is `@Entity` without `@Id`) crashes Objectify entity registration at boot. To get a browsable instance, temporarily restore the key in `src\com\crowdcoding\entities\Worker.java` (line 40: `@Id private String userid;`) and re-run. Firebase-backed live sync and newsfeed are dead regardless (2014-era realtime database).

> The backup copy (`<original_copy_project>`) has no `tools\cache`, so `setup.cmd` re-downloads the 120 MB SDK there. The working copy ships the cache and sets up offline. See the runner's own `CrowdCoding-Runner\README.md` for internals, the Docker alternative, and `unprepare`.

### 6a. Open CrowdCoding

1. Start the DesignFix extension and client as described in [Running the tool](#3-running-the-tool).
2. In the Extension Development Host, select **File → Open Folder** and open:

   ```text
   F:\CrowdCoding-ActiveDocumentation
   ```

3. Open the URL printed by the client terminal (normally <http://localhost:9010>).
4. Wait for **Loading Rules and Preprocessing** to disappear. CrowdCoding's violated rules should then be visible in the dashboard.

### 6b. Review and apply a fix

1. Request a fix from a violation in the web app.
2. Click **Accept Fix** in the web app to send the suggestion to VS Code.
3. In the Extension Development Host, review the native diff and select **DesignFix: Accept Fix** or **DesignFix: Reject Fix**.
4. If you accepted the fix, wait a few seconds for the dashboard to update. Reload the web page only if the violation status does not refresh automatically.

### 6c. Compile the accepted fix

The CrowdCoding runner requires JDK 8. Before using it for the first time, prepare its pinned compiler and Google App Engine dependencies:

```powershell
Set-Location "<project>\CrowdCoding-Runner"
.\setup.cmd
```

Run the strict compilation gate after accepting a fix:

```powershell
cd F:\DESIGNFIX-EXTENSION+CLIENT
Set-Location "F:\All CrowdCode Versions\No_Compilation_Error_CrowdCode\CrowdCoding-Runner"
.\run.cmd compile-strict
$compileExit = $LASTEXITCODE
Write-Host "Exit code: $compileExit"
```

The command rebuilds `war\WEB-INF\classes` and writes the complete compiler output to `CrowdCoding-Runner\tools\compile.log`.

- On the untouched seeded baseline this exits **`-1`**, not `0`. The seeded Rule 2 and Rule 16 violations produces exactly one known compile error (shown below), so a nonzero exit is expected here, not a failure.
```
using JDK 8 at C:\Program Files\Eclipse Adoptium\jdk-8.0.492.9-hotspot
compiling 101 files with ECJ (JDK 8) ...
compile finished: 3 error(s), 167 classes emitted (full log: tools\compile.log)

> tools\compile.log:8:1. ERROR in F:\CrowdCoding-ActiveDocumentation\src\com\crowdcoding\commands\ADTCommand.java (at line 69)
  tools\compile.log:9:  protected static class Create extends ADTCommand {
  tools\compile.log:10:                        ^^^^^^
> tools\compile.log:14:2. ERROR in F:\CrowdCoding-ActiveDocumentation\src\com\crowdcoding\commands\FunctionCommand.java (at line 181)
  tools\compile.log:15: protected static class AddCaller extends FunctionCommand {
  tools\compile.log:16:                        ^^^^^^^^^
> tools\compile.log:20:3. ERROR in F:\CrowdCoding-ActiveDocumentation\src\com\crowdcoding\commands\MicrotaskCommand.java (at line 147)
  tools\compile.log:21: protected static class CreateChallengeReview extends MicrotaskCommand
  tools\compile.log:22: 
> tools\compile.log:26:4. ERROR in F:\CrowdCoding-ActiveDocumentation\src\com\crowdcoding\commands\ProjectCommand.java (at line 27)
  tools\compile.log:27: return new EnableReviews(reviewsEnabled);
  tools\compile.log:28:                         ^^^^^^^^^^^^^^^^^^^^^
exit code: -1
```
So for a non-Rule-2 and non-rule-16 violation fixing, only these should be displayed when compiling.
- Exit code `0` means there are no Java compilation errors. Expect `0` only after a correct fix for Rule 2 (**Commands must implement execute**). When you validate a fix for a different rule, the seeded Rule 2 violation stays in place, so the nonzero exit (typically `-1`) persists:

  ```text
  The type MicrotaskCommand.CreateChallengeReview must implement the inherited
  abstract method MicrotaskCommand.execute(Microtask, String)
  ```

  In that case, the fix passes the compile gate only when `compile.log` contains this one known error and no additional errors.

### 6d. Restore the seeded violations

After recording the result, restore the working source tree **and reset the runner** from the backup:

`robocopy` mirrors one source into one destination per call, so the two restores are wrapped in a single loop that shares the same options and one exit-code check:

```powershell
# Restore both the study source (seeded violations) and the runner from the backup.
# /XD cache keeps the runner's ~135 MB downloaded SDK archive; src has no 'cache' folder, so it is a no-op there.
foreach ($p in @("src", "CrowdCoding-Runner")) {
    robocopy "<original_copy_project>\$p" "<testing_project>\$p" /MIR /XD cache /COPY:DAT /DCOPY:DAT /R:2 /W:2
    if ($LASTEXITCODE -ge 8) {
        throw "CrowdCoding reset of '$p' failed with Robocopy exit code $LASTEXITCODE"
    }
}
```

`/MIR` makes each destination match the backup exactly, removing files that a suggested fix or a compile created. The `src` pass brings back the seeded violations; the `CrowdCoding-Runner` pass clears generated runner state (`tools\compile.log`, `tools\sources.txt`, and any stray build output). `/XD cache` preserves the runner's `tools\cache` folder, the ~135 MB downloaded GAE SDK/ECJ archive, so `setup.cmd` does not re-download it; `src` has no `cache` folder, so the exclusion is a no-op there. Neither pass touches the backup itself, and the recompiled `war\WEB-INF\classes` tree is refreshed on the next compile rather than by this restore. Robocopy exit codes `0` through `7` indicate success; `8` or higher indicates failure.

Reload <http://localhost:9010> after the reset and wait for preprocessing to finish. The seeded violations should be visible again.

> **Warning:** `/MIR` deletes files from each destination (`src` and `CrowdCoding-Runner`) that are absent from the backup. Verify all paths before running. The `/XD cache` exclusion deliberately keeps the runner's `tools\cache` download; drop it only when you want to force a fresh SDK download.

---

## 7. Running the Cline baseline

1. **Generate and reserve a run.** Replace each `nn` with the intended rule ID
   or positive run number, then run:

   ```powershell
   cd "f:\DesignFix-Extension + Client"
   node scripts/make_cline_prompt.js `
     --rule=<nn> `
     --project-root="<testing_project>" `
     --violation-file="pathe/to/the/violating/file" `
     --run=<nn> `
     --model="gpt-4o" `
     --clipboard
   ```

2. **Run Cline.** Open only the target Java project in VS Code, start a fresh
   Cline task, paste the generated prompt, and let Cline finish. Use the same
   approvals for every run and do not provide repair hints.

3. **Collect the completed task before restoring the project.** Pass the same
   project root used in step 1; a run folder records no absolute project path, so
   the collector has to be told where the run happened (it refuses to proceed if
   the root does not match the run's baseline snapshot):

   ```powershell
   cd "f:\DesignFix-Extension + Client"
   node scripts/collect_cline_task.js `
     --rule=<nn> `
     --run=<nn> `
     --project-root="<testing_project>"
   ```
4. Run the strict compilation gate after accepting a fix:

```powershell
Set-Location "<testing_project>\CrowdCoding-Runner"
.\run.cmd compile-strict
$compileExit = $LASTEXITCODE
Write-Host "Exit code: $compileExit"
```

5. **Restore the target project (source and runner) to the original
   violation state from the backup:**

   ```powershell
   # Restore both the study source (seeded violations) and the runner from the backup.
   # /XD cache keeps the runner's downloaded SDK archive; src has no 'cache' folder.
   foreach ($p in @("src", "CrowdCoding-Runner")) {
       robocopy "<original_copy_project>\$p" "<testing_project>\$p" /MIR /XD cache /COPY:DAT /DCOPY:DAT /R:2 /W:2
       if ($LASTEXITCODE -ge 8) {
           throw "CrowdCoding reset of '$p' failed with Robocopy exit code $LASTEXITCODE"
       }
   }
   ```

   For example, if your testing project is `F:\CrowdCoding-ActiveDocumentation` and your backup is `F:\Backup_CrowdCode`, the command becomes:

   ```powershell
   foreach ($p in @("src", "CrowdCoding-Runner")) {
       robocopy "F:\Backup_CrowdCode\$p" "F:\CrowdCoding-ActiveDocumentation\$p" /MIR /XD cache /COPY:DAT /DCOPY:DAT /R:2 /W:2
       if ($LASTEXITCODE -ge 8) {
           throw "CrowdCoding reset of '$p' failed with Robocopy exit code $LASTEXITCODE"
       }
   }
   ```

6. **Compute process metrics after collecting the runs:**

   ```powershell
   node scripts/analyze_cline_run.js --all
   ```

   Everything the harness writes into `cline_data/` uses project-relative paths
   only, with no project root and no timestamps; the verbatim Cline logs under
   `cline_task_raw/` are the one exception and are never rewritten. To audit the
   collected data, or to strip those fields from runs collected by an earlier
   version of the scripts:

   ```powershell
   node scripts/sanitize_cline_data.js --all --check   # report only
   node scripts/sanitize_cline_data.js --all           # strip in place
   ```

   See [scripts/README.md](scripts/README.md#recorded-paths-and-timestamps) for
   the exact field list.


   Always collect the run before restoring. Robocopy exit codes `0` through `7`
   indicate success; `8` or higher indicates failure. Because `/MIR` deletes
   destination files that are absent from the backup, verify all paths before
   running the command.

---

## 8. Listing a rule's violations from the command line

Inspect a rule's violation set without launching the extension, the web app, or a
browser session:

```powershell
cd "f:\DesignFix-Extension + Client"
node scripts/list_rule_snippets.js `
  --rule=<nn> `
  --project-root="<testing_project>"
```

The violating snippets are printed grouped by project-relative file, exactly as the
dashboard's **Violated** tab lists them. Add `--show-satisfying` to also print the
**Examples** tab, or `--json` for machine-readable output:

```text
Rule 1: All Microtask commands must be handled by Command subclasses
  scope: INCLUDE ["src/com/crowdcoding/commands"], mode WITHIN
  converting 8 of 125 Java file(s) with srcML...
  quantifier matches: 56, satisfied: 55, violated: 1

VIOLATIONS: 1 listed across 1 file(s)

  src/com/crowdcoding/commands/FunctionCommand.java  (1)
    [1] <function ...><specifier>public</specifier> <specifier>static</specifier> ...
```

The script does not reimplement the checker. It rebuilds the extension's inputs —
one srcML document per in-scope `.java` file, using the srcML bundled at
`DesignFix-Extension/bin/srcml-win/bin/srcml.exe` with the same flags and the same
absolute forward-slash paths that go over the WebSocket — and then runs the
client's own `core/ruleExecutor.js` inside headless Chrome over the DevTools
protocol. A real browser engine is required: every rule query is `src:`-prefixed
and jsdom's `Document.evaluate` ignores namespace resolvers, so a Node-only port
would report zero violations for every rule. Chrome or Edge is located
automatically (`--browser=<path>` or `CHROME_PATH` to override), srcML can be
overridden with `--srcml=<path>` or `SRCML_PATH`, and no `npm install` is needed.

Both `--rule` and `--project-root` are required, and the project is **never
inferred** — no environment variable, no working directory, no filesystem search.
Several copies of the same study project sit side by side (backups, an untouched
original, older versions), so an inferred root would report a violation set
belonging to a different project. A rule whose XPath does not compile is reported
as an error rather than as zero violations.

See [scripts/README.md](scripts/README.md#5-list-a-rules-violations-without-the-dashboard)
for the full option list.

---

## 9. Quick start (TL;DR)

```powershell
# 1. Install
cd "DesignFix-Extension"; npm install; npm run compile
cd "..\DesignFix-client"; npm install

# 2. Extension: open DesignFix-Extension in VS Code → F5 →
#    in the new window, open your Java project (with ruleTable.json at its root)

# 3. Web app
cd "DesignFix-client"; npm run start-Windows

# 4. Add OPENAI_API_KEY=your-key to DesignFix-client/.env (gitignored), then open
#    http://localhost:9010, wait for preprocessing, go to "Violated Rules",
#    click Fix, review the diff, apply it, and watch the violation count drop.
```
