"use strict";

// Shared checker engine for the prompt-generation scripts.
//
// Nothing here reimplements the checker or the prompts. It reproduces the
// extension's inputs (one srcML document per .java file, same binary and flags)
// and runs the client's own ruleExecutor.js inside a real browser engine, which
// is required because every rule query is namespace-prefixed (src:...) and
// jsdom's Document.evaluate ignores namespace resolvers, silently reporting zero
// violations for every rule. It also loads the client's own fixPrompts.js and
// editProtocol.js instead of copying their text, so a generated Final prompt
// cannot drift from the prompt DesignFix sends.

const {
    fs, path, crypto, die, normalizePath, walkFiles, sha256Buffer, readJson, writeJson,
} = require("./cline_common");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

const CLIENT_SRC = path.resolve(__dirname, "..", "DesignFix-client", "src");
const CACHE_DIR = path.resolve(__dirname, ".prompt_cache");
const CACHE_VERSION = 1;

// ---------------------------------------------------------------- srcML input

// The extension's own flags (DesignFix-Extension/src/srcmlRunner.ts). --in-order
// and --max-threads 1 are load-bearing: they make srcML deterministic, and the
// snippet strings compared downstream are serialized XML.
const SRCML_STABLE_ARGS = ["--max-threads", "1", "--in-order", "--language", "Java"];
const SRCML_MAX_BUFFER = 64 * 1024 * 1024;
const SRCML_MAX_ATTEMPTS = 3;
const WINDOWS_ACCESS_VIOLATION = 0xC0000005;
const WINDOWS_HEAP_CORRUPTION = 0xC0000374;

// Scratch files the extension writes into the project and excludes from its own
// snapshot (Constants.TEMP_JAVA_FILE / TEMP_JAVA_FILE_TESTING).
const IGNORED_JAVA_BASENAMES = new Set(["tempexprfile.java", "temptestfile.java"]);

function resolveSrcml() {
    const candidates = [
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

// The client receives absolute paths with forward slashes (FileChangeManager.ts
// does filePath.replace(/\\/g, '/')). A rule's checkForFilesFolders entries are
// matched against that exact form, so this must build it identically or a scoped
// rule silently sees no files.
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
            throw new Error(`Rule ${rule.index} has an unsupported checkForFilesFoldersConstraints: `
                + `${JSON.stringify(rule.checkForFilesFoldersConstraints)}`);
    }
}

// ------------------------------------------------------- client source loading

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

function stripModuleSyntax(source) {
    return source
        .replace(IMPORT_STATEMENT, "")
        .replace(BARE_IMPORT, "")
        .replace(DEFAULT_EXPORT, "")
        .replace(/^\s*export\s+/gm, "");
}

function buildExecutorBundle() {
    const parts = [];
    for (const relative of CLIENT_MODULES) {
        const filePath = path.join(CLIENT_SRC, ...relative.split("/"));
        if (!fs.existsSync(filePath)) die(`Client source not found: ${filePath}`);
        const source = stripModuleSyntax(fs.readFileSync(filePath, "utf8"));
        // A surviving module keyword would be a syntax error inside the page and
        // the failure would surface as an opaque CDP exception, so catch it here.
        const leftover = source.split(/\r?\n/).find((line) => /^\s*(import|export)\b/.test(line));
        if (leftover) die(`Could not strip module syntax from ${relative}: ${leftover.trim()}`);
        parts.push(`// ===== ${relative} =====\n${source}`);
    }
    return parts.join("\n");
}

/**
 * Load the client's own prompt builders and edit protocol into this process.
 * Both are dependency-free ES modules, so stripping `export` yields evaluable
 * CommonJS.
 */
function loadClientPromptModules() {
    const load = (relative, exported) => {
        const filePath = path.join(CLIENT_SRC, ...relative.split("/"));
        if (!fs.existsSync(filePath)) die(`Client source not found: ${filePath}`);
        const source = stripModuleSyntax(fs.readFileSync(filePath, "utf8"));
        try {
            // eslint-disable-next-line no-new-func
            return new Function(`${source}\nreturn { ${exported.join(", ")} };`)();
        } catch (error) {
            die(`Could not load ${relative}: ${error.message}`);
            return null;
        }
    };
    const prompts = load("activeLLM/fixPrompts.js", ["buildFixAnalysisPrompt", "buildEditStructuringPrompt"]);
    const protocol = load("activeLLM/editProtocol.js", ["EDIT_PROTOCOL_VERSION", "buildCandidateManifest", "normalizeFilePath"]);
    return { ...prompts, ...protocol };
}

/** Port of Utilities.removeSrcmlAnnotations (DesignFix-client/src/core/utilities.js). */
function removeSrcmlAnnotations(xmlString) {
    if (xmlString === null || xmlString === undefined) return "";
    return String(xmlString)
        .replace(/<[^>]*>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
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

function resolveBrowser() {
    const candidates = [process.env.CHROME_PATH, ...BROWSER_CANDIDATES].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    die("No Chrome or Edge binary found. Set CHROME_PATH.\n"
        + "A real Chromium engine is required: the rule queries are namespace-prefixed and "
        + "jsdom's XPath ignores namespace resolvers, which would report zero violations for every rule.");
    return null;
}

function launchBrowser(binary) {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "designfix-prompt-"));
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
            // The endpoint printed on stderr is the BROWSER target, which does
            // not implement Runtime. Only host:port is useful; the page target
            // has to be looked up over the HTTP endpoint.
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
 * Windows, which keeps a lock on the profile and makes removal fail silently.
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

async function evaluateRuleInPage(session, bundle, payload) {
    await session.evaluate(`${bundle}\n//# sourceURL=designfix-executor.js\nundefined;`);

    const serialized = JSON.stringify(payload);
    await session.evaluate("window.__designfixChunks = []; undefined;");
    for (let offset = 0; offset < serialized.length; offset += PAYLOAD_CHUNK_BYTES) {
        const chunk = serialized.slice(offset, offset + PAYLOAD_CHUNK_BYTES);
        await session.evaluate(`window.__designfixChunks.push(${JSON.stringify(chunk)}); undefined;`);
    }

    // Unlike list_rule_snippets.js this keeps surroundingNodes: the prompts need
    // the enclosing structure, and rulePanel passes a satisfying entry's
    // surroundingNodes (not its snippet) to suggestFix as the positive example.
    return session.evaluate(`(() => {
        const payload = JSON.parse(window.__designfixChunks.join(""));
        const rules = [payload.rule];
        checkRulesForAll(payload.xmlFiles, rules);
        const rule = rules[0];
        const rows = Array.isArray(rule.xPathQueryResult) ? rule.xPathQueryResult : [];
        const entries = (row, key) => (row.data[key] || []).map((entry) => ({
            snippet: entry.snippet,
            surroundingNodes: entry.surroundingNodes,
        }));
        return JSON.stringify({
            rows: rows.map((row) => ({
                filePath: row.filePath,
                violated: entries(row, "violatedResult"),
                satisfied: entries(row, "satisfiedResult"),
                satisfiedCount: row.data.satisfied,
                violatedCount: row.data.violated,
            })),
            descriptionAfterRun: rule.description,
        });
    })()`);
}

// -------------------------------------------------------------- rule resolution

function loadRules(ruleTablePath) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(ruleTablePath, "utf8"));
    } catch (error) {
        die(`Failed to read ${ruleTablePath}: ${error.message}`);
    }
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.rules) ? parsed.rules : [];
}

function resolveRule(ruleTablePath, ruleId) {
    const rules = loadRules(ruleTablePath);
    const rule = rules.find((candidate) => candidate && String(candidate.index) === String(ruleId));
    if (!rule) {
        die(`Rule ${ruleId} was not found in ${ruleTablePath}. Available: `
            + rules.map((r) => r && r.index).filter((index) => index !== undefined).join(", "));
    }
    return rule;
}

// Content-addressed cache key. A checker run costs one srcML pass plus a Chrome
// launch, and a full sweep asks for the same rule seven times per violation, so
// the result is cached against the exact bytes it was computed from: change any
// scoped source file or the rule's own queries and the key changes.
function corpusFingerprint(rule, scopedFiles) {
    const hash = crypto.createHash("sha256");
    hash.update(JSON.stringify({
        cacheVersion: CACHE_VERSION,
        index: rule.index,
        quantifier: rule.quantifierXPathQuery,
        constraint: rule.constraintXPathQuery,
        folders: rule.checkForFilesFolders,
        folderConstraint: rule.checkForFilesFoldersConstraints,
        processFilesFolders: rule.processFilesFolders,
    }));
    for (const filePath of scopedFiles) {
        hash.update(filePath);
        hash.update(sha256Buffer(fs.readFileSync(filePath)));
    }
    return hash.digest("hex");
}

function cachePathFor(rule, fingerprint) {
    const safeIndex = String(rule.index).replace(/[^A-Za-z0-9._-]+/g, "_");
    return path.join(CACHE_DIR, `rule_${safeIndex}_${fingerprint.slice(0, 16)}.json`);
}

/**
 * Run one rule over a project and return the executor's rows plus each scoped
 * file's content as the client would reconstruct it (srcML round-tripped through
 * removeSrcmlAnnotations, which is what the tool feeds the model, leading blank
 * line included).
 * @return {Promise<{rule, rows, files, filesScanned:number, filesInProject:number, cacheHit:boolean}>}
 */
async function runRule({ projectRoot, rule, refreshCache = false }) {
    const allJavaFiles = collectJavaFiles(normalizePath(projectRoot));
    const scopedFiles = applyScopeFilter(allJavaFiles, rule);
    if (!scopedFiles.length) {
        die(`No .java file is in scope for rule ${rule.index} `
            + `(${rule.checkForFilesFoldersConstraints} ${JSON.stringify(rule.checkForFilesFolders)}; `
            + `${allJavaFiles.length} Java file(s) in the project).`);
    }

    const cacheFile = cachePathFor(rule, corpusFingerprint(rule, scopedFiles));
    if (!refreshCache) {
        const cached = readJson(cacheFile, null);
        if (cached && cached.cacheVersion === CACHE_VERSION) {
            return {
                rule,
                rows: cached.rows,
                files: cached.files,
                filesScanned: scopedFiles.length,
                filesInProject: allJavaFiles.length,
                cacheHit: true,
            };
        }
    }

    const srcmlBinary = resolveSrcml();
    const xmlFiles = scopedFiles.map((filePath) => ({ filePath, xml: javaToXml(srcmlBinary, filePath) }));

    const bundle = buildExecutorBundle();
    const { child, userDataDir, hostPort } = await launchBrowser(resolveBrowser());
    let session = null;
    let raw = null;
    try {
        session = await DevToolsSession.connect(await resolvePageEndpoint(hostPort));
        raw = await evaluateRuleInPage(session, bundle, { rule, xmlFiles });
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
    if (String(result.descriptionAfterRun || "").includes("<XPATH query is not valid")) {
        die(`Rule ${rule.index} has an invalid XPath query, so it was never evaluated. `
            + `The executor reports: ${String(result.descriptionAfterRun).slice(-120)}`);
    }

    // Store the reconstructed text, not the srcML, so the cache stays about the
    // size of the corpus instead of several times larger.
    const files = xmlFiles.map((file) => ({
        filePath: file.filePath,
        content: removeSrcmlAnnotations(file.xml),
    }));

    try {
        writeJson(cacheFile, { cacheVersion: CACHE_VERSION, rows: result.rows, files });
    } catch (error) {
        console.error(`Warning: could not write the checker cache (${error.message}). Continuing.`);
    }

    return {
        rule,
        rows: result.rows,
        files,
        filesScanned: scopedFiles.length,
        filesInProject: allJavaFiles.length,
        cacheHit: false,
    };
}

// ------------------------------------------------------------ input selection

/**
 * Pick the violation a prompt will describe. Matches by path suffix so a
 * project-relative argument works, and refuses to guess when nothing matches.
 */
function selectViolation(rows, projectRoot, violationFileArg, index = 1) {
    const wanted = normalizePath(violationFileArg);
    const withViolations = rows.filter((row) => row.violated.length > 0);
    if (!withViolations.length) die("The checker reports no violations of this rule anywhere in the project.");

    const matches = withViolations.filter((row) => {
        const rowPath = normalizePath(row.filePath);
        return rowPath === wanted
            || rowPath.endsWith(`/${wanted.replace(/^\.?\//, "")}`)
            || normalizePath(path.relative(projectRoot, row.filePath)) === wanted.replace(/^\.?\//, "");
    });
    if (!matches.length) {
        die(`No violation of this rule in ${violationFileArg}. Files that do violate it:\n`
            + withViolations.map((row) => `  ${normalizePath(path.relative(projectRoot, row.filePath))} `
                + `(${row.violated.length})`).join("\n"));
    }
    if (matches.length > 1) {
        die(`Ambiguous violation file: ${violationFileArg} matched `
            + matches.map((row) => normalizePath(path.relative(projectRoot, row.filePath))).join(", "));
    }

    const row = matches[0];
    if (index < 1 || index > row.violated.length) {
        die(`--index=${index} is out of range: that file holds ${row.violated.length} violation(s) of this rule.`);
    }

    // Position of this violation among all of the rule's violations, in the
    // checker's own order. Gives each one a stable number that does not depend on
    // which file it lives in, so results can be filed under violation_<nn>.
    let ordinal = 0;
    let position = 0;
    for (const candidate of rows) {
        for (let i = 0; i < candidate.violated.length; i += 1) {
            position += 1;
            if (candidate.filePath === row.filePath && i + 1 === index) ordinal = position;
        }
    }

    return { row, entry: row.violated[index - 1], index, total: row.violated.length, ordinal };
}

/**
 * Pick the rule-satisfying example: the first row with a satisfying result,
 * mirroring rulePanel.renderListOfSnippets with no file open. Deliberately not
 * configurable, so every variant and every trial for a given violation shows the
 * same example. The live dashboard overrides this with the currently open file
 * when that file also satisfies the rule, which a headless run cannot observe.
 *
 * The example is the entry's surroundingNodes, which is what rulePanel passes to
 * suggestFix. Its snippet is the first two non-blank lines with annotations
 * stripped, so for an annotation rule the snippet can omit the very construct
 * the rule is about.
 */
function selectExample(rows) {
    const row = rows.find((candidate) => candidate.satisfied.length > 0);
    return row ? { row, entry: row.satisfied[0] } : null;
}

/**
 * Verbatim port of rulePanel.gatherFixSiteFiles, kept in lockstep with it so the
 * Final prompt's related-file block is what DesignFix would have sent, including
 * the quirk that a file offered as a "correct example" may itself violate the
 * rule (see measureFinalPromptExposure).
 */
function gatherFixSiteFiles(rule, violationFilePath, files, rows) {
    const MAX_FILES = 4;
    const norm = (p) => (p || "").replace(/\\/g, "/");
    const violationNorm = norm(violationFilePath);
    const picked = new Map();

    const findByPath = (targetPath) => {
        const wanted = norm(targetPath);
        const exact = files.find((file) => norm(file.filePath) === wanted);
        if (exact) return exact;
        const base = wanted.split("/").pop();
        return files.find((file) => norm(file.filePath).endsWith(`/${base}`));
    };

    const addFile = (file, reason) => {
        if (!file || picked.size >= MAX_FILES) return false;
        const normalized = norm(file.filePath);
        if (normalized === violationNorm || picked.has(normalized)) return false;
        picked.set(normalized, {
            filePath: file.filePath,
            content: file.content,
            reason,
        });
        return true;
    };

    // 1) Class names referenced by the constraint XPath (excluding <TEMP>).
    const constraintXPath = Array.isArray(rule.constraintXPathQuery)
        ? rule.constraintXPathQuery.join(" ")
        : (rule.constraintXPathQuery || "");
    const classNames = new Set();
    const pattern = /text\(\)\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
    let match;
    while ((match = pattern.exec(constraintXPath)) !== null) {
        if (match[1] !== "<TEMP>") classNames.add(match[1]);
    }
    classNames.forEach((name) => {
        const wanted = `${name.toLowerCase()}.java`;
        const file = files.find((candidate) => norm(candidate.filePath).split("/").pop().toLowerCase() === wanted);
        addFile(file, `named in the rule constraint (${name}) - likely fix site`);
    });

    // 2) Files that already pass this rule, as the correct pattern in context.
    let exampleCount = 0;
    for (const row of rows) {
        if (exampleCount >= 2 || picked.size >= MAX_FILES) break;
        if (!row.satisfied.length) continue;
        if (norm(row.filePath) === violationNorm) continue;
        if (addFile(findByPath(row.filePath), "satisfies this rule (correct example)")) exampleCount++;
    }

    // 3) Files under the rule's checked folders, outside the violation's folder.
    const folders = Array.isArray(rule.checkForFilesFolders) ? rule.checkForFilesFolders : [];
    const violationFolder = violationNorm.substring(0, violationNorm.lastIndexOf("/"));
    for (const folder of folders) {
        if (picked.size >= MAX_FILES) break;
        const normalizedFolder = norm(folder);
        if (!normalizedFolder || violationFolder.indexOf(normalizedFolder) !== -1) continue;
        let count = 0;
        for (const file of files) {
            if (count >= 2 || picked.size >= MAX_FILES) break;
            if (norm(file.filePath).indexOf(normalizedFolder) !== -1 && addFile(file, "in the rule scope")) count++;
        }
    }

    return Array.from(picked.values());
}

/**
 * How many OTHER violations of the same rule a Final prompt would expose for
 * this violation, through its full-file block and its related-file block. The
 * six single-step prompts show exactly one violation, so a non-zero count means
 * that instance is not a like-for-like comparison across prompt variants.
 */
function measureFinalPromptExposure(rows, violationRow, fixSiteFiles) {
    const norm = (p) => (p || "").replace(/\\/g, "/");
    const byPath = new Map(rows.map((row) => [norm(row.filePath), row.violated.length]));
    const sameFile = Math.max(0, (byPath.get(norm(violationRow.filePath)) || 0) - 1);
    const inRelated = fixSiteFiles.reduce((total, file) => total + (byPath.get(norm(file.filePath)) || 0), 0);
    return {
        extraInViolationFile: sameFile,
        inRelatedFiles: inRelated,
        total: sameFile + inRelated,
        relatedFilesThatViolate: fixSiteFiles
            .filter((file) => (byPath.get(norm(file.filePath)) || 0) > 0)
            .map((file) => file.filePath),
    };
}

module.exports = {
    resolveRule,
    runRule,
    selectViolation,
    selectExample,
    gatherFixSiteFiles,
    measureFinalPromptExposure,
    removeSrcmlAnnotations,
    loadClientPromptModules,
};
