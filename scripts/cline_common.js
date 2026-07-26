"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");

function parseArgs(argv) {
    const flags = {};
    const positionals = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            positionals.push(arg);
            continue;
        }
        const body = arg.slice(2);
        const eq = body.indexOf("=");
        if (eq >= 0) {
            flags[body.slice(0, eq)] = body.slice(eq + 1);
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
            flags[body] = next;
            i += 1;
        } else {
            flags[body] = true;
        }
    }
    return { flags, positionals };
}

function die(message, code = 1) {
    console.error(`Error: ${message}`);
    process.exit(code);
}

function requiredString(value, name) {
    if (value === undefined || value === true || String(value).trim() === "") {
        die(`${name} is required.`);
    }
    return String(value).trim();
}

function positiveInteger(value, name) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) die(`${name} must be a positive integer.`);
    return n;
}

function parseBoolean(value, name, defaultValue = false) {
    if (value === undefined) return defaultValue;
    if (value === true) return true;
    const v = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(v)) return true;
    if (["0", "false", "no", "n"].includes(v)) return false;
    die(`${name} must be true or false.`);
}

function sanitizeComponent(value) {
    return String(value)
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "unknown";
}

function normalizeText(value) {
    return String(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function normalizePath(value) {
    return String(value || "").replace(/\\/g, "/");
}

function sha256Buffer(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256Text(text) {
    return sha256Buffer(Buffer.from(String(text), "utf8"));
}

let atomicWriteCounter = 0;

function atomicWrite(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Counter rather than a clock: a crashed write must not leave an epoch-named
    // temp file behind inside a run folder.
    atomicWriteCounter += 1;
    const tmp = `${filePath}.tmp-${process.pid}-${atomicWriteCounter}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, value) {
    atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isInside(child, parent) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function nextRunNumber(ruleDir) {
    if (!fs.existsSync(ruleDir)) return 1;
    const nums = fs.readdirSync(ruleDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => /^run_(\d+)$/.exec(e.name))
        .filter(Boolean)
        .map((m) => Number(m[1]))
        .filter(Number.isInteger);
    return nums.length ? Math.max(...nums) + 1 : 1;
}

function tryGit(projectRoot, args) {
    if (!projectRoot) return null;
    try {
        return execFileSync("git", ["-C", projectRoot, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: 64 * 1024 * 1024,
        }).trimEnd();
    } catch {
        return null;
    }
}

function copyToClipboard(text) {
    const options = process.platform === "win32"
        ? [{ cmd: "clip", args: [] }]
        : process.platform === "darwin"
            ? [{ cmd: "pbcopy", args: [] }]
            : [
                { cmd: "wl-copy", args: [] },
                { cmd: "xclip", args: ["-selection", "clipboard"] },
                { cmd: "xsel", args: ["--clipboard", "--input"] },
            ];
    for (const option of options) {
        const result = spawnSync(option.cmd, option.args, {
            input: text,
            encoding: "utf8",
            stdio: ["pipe", "ignore", "ignore"],
        });
        if (!result.error && result.status === 0) return option.cmd;
    }
    return null;
}

function resolveWorkspaceRoot() {
    // These scripts live at <workspace-root>/scripts/*.js, where the workspace
    // root also contains the DesignFix-client and DesignFix-Extension folders.
    return path.resolve(__dirname, "..");
}

// Backwards-compatible alias; several callers still import resolveClientRoot.
function resolveClientRoot() {
    return resolveWorkspaceRoot();
}

function defaultDataRoot() {
    // Sibling of the two repo folders. Ignored via /cline_data in each repo's
    // .gitignore; kept at the workspace root so it sits beside DesignFix's data/.
    return path.join(resolveWorkspaceRoot(), "cline_data");
}

function resolveProjectRoot(flagValue) {
    const workspaceRoot = resolveWorkspaceRoot();
    const parent = path.dirname(workspaceRoot);
    const candidates = [
        flagValue && flagValue !== true ? String(flagValue) : null,
        process.env.DESIGNFIX_TARGET_PROJECT_ROOT,
        process.env.CROWDCODING_PROJECT_ROOT,
        fs.existsSync(path.join(process.cwd(), "ruleTable.json")) ? process.cwd() : null,
        path.join(parent, "CrowdCoding-ActiveDocumentation"),
        path.join(parent, "CrowdCoding"),
        path.join(workspaceRoot, "CrowdCoding-ActiveDocumentation"),
        path.join(workspaceRoot, "CrowdCoding"),
    ].filter(Boolean);
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
    }
    return null;
}

function resolveRuleTable(flagValue, projectRoot) {
    const candidates = [
        flagValue && flagValue !== true ? String(flagValue) : null,
        process.env.CROWDCODING_RULE_TABLE,
        process.env.DESIGNFIX_RULE_TABLE,
        projectRoot ? path.join(projectRoot, "ruleTable.json") : null,
    ].filter(Boolean);
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    }
    return null;
}

// Path recorded inside a run folder, always relative to the target project.
// Anything outside the project root degrades to its basename so no machine path
// reaches cline_data.
function projectRelativePath(projectRoot, targetPath) {
    if (!projectRoot || !targetPath) return "";
    const rel = normalizePath(path.relative(projectRoot, targetPath));
    if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
        return normalizePath(path.basename(targetPath));
    }
    return rel;
}

// Collection-time project root. A run folder stores no absolute project path,
// so the root must be supplied explicitly (flag or environment) or inferred
// from a working directory that holds the target project's ruleTable.json. The
// generator's positional guesses are deliberately NOT reused here: silently
// pointing the collector at a different checkout would attribute some other
// workspace's diff to this run.
function resolveCollectionProjectRoot(flagValue) {
    const candidates = [
        flagValue && flagValue !== true ? String(flagValue) : null,
        process.env.DESIGNFIX_TARGET_PROJECT_ROOT,
        process.env.CROWDCODING_PROJECT_ROOT,
        fs.existsSync(path.join(process.cwd(), "ruleTable.json")) ? process.cwd() : null,
    ].filter(Boolean);
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
    }
    return null;
}

// Provenance check that replaces the project path a run no longer stores: the
// baseline snapshot's relative paths must still resolve under the supplied root.
// Some tolerance is required because a repair may legitimately delete files.
function checkProjectRootAgainstBaseline(projectRoot, baselineDir, options = {}) {
    const sampleSize = options.sampleSize ?? 40;
    const manifest = readJson(path.join(baselineDir, "manifest.json"), null);
    const files = manifest && Array.isArray(manifest.files) ? manifest.files : [];
    if (!files.length) return { ok: true, checked: 0, missing: [], reason: "no baseline manifest to compare against" };
    const step = Math.max(1, Math.floor(files.length / sampleSize));
    const sample = [];
    for (let i = 0; i < files.length && sample.length < sampleSize; i += step) sample.push(files[i].path);
    const missing = sample.filter((rel) => !fs.existsSync(path.join(projectRoot, ...rel.split("/"))));
    return { ok: missing.length <= Math.floor(sample.length / 5), checked: sample.length, missing, reason: "" };
}

const DEFAULT_EXCLUDED_DIRS = new Set([
    ".git", "node_modules", "build", "dist", "out", "target", ".gradle",
    ".idea", ".vscode", ".classpath", ".project", ".settings",
    "coverage", ".cache", ".next", ".turbo", "bin", "obj",
]);

const TEXTISH_EXTENSIONS = new Set([
    ".java", ".kt", ".kts", ".groovy", ".gradle", ".xml", ".json",
    ".jsonl", ".yaml", ".yml", ".properties", ".txt", ".md", ".csv",
    ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".scss", ".sql",
    ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1", ".py", ".rb",
    ".go", ".rs", ".c", ".cc", ".cpp", ".h", ".hpp", ".toml",
]);

const TEXTISH_BASENAMES = new Set([
    "gradlew", "mvnw", "makefile", "dockerfile", ".gitignore", ".gitattributes",
]);

// Scratch files the DesignFix extension writes into the target project root
// (see DesignFix-Extension/src/Constants.ts). They are not part of the target
// codebase; excluding them keeps snapshots and workspace diffs free of noise
// if the extension is active while a Cline task runs.
const DESIGNFIX_SCRATCH_BASENAMES = new Set([
    "tempexprfile.java", "tempresultxmlfile.xml", "temptestfile.java", "output.xml",
]);

function looksBinary(buffer) {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    for (const byte of sample) if (byte === 0) return true;
    return false;
}

function shouldSnapshotFile(filePath, stat, maxBytes) {
    if (!stat.isFile() || stat.size > maxBytes) return false;
    const base = path.basename(filePath).toLowerCase();
    if (DESIGNFIX_SCRATCH_BASENAMES.has(base)) return false;
    const ext = path.extname(base);
    return TEXTISH_EXTENSIONS.has(ext) || TEXTISH_BASENAMES.has(base) || ext === "";
}

function walkFiles(root, options = {}) {
    const excludedDirs = options.excludedDirs || DEFAULT_EXCLUDED_DIRS;
    const maxDepth = options.maxDepth ?? 50;
    const files = [];
    function visit(dir, depth) {
        if (depth > maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (excludedDirs.has(entry.name)) continue;
                visit(full, depth + 1);
            } else if (entry.isFile()) {
                files.push(full);
            }
        }
    }
    visit(path.resolve(root), 0);
    return files;
}

function snapshotWorkspace(projectRoot, snapshotDir, options = {}) {
    const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    const filesRoot = path.join(snapshotDir, "files");
    fs.mkdirSync(filesRoot, { recursive: true });
    const manifest = [];
    for (const filePath of walkFiles(projectRoot)) {
        const stat = fs.statSync(filePath);
        if (!shouldSnapshotFile(filePath, stat, maxBytes)) continue;
        const buffer = fs.readFileSync(filePath);
        if (looksBinary(buffer)) continue;
        const rel = normalizePath(path.relative(projectRoot, filePath));
        const dest = path.join(filesRoot, ...rel.split("/"));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buffer);
        manifest.push({
            path: rel,
            sha256: sha256Buffer(buffer),
            size: buffer.length,
        });
    }
    manifest.sort((a, b) => a.path.localeCompare(b.path));
    // Content identity only: no project path, no creation time, no file mtimes.
    // Change detection uses sha256, so nothing here needs a clock.
    writeJson(path.join(snapshotDir, "manifest.json"), {
        fileCount: manifest.length,
        files: manifest,
    });
    return manifest;
}

function currentWorkspaceManifest(projectRoot, options = {}) {
    const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    const manifest = [];
    for (const filePath of walkFiles(projectRoot)) {
        const stat = fs.statSync(filePath);
        if (!shouldSnapshotFile(filePath, stat, maxBytes)) continue;
        const buffer = fs.readFileSync(filePath);
        if (looksBinary(buffer)) continue;
        manifest.push({
            path: normalizePath(path.relative(projectRoot, filePath)),
            sha256: sha256Buffer(buffer),
            size: buffer.length,
        });
    }
    manifest.sort((a, b) => a.path.localeCompare(b.path));
    return manifest;
}

function compareWorkspaceToBaseline(projectRoot, baselineDir) {
    const baseline = readJson(path.join(baselineDir, "manifest.json"), { files: [] });
    const current = currentWorkspaceManifest(projectRoot);
    const before = new Map((baseline.files || []).map((f) => [f.path, f]));
    const after = new Map(current.map((f) => [f.path, f]));
    const paths = new Set([...before.keys(), ...after.keys()]);
    const changes = [];
    for (const rel of [...paths].sort()) {
        const oldFile = before.get(rel);
        const newFile = after.get(rel);
        if (!oldFile) changes.push({ path: rel, type: "added", before: null, after: newFile });
        else if (!newFile) changes.push({ path: rel, type: "deleted", before: oldFile, after: null });
        else if (oldFile.sha256 !== newFile.sha256) changes.push({ path: rel, type: "modified", before: oldFile, after: newFile });
    }
    return { baseline, current, changes };
}

function getGlobalStorageRoots() {
    const home = os.homedir();
    const roots = [];
    if (process.platform === "win32") {
        const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
        for (const product of ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"]) {
            roots.push(path.join(appData, product, "User", "globalStorage"));
        }
    } else if (process.platform === "darwin") {
        const base = path.join(home, "Library", "Application Support");
        for (const product of ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"]) {
            roots.push(path.join(base, product, "User", "globalStorage"));
        }
    } else {
        const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
        for (const product of ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"]) {
            roots.push(path.join(config, product, "User", "globalStorage"));
        }
    }
    return roots.filter((p, i, a) => a.indexOf(p) === i && fs.existsSync(p));
}

function discoverClineStorageDirs(explicitPath) {
    if (explicitPath && explicitPath !== true) {
        const p = path.resolve(String(explicitPath));
        if (!fs.existsSync(p)) die(`Cline storage path does not exist: ${p}`);
        return [p];
    }
    const knownIds = [
        "saoudrizwan.claude-dev",
        "cline.cline",
        "clinebot.cline",
    ];
    const found = [];
    for (const globalRoot of getGlobalStorageRoots()) {
        for (const id of knownIds) {
            const candidate = path.join(globalRoot, id);
            if (fs.existsSync(candidate)) found.push(candidate);
        }
        let entries = [];
        try { entries = fs.readdirSync(globalRoot, { withFileTypes: true }); } catch { /* ignore */ }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (/cline|claude-dev/i.test(entry.name)) found.push(path.join(globalRoot, entry.name));
        }
    }
    return found.filter((p, i, a) => a.indexOf(p) === i);
}

function maxMtimeRecursive(root) {
    let max = 0;
    for (const file of walkFiles(root, { excludedDirs: new Set([".git", "node_modules", "checkpoints", "cache"]) })) {
        try { max = Math.max(max, fs.statSync(file).mtimeMs); } catch { /* ignore */ }
    }
    try { max = Math.max(max, fs.statSync(root).mtimeMs); } catch { /* ignore */ }
    return max;
}

function findTaskDirs(storageDirs) {
    const results = [];
    const seen = new Set();
    function add(p) {
        const r = path.resolve(p);
        if (!seen.has(r) && fs.existsSync(r) && fs.statSync(r).isDirectory()) {
            seen.add(r);
            results.push(r);
        }
    }
    for (const storage of storageDirs) {
        const directTasks = path.basename(storage).toLowerCase() === "tasks" ? storage : path.join(storage, "tasks");
        if (fs.existsSync(directTasks)) {
            for (const entry of fs.readdirSync(directTasks, { withFileTypes: true })) {
                if (entry.isDirectory()) add(path.join(directTasks, entry.name));
            }
        }
        // Current/future layouts: locate nested directories named "tasks" up to depth 4.
        const queue = [{ dir: storage, depth: 0 }];
        while (queue.length) {
            const { dir, depth } = queue.shift();
            if (depth > 4) continue;
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const child = path.join(dir, entry.name);
                if (entry.name.toLowerCase() === "tasks") {
                    let tasks = [];
                    try { tasks = fs.readdirSync(child, { withFileTypes: true }); } catch { /* ignore */ }
                    for (const task of tasks) if (task.isDirectory()) add(path.join(child, task.name));
                } else if (!DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
                    queue.push({ dir: child, depth: depth + 1 });
                }
            }
        }
    }
    return results.sort((a, b) => maxMtimeRecursive(b) - maxMtimeRecursive(a));
}

function flattenStrings(value, output = [], pathParts = []) {
    if (typeof value === "string") {
        output.push({ path: pathParts.join("."), value });
    } else if (Array.isArray(value)) {
        value.forEach((v, i) => flattenStrings(v, output, [...pathParts, String(i)]));
    } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) flattenStrings(v, output, [...pathParts, k]);
    }
    return output;
}

function collectNumericFields(value, output = [], pathParts = []) {
    if (Array.isArray(value)) {
        value.forEach((v, i) => collectNumericFields(v, output, [...pathParts, String(i)]));
    } else if (value && typeof value === "object") {
        const parentKey = pathParts[pathParts.length - 1] || "";
        for (const [k, v] of Object.entries(value)) {
            const p = [...pathParts, k];
            if (typeof v === "number"
                && (/token|cost|price|cache|prompt|completion|input|output/i.test(k)
                    || /token/i.test(parentKey))) {
                output.push({ path: p.join("."), key: k, value: v });
            }
            collectNumericFields(v, output, p);
        }
    }
    return output;
}

module.exports = {
    fs, path, os, crypto,
    parseArgs, die, requiredString, positiveInteger, parseBoolean,
    sanitizeComponent, normalizeText, normalizePath,
    sha256Buffer, sha256Text, atomicWrite, readJson, writeJson,
    isInside, nextRunNumber, tryGit, copyToClipboard,
    resolveClientRoot, resolveWorkspaceRoot, defaultDataRoot, resolveProjectRoot, resolveRuleTable,
    projectRelativePath, resolveCollectionProjectRoot, checkProjectRootAgainstBaseline,
    walkFiles, snapshotWorkspace, currentWorkspaceManifest, compareWorkspaceToBaseline,
    discoverClineStorageDirs, findTaskDirs, maxMtimeRecursive,
    flattenStrings, collectNumericFields, looksBinary,
};
