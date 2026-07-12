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

1. **Node.js** (v16+ recommended) and **npm**.
2. **VS Code** `^1.86.0`.
3. **srcML `0.9.5`** — the tool that converts Java to XML.
   > ⚠️ **Use srcML 0.9.5, not 1.1.0.** Version 1.1.0 wraps class inheritance in a `<super_list>` element, which breaks every rule that uses `src:super/src:extends` (inheritance-based rules silently report 0 violations). All rules in this project were authored against 0.9.5.
   - The extension resolves the srcML binary from `DesignFix-Extension/src/Constants.ts`:
     - Windows: `SRCML_PATH_WINDOWS`
     - macOS: `SRCML_PATH_MAC` (`/usr/local/bin/srcml`)
     - Linux: `SRCML_PATH_LINUX` (`/usr/bin/srcml`)
   - If your srcML lives elsewhere, update the matching constant.
4. **An OpenAI API key** (only needed for the LLM "suggest fix" feature).
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
- **Opt-In to DesignFix LLM** — where you paste your OpenAI API key (stored in the browser's `localStorage` as `OPENAI_API_KEY`). Required before requesting an LLM fix.

---

## 5. Requesting and applying a fix

1. Go to **Violated Rules** and expand the rule you want to fix; open its **Violated** tab to see the violating snippet and file.
2. **Opt in to the LLM** first (paste your OpenAI key under *Opt-In to DesignFix LLM*) if you have not already.
3. Click the **Fix** action on the violation. The client calls `suggestFix()` ([DesignFix-client/src/activeLLM/suggestFix.js](DesignFix-client/src/activeLLM/suggestFix.js)), sending the LLM:
   - the design rule,
   - a rule-satisfying example (and its file path),
   - the surrounding class/method context,
   - the full original file content and its path,
   - the violation snippet.
   The LLM returns a **fully rewritten file** plus an explanation, constrained to change only the minimal lines needed.
4. The dashboard renders a **diff** between the original file and the suggested rewrite (`handleEditFix` in [DesignFix-client/src/ui/rulePanel.js](DesignFix-client/src/ui/rulePanel.js)). Review the added/removed lines.
5. **Apply the fix** by writing the suggested content to the violating `.java` file in your project (accept/apply the rewrite from the diff view).

> The OpenAI call goes through a local proxy (`/openai-proxy/v1`) to avoid browser CORS issues; the proxy is configured in the client's dev server (`setupProxy.js`).

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

# 4. Open http://localhost:9010, wait for preprocessing,
#    go to "Violated Rules", opt in with your OpenAI key, click Fix,
#    review the diff, apply it, and watch the violation count drop.
```
