#!/usr/bin/env node
"use strict";

// List the violating snippets DesignFix would show for one rule, without opening
// the dashboard.
//
// Fidelity is the whole point of this script, so it does not reimplement the
// checker. It reproduces the extension's inputs (one srcML document per .java
// file, produced with the same binary and flags) and then runs the client's own
// DesignFix-client/src/core/ruleExecutor.js inside a real browser engine. That
// matters because the executor depends on browser DOM XPath: every rule query is
// namespace-prefixed (src:...), and jsdom's Document.evaluate ignores the
// namespace resolver entirely, silently returning zero matches for every rule.
// Chromium is driven over the DevTools protocol with no npm dependency.

const {
    fs, path, parseArgs, die, requiredString, normalizePath, walkFiles,
} = require("./cline_common");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

function help() {
    process.stdout.write(`
List the violating snippets for one design rule, exactly as the DesignFix
dashboard's "Violated" tab lists them.

Usage:
  node scripts/list_rule_snippets.js --rule=1 --project-root="<path>"
  node scripts/list_rule_snippets.js --rule=1 --project-root="<path>" --show-satisfying

Required:
  --rule=<id>              Rule index from the target project's ruleTable.json.
  --project-root=<path>    Target Java project, containing ruleTable.json. Never
                           inferred: backups and older copies of the same study
                           project sit side by side, so a guess would attribute a
                           violation set to the wrong project.

Optional:
  --show-satisfying        Also list the satisfying examples ("Examples" tab).
  --json                   Emit machine-readable JSON instead of a report.
  --rule-table=<path>      Override <project-root>/ruleTable.json.
  --srcml=<path>           srcML binary. Default: the copy bundled with the
                           extension, else SRCML_PATH, else "srcml" on PATH.
  --browser=<path>         Chrome/Edge binary. Default: probe the usual install
                           locations, or CHROME_PATH.
  --help

Reported paths are project-relative. Snippets are reproduced verbatim from the
executor, which means the first two non-blank lines of the matched srcML node
with annotations and comments stripped -- the same string the dashboard shows and
the same string the checker uses to tell a violation from an example.
`.trimStart());
}

// ---------------------------------------------------------------- srcML input

// The extension's own flags (DesignFix-Extension/src/srcmlRunner.ts). --in-order
// and --max-threads 1 are load-bearing: they make srcML deterministic, and the
// snippet strings this script compares are serialized XML.
const SRCML_STABLE_ARGS = ["--max-threads", "1", "--in-order", "--language", "Java"];
const SRCML_MAX_BUFFER = 64 * 1024 * 1024;
const SRCML_MAX_ATTEMPTS = 3;
// The two transient native failures srcmlRunner.ts retries on.
const WINDOWS_ACCESS_VIOLATION = 0xC0000005;
const WINDOWS_HEAP_CORRUPTION = 0xC0000374;

// Scratch files the extension writes into the project and excludes from its own
// snapshot (Constants.TEMP_JAVA_FILE / TEMP_JAVA_FILE_TESTING).
const IGNORED_JAVA_BASENAMES = new Set(["tempexprfile.java", "temptestfile.java"]);

function resolveSrcml(flagValue) {
    const candidates = [
        flagValue && flagValue !== true ? String(flagValue) : null,
        process.env.SRCML_PATH,
        path.resolve(__dirname, "..", "DesignFix-Extension", "bin", "srcml-win", "bin", "srcml.exe"),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return "srcml"; // last resort: whatever is on PATH
}

function isRetryableSrcmlCrash(error) {
    if (typeof error.status !== "number") return false;
    const code = error.status >>> 0;
    return code === WINDOWS_ACCESS_VIOLATION || code === WINDOWS_HEAP_CORRUPTION;
}

function javaToXml(srcmlBinary, filePath) {
    let lastError = null;
    for (let attempt = 1; attempt <= SRCML_MAX_ATTEMPTS; attempt += 1) {
        try {
            return execFileSync(srcmlBinary, [...SRCML_STABLE_ARGS, filePath], {
                encoding: "utf8",
                maxBuffer: SRCML_MAX_BUFFER,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error) {
            lastError = error;
            if (!isRetryableSrcmlCrash(error)) break;
        }
    }
    throw new Error(`srcML failed on ${filePath}: ${lastError && lastError.message}`);
}

// The client receives absolute paths with forward slashes
// (FileChangeManager.ts:173 does filePath.replace(/\\/g, '/')). A rule's
// checkForFilesFolders entries are matched against that exact form, so the
// script must build it identically or scoped rules silently see no files.
function collectJavaFiles(projectRoot) {
    return walkFiles(projectRoot, { excludedDirs: new Set([".git", "node_modules"]) })
        .filter((filePath) => filePath.toLowerCase().endsWith(".java"))
        .filter((filePath) => !IGNORED_JAVA_BASENAMES.has(path.basename(filePath).toLowerCase()))
        .map((filePath) => normalizePath(filePath))
        .sort((left, right) => left.localeCompare(right));
}

// Same scope filter as ruleExecutor.runRulesByTypes, applied before conversion
// rather than after. It is a pure path test, so the result set is identical and
// a scoped rule converts only the files it can possibly match.
function applyScopeFilter(filePaths, rule) {
    const patterns = Array.isArray(rule.checkForFilesFolders) ? rule.checkForFilesFolders : [];
    switch (rule.checkForFilesFoldersConstraints) {
        case "INCLUDE":
            return filePaths.filter((filePath) => patterns.some((pattern) => filePath.indexOf(pattern) !== -1));
        case "EXCLUDE":
            return filePaths.filter((filePath) => !patterns.some((pattern) => filePath.endsWith(pattern)));
        case "NONE":
            return filePaths.slice(0);
        default:
            die(`Rule ${rule.index} has an unsupported checkForFilesFoldersConstraints: `
                + `${JSON.stringify(rule.checkForFilesFoldersConstraints)}`);
            return [];
    }
}

// ------------------------------------------------------- client source bundle

// Dependency order of the executor's module graph. All four are plain relative
// imports with no name collisions, so stripping the module syntax and
// concatenating yields a script the page can evaluate as-is.
const CLIENT_MODULES = [
    "core/coreConstants.js",
    "core/utilities.js",
    "core/ruleExecutorConstants.js",
    "core/ruleExecutor.js",
];

const IMPORT_STATEMENT = /^\s*import[\s\S]*?from\s*["'][^"']+["'];?[ \t]*$/gm;
const BARE_IMPORT = /^\s*import\s+["'][^"']+["'];?[ \t]*$/gm;
const DEFAULT_EXPORT = /^\s*export\s+default\s+[A-Za-z_$][\w$]*\s*;?[ \t]*$/gm;

function buildExecutorBundle(clientSrcRoot) {
    const parts = [];
    for (const relative of CLIENT_MODULES) {
        const filePath = path.join(clientSrcRoot, ...relative.split("/"));
        if (!fs.existsSync(filePath)) die(`Client source not found: ${filePath}`);
        const source = fs.readFileSync(filePath, "utf8")
            .replace(IMPORT_STATEMENT, "")
            .replace(BARE_IMPORT, "")
            .replace(DEFAULT_EXPORT, "")
            .replace(/^\s*export\s+/gm, "");
        // A surviving module keyword would be a syntax error inside the page and
        // the failure would surface as an opaque CDP exception, so catch it here.
        const leftover = source.split(/\r?\n/).find((line) => /^\s*(import|export)\b/.test(line));
        if (leftover) die(`Could not strip module syntax from ${relative}: ${leftover.trim()}`);
        parts.push(`// ===== ${relative} =====\n${source}`);
    }
    return parts.join("\n");
}

// ------------------------------------------------------------ Chromium via CDP

const BROWSER_CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
];

function resolveBrowser(flagValue) {
    const candidates = [
        flagValue && flagValue !== true ? String(flagValue) : null,
        process.env.CHROME_PATH,
        ...BROWSER_CANDIDATES,
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    die("No Chrome or Edge binary found. Pass --browser=<path> or set CHROME_PATH.\n"
        + "A real Chromium engine is required: the rule queries are namespace-prefixed and "
        + "jsdom's XPath ignores namespace resolvers, which would report zero violations for every rule.");
    return null;
}

function launchBrowser(binary) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "designfix-xpath-"));
    const child = spawn(binary, [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    return new Promise((resolve, reject) => {
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Browser did not report a DevTools endpoint within 30s.\n${stderr.slice(-500)}`));
        }, 30000);
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
            const match = /ws:\/\/([^\s/]+)\//.exec(stderr);
            if (!match) return;
            clearTimeout(timer);
            // The endpoint printed on stderr is the BROWSER target, which does not
            // implement Runtime. Only the host:port is useful here; the page
            // target has to be looked up over the HTTP endpoint.
            resolve({ child, userDataDir, hostPort: match[1] });
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Browser exited with code ${code} before reporting an endpoint.\n${stderr.slice(-500)}`));
        });
    });
}

/**
 * Shut the browser down and remove its profile directory. Chrome spawns renderer
 * and GPU children, so killing only the launcher leaves the tree alive on
 * Windows, which in turn keeps a lock on the profile and makes the removal fail
 * silently -- one leaked ~2 MB directory in TEMP per invocation.
 * @param child {import("child_process").ChildProcess}
 * @param userDataDir {string}
 */
async function shutdownBrowser(child, userDataDir) {
    if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        const stillRunning = await Promise.race([
            exited.then(() => false),
            new Promise((resolve) => setTimeout(() => resolve(true), 3000)),
        ]);
        if (stillRunning && process.platform === "win32" && child.pid) {
            try {
                execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            } catch { /* already gone, or not ours to kill */ }
        }
    }
    // The profile can stay locked for a moment after the tree exits.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
    console.error(`Warning: could not remove the temporary browser profile ${userDataDir}`);
}

/**
 * Find a page target's WebSocket URL. Runtime.evaluate only exists on a page
 * session, so connecting to the browser endpoint from stderr fails with
 * "'Runtime.evaluate' wasn't found". The page list can be briefly empty right
 * after launch, hence the retry, and is created explicitly if it stays empty.
 * @param hostPort {string}
 * @return {Promise<string>}
 */
async function resolvePageEndpoint(hostPort) {
    const list = async () => {
        const response = await fetch(`http://${hostPort}/json/list`);
        const targets = await response.json();
        return targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    };
    for (let attempt = 1; attempt <= 20; attempt += 1) {
        const page = await list();
        if (page) return page.webSocketDebuggerUrl;
        if (attempt === 10) {
            try { await fetch(`http://${hostPort}/json/new?about:blank`, { method: "PUT" }); } catch { /* older builds */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`No DevTools page target appeared at ${hostPort}`);
}

// Minimal DevTools client. Node's built-in WebSocket keeps this dependency-free,
// matching the rest of scripts/ (built-in modules only, no npm install).
class DevToolsSession {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        socket.addEventListener("message", (event) => {
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message.id === undefined) return;
            const entry = this.pending.get(message.id);
            if (!entry) return;
            this.pending.delete(message.id);
            if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
            else entry.resolve(message.result);
        });
    }

    static async connect(endpoint) {
        if (typeof WebSocket !== "function") {
            die("This Node build has no global WebSocket (needs Node 22+). Upgrade Node or run with a newer runtime.");
        }
        const socket = new WebSocket(endpoint);
        await new Promise((resolve, reject) => {
            socket.addEventListener("open", resolve, { once: true });
            socket.addEventListener("error", () => reject(new Error(`Could not connect to ${endpoint}`)), { once: true });
        });
        return new DevToolsSession(socket);
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    /** Evaluate an expression, surfacing page-side exceptions as real errors. */
    async evaluate(expression) {
        const result = await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (result.exceptionDetails) {
            const details = result.exceptionDetails;
            const text = (details.exception && (details.exception.description || details.exception.value))
                || details.text;
            throw new Error(`Page evaluation failed: ${text}`);
        }
        return result.result ? result.result.value : undefined;
    }

    close() {
        try { this.socket.close(); } catch { /* already gone */ }
    }
}

// A 100-file project is a couple of MB of XML. Ship it in chunks and reassemble
// in the page rather than betting on one oversized protocol message.
const PAYLOAD_CHUNK_BYTES = 256 * 1024;

async function evaluateRule(session, bundle, payload) {
    await session.evaluate(`${bundle}\n//# sourceURL=designfix-executor.js\nundefined;`);

    const serialized = JSON.stringify(payload);
    await session.evaluate("window.__designfixChunks = []; undefined;");
    for (let offset = 0; offset < serialized.length; offset += PAYLOAD_CHUNK_BYTES) {
        const chunk = serialized.slice(offset, offset + PAYLOAD_CHUNK_BYTES);
        await session.evaluate(`window.__designfixChunks.push(${JSON.stringify(chunk)}); undefined;`);
    }

    // The listing mirrors rulePanel.renderListOfSnippets with no file open
    // (state.filePath === none_filePath), which is the CLI's situation: the
    // per-open-file split collapses and every file's array renders once. Totals
    // mirror renderTabHeader, which sums data.satisfied / data.violated.
    return session.evaluate(`(() => {
        const payload = JSON.parse(window.__designfixChunks.join(""));
        const rules = [payload.rule];
        checkRulesForAll(payload.xmlFiles, rules);
        const rule = rules[0];
        const rows = Array.isArray(rule.xPathQueryResult) ? rule.xPathQueryResult : [];
        const listing = (key) => rows.flatMap((row) => (row.data[key] || []).map((entry) => ({
            filePath: row.filePath,
            snippet: entry.snippet,
        })));
        let totalSatisfied = 0, totalViolated = 0, totalQuantifier = 0;
        for (const row of rows) {
            totalSatisfied += row.data.satisfied;
            totalViolated += row.data.violated;
            totalQuantifier += (row.data.quantifierResult || []).length;
        }
        return JSON.stringify({
            violations: listing("violatedResult"),
            satisfying: listing("satisfiedResult"),
            totals: {
                satisfied: totalSatisfied,
                violated: totalViolated,
                quantifierMatches: totalQuantifier,
                rowCount: rows.length,
            },
            descriptionAfterRun: rule.description,
        });
    })()`);
}

// -------------------------------------------------------------------- reporting

function groupByFile(entries, projectRoot) {
    const grouped = new Map();
    for (const entry of entries) {
        const relative = normalizePath(path.relative(projectRoot, entry.filePath)) || entry.filePath;
        if (!grouped.has(relative)) grouped.set(relative, []);
        grouped.get(relative).push(entry.snippet);
    }
    return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function printGroup(title, entries, projectRoot, badgeCount) {
    const grouped = groupByFile(entries, projectRoot);
    console.log(`\n${title}: ${entries.length} listed across ${grouped.length} file(s)`);
    if (badgeCount !== undefined && badgeCount !== entries.length) {
        console.log(`  note: the dashboard badge shows ${badgeCount}. The badge is a derived count `
            + `(quantifier matches minus violations) while this list is the array the tab renders; `
            + `they diverge when two matched nodes share the same first two lines.`);
    }
    if (!entries.length) {
        console.log("  (none)");
        return;
    }
    for (const [relative, snippets] of grouped) {
        console.log(`\n  ${relative}  (${snippets.length})`);
        snippets.forEach((snippet, index) => {
            const lines = String(snippet == null ? "" : snippet).split(/\r?\n/);
            console.log(`    [${index + 1}] ${lines[0]}`);
            for (const line of lines.slice(1)) console.log(`        ${line}`);
        });
    }
}

// ------------------------------------------------------------------------ main

async function main() {
    const { flags, positionals } = parseArgs(process.argv.slice(2));
    if (flags.help) { help(); process.exit(0); }
    if (positionals.length) die(`Unexpected positional arguments: ${positionals.join(", ")}`);

    const ruleId = requiredString(flags.rule, "--rule=<id>");
    const asJson = Boolean(flags.json);
    const showSatisfying = Boolean(flags["show-satisfying"]);

    // Both inputs are explicit by design. Nothing here falls back to an
    // environment variable, the working directory, or a filesystem search: the
    // machine holds several copies of the same study project (backups, an
    // untouched original, older versions), and an inferred root would silently
    // produce a violation set belonging to a different project.
    const projectRootArg = requiredString(flags["project-root"], "--project-root=<path>");
    const projectRoot = path.resolve(projectRootArg);
    if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
        die(`Project root is not an existing directory: ${projectRoot}`);
    }

    const ruleTablePath = flags["rule-table"] && flags["rule-table"] !== true
        ? path.resolve(String(flags["rule-table"]))
        : path.join(projectRoot, "ruleTable.json");
    if (!fs.existsSync(ruleTablePath) || !fs.statSync(ruleTablePath).isFile()) {
        die(`No ruleTable.json at ${ruleTablePath}. Point --project-root at the target Java project `
            + "(the folder holding ruleTable.json), or pass --rule-table=<path>.");
    }

    let rules;
    try {
        const parsed = JSON.parse(fs.readFileSync(ruleTablePath, "utf8"));
        rules = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rules) ? parsed.rules : [];
    } catch (error) {
        die(`Failed to read ${ruleTablePath}: ${error.message}`);
    }
    const rule = rules.find((candidate) => candidate && String(candidate.index) === String(ruleId));
    if (!rule) {
        die(`Rule ${ruleId} was not found in ${ruleTablePath}. Available: `
            + rules.map((r) => r && r.index).filter((index) => index !== undefined).join(", "));
    }

    const clientSrcRoot = path.resolve(__dirname, "..", "DesignFix-client", "src");
    const bundle = buildExecutorBundle(clientSrcRoot);

    const allJavaFiles = collectJavaFiles(normalizePath(projectRoot));
    const scopedFiles = applyScopeFilter(allJavaFiles, rule);
    if (!scopedFiles.length) {
        die(`No .java file is in scope for rule ${ruleId} `
            + `(${rule.checkForFilesFoldersConstraints} ${JSON.stringify(rule.checkForFilesFolders)}; `
            + `${allJavaFiles.length} Java file(s) in the project).`);
    }

    if (!asJson) {
        console.log(`Rule ${rule.index}: ${rule.title || "(untitled)"}`);
        console.log(`  scope: ${rule.checkForFilesFoldersConstraints} `
            + `${JSON.stringify(rule.checkForFilesFolders || [])}, mode ${rule.processFilesFolders}`);
        console.log(`  converting ${scopedFiles.length} of ${allJavaFiles.length} Java file(s) with srcML...`);
    }

    const srcmlBinary = resolveSrcml(flags.srcml);
    const xmlFiles = scopedFiles.map((filePath) => ({ filePath, xml: javaToXml(srcmlBinary, filePath) }));

    const browserBinary = resolveBrowser(flags.browser);
    const { child, userDataDir, hostPort } = await launchBrowser(browserBinary);
    let session = null;
    let raw = null;
    try {
        session = await DevToolsSession.connect(await resolvePageEndpoint(hostPort));
        raw = await evaluateRule(session, bundle, { rule, xmlFiles });
    } finally {
        if (session) {
            // Graceful first: Browser.close lets Chrome release the profile lock
            // before the process tree is torn down.
            try { await session.send("Browser.close"); } catch { /* fall through to kill */ }
            session.close();
        }
        await shutdownBrowser(child, userDataDir);
    }

    const result = JSON.parse(raw);

    // The executor marks a rule whose XPath will not compile by appending to its
    // description instead of throwing, which otherwise looks like "0 violations".
    const invalidMarker = "<XPATH query is not valid";
    if (String(result.descriptionAfterRun || "").includes(invalidMarker)) {
        die(`Rule ${ruleId} has an invalid XPath query, so it was never evaluated. `
            + `The executor reports: ${String(result.descriptionAfterRun).slice(-120)}`);
    }

    if (asJson) {
        const relativize = (entry) => ({
            filePath: normalizePath(path.relative(projectRoot, entry.filePath)) || entry.filePath,
            snippet: entry.snippet,
        });
        process.stdout.write(`${JSON.stringify({
            rule: { index: rule.index, title: rule.title || "", processFilesFolders: rule.processFilesFolders },
            filesScanned: scopedFiles.length,
            filesInProject: allJavaFiles.length,
            totals: result.totals,
            violations: result.violations.map(relativize),
            ...(showSatisfying ? { satisfying: result.satisfying.map(relativize) } : {}),
        }, null, 2)}\n`);
        return;
    }

    console.log(`  quantifier matches: ${result.totals.quantifierMatches}, `
        + `satisfied: ${result.totals.satisfied}, violated: ${result.totals.violated}`);
    printGroup("VIOLATIONS", result.violations, projectRoot, result.totals.violated);
    if (showSatisfying) {
        printGroup("SATISFYING EXAMPLES", result.satisfying, projectRoot, result.totals.satisfied);
    } else if (result.satisfying.length) {
        console.log(`\n(${result.satisfying.length} satisfying example(s) not shown; pass --show-satisfying)`);
    }
}

main().catch((error) => {
    console.error(`Error: ${error && error.message ? error.message : error}`);
    process.exit(1);
});
