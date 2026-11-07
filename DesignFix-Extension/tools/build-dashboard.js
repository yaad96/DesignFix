#!/usr/bin/env node
"use strict";

/*
 * Builds the DesignFix dashboard (../DesignFix-client) into ./dashboard so the
 * extension can serve it, then:
 *   1. refuses to continue if the bundle contains the OpenAI API key from
 *      DesignFix-client/.env or variables from the build machine's
 *      environment, so a secret can never be packaged by accident;
 *   2. regenerates THIRD_PARTY_NOTICES.md from the npm packages the bundle
 *      actually contains (read from webpack's stats), plus the srcML section.
 *
 * Usage: npm run build:dashboard   (also part of vscode:prepublish)
 * Uses only built-in Node.js modules.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const EXTENSION_ROOT = path.resolve(__dirname, "..");
const CLIENT_ROOT = path.resolve(EXTENSION_ROOT, "..", "DesignFix-client");
const OUTPUT_DIR = path.join(EXTENSION_ROOT, "dashboard");
const STATS_FILE = path.join(OUTPUT_DIR, "bundle-stats.json");
const NOTICES_DIR = path.join(__dirname, "notices");
const NOTICES_FILE = path.join(EXTENSION_ROOT, "THIRD_PARTY_NOTICES.md");

// License texts for the srcML section, in the order they are reproduced.
const SRCML_LICENSE_TEXTS = [
    ["GNU General Public License, version 2 (srcML Toolkit)", "gpl-2.0.txt"],
    ["GNU Lesser General Public License, version 2.1 (GNU libiconv, libcharset)", "lgpl-2.1.txt"],
    ["Boost Software License 1.0 (Boost)", "boost.txt"],
    ["libxml2", "libxml2.txt"],
    ["libxslt and libexslt", "libxslt.txt"],
    ["curl (libcurl)", "curl.txt"],
    ["OpenSSL License and original SSLeay License (OpenSSL)", "openssl.txt"],
    ["libssh2", "libssh2.txt"],
    ["libarchive", "libarchive.txt"],
    ["LZ4 library", "lz4.txt"],
    ["XZ Utils (liblzma)", "xz.txt"],
    ["bzip2 (libbzip2)", "bzip2.txt"],
    ["zlib", "zlib.txt"],
];

// The extension's own runtime dependencies (shipped in node_modules).
const EXTENSION_RUNTIME_PACKAGES = ["ws", "diff"];

// MIT-licensed files copied into DesignFix-client/public/vendor (see vendored.md).
const VENDORED_MIT_COMPONENTS = [
    ["Bootstrap 3.3.7", "2011-2016 Twitter, Inc."],
    ["RequireJS 2.3.5", "jQuery Foundation and other contributors, https://jquery.org/"],
];

const TEXT_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".txt", ".map", ".svg"]);
// Names of build-machine variables that must never appear as object keys in
// the bundle. Finding one means a wholesale `process.env` was compiled in.
const MACHINE_ENV_KEYS = ['"USERPROFILE":', '"COMPUTERNAME":', '"APPDATA":', '"HOMEPATH":', '"OPENAI_API_KEY":'];

function fail(message) {
    console.error(`build-dashboard: ${message}`);
    process.exit(1);
}

function walkFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walkFiles(full) : [full];
    });
}

function buildDashboard() {
    const rewiredBin = path.join(CLIENT_ROOT, "node_modules", "react-app-rewired", "bin", "index.js");
    if (!fs.existsSync(rewiredBin)) {
        fail(`the dashboard's dependencies are not installed. Run "npm install" in ${CLIENT_ROOT} first.`);
    }
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });

    // webpack 4 needs OpenSSL's legacy provider on Node versions built with OpenSSL 3.
    const nodeOptions = [process.env.NODE_OPTIONS, "--max-old-space-size=8192"];
    if (/^3\./.test(process.versions.openssl || "")) {
        nodeOptions.push("--openssl-legacy-provider");
    }

    console.log(`build-dashboard: building ${CLIENT_ROOT} into ${OUTPUT_DIR}`);
    const result = spawnSync(process.execPath, [rewiredBin, "build", "--stats"], {
        cwd: CLIENT_ROOT,
        stdio: "inherit",
        env: {
            ...process.env,
            BUILD_PATH: OUTPUT_DIR,
            PUBLIC_URL: ".",
            GENERATE_SOURCEMAP: "false",
            CI: "false",
            NODE_OPTIONS: nodeOptions.filter(Boolean).join(" "),
        },
    });
    if (result.status !== 0) {
        fail(`the dashboard build failed (exit code ${result.status}).`);
    }
    if (!fs.existsSync(path.join(OUTPUT_DIR, "index.html")) || !fs.existsSync(STATS_FILE)) {
        fail("the build did not produce index.html and bundle-stats.json.");
    }
}

function readEnvKey() {
    const envFile = path.join(CLIENT_ROOT, ".env");
    if (!fs.existsSync(envFile)) {
        return "";
    }
    for (const rawLine of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith("OPENAI_API_KEY")) {
            continue;
        }
        let value = line.slice(line.indexOf("=") + 1).trim();
        if (/^(["']).*\1$/.test(value)) {
            value = value.slice(1, -1);
        }
        return value.trim();
    }
    return "";
}

function scanForSecrets() {
    const apiKey = readEnvKey();
    for (const file of walkFiles(OUTPUT_DIR)) {
        if (file === STATS_FILE || !TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
            continue;
        }
        const relative = path.relative(EXTENSION_ROOT, file);
        const text = fs.readFileSync(file, "utf8");
        if (apiKey && text.includes(apiKey)) {
            fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
            fail(`${relative} contains the OpenAI API key from DesignFix-client/.env. The build output was deleted.`);
        }
        const leaked = MACHINE_ENV_KEYS.find((key) => text.includes(key));
        if (leaked) {
            fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
            fail(`${relative} contains a build-machine environment variable (${leaked}). The build output was deleted.`);
        }
    }
    console.log("build-dashboard: secret scan passed (no OpenAI key, no build-machine environment variables).");
}

// Directory of the npm package a webpack module came from, relative to the
// client root, or undefined for the app's own sources.
function packageDirOf(moduleName) {
    let name = moduleName.split("!").pop().split(" + ")[0].trim().replace(/\\/g, "/");
    if (name.startsWith("(webpack)")) {
        name = "node_modules/webpack" + name.slice("(webpack)".length);
    }
    const match = /^(?:\.\/)?(.*node_modules\/(?:@[^/]+\/)?[^/]+)/.exec(name);
    return match ? match[1] : undefined;
}

function collectBundledPackageDirs() {
    const stats = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    const dirs = new Set();
    const stack = [stats];
    while (stack.length > 0) {
        const node = stack.pop();
        if (Array.isArray(node)) {
            stack.push(...node);
        } else if (node && typeof node === "object") {
            if (typeof node.name === "string") {
                const dir = packageDirOf(node.name);
                if (dir) {
                    dirs.add(dir);
                }
            }
            for (const value of Object.values(node)) {
                if (value && typeof value === "object") {
                    stack.push(value);
                }
            }
        }
    }
    return dirs;
}

function describePackage(packageDir) {
    const manifestPath = path.join(packageDir, "package.json");
    if (!fs.existsSync(manifestPath)) {
        return undefined;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    let license = manifest.license;
    if (license && typeof license === "object") {
        license = license.type;
    }
    if (!license && Array.isArray(manifest.licenses)) {
        license = manifest.licenses.map((entry) => entry.type || entry).join(" OR ");
    }
    const licenseFile = fs.readdirSync(packageDir).find((file) => /^(licen[cs]e|copying)(\b|[-._])/i.test(file));
    return {
        name: manifest.name || path.basename(packageDir),
        version: manifest.version || "",
        license: license || "UNKNOWN",
        text: licenseFile ? fs.readFileSync(path.join(packageDir, licenseFile), "utf8").trim() : "",
    };
}

function uniquePackages(packageDirs) {
    const byId = new Map();
    for (const dir of packageDirs) {
        const info = describePackage(dir);
        if (info && !byId.has(`${info.name}@${info.version}`)) {
            byId.set(`${info.name}@${info.version}`, info);
        }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function fenced(text) {
    return ["```text", text.replace(/```/g, "'''"), "```"].join("\n");
}

function packageSection(title, intro, packages) {
    const lines = [`## ${title}`, "", intro, "", "| Package | Version | License |", "| --- | --- | --- |"];
    for (const pkg of packages) {
        lines.push(`| ${pkg.name} | ${pkg.version} | ${pkg.license} |`);
    }
    lines.push("");
    for (const pkg of packages) {
        lines.push(`### ${pkg.name} ${pkg.version}`, "");
        lines.push(pkg.text
            ? fenced(pkg.text)
            : `This package ships no license file. Its package.json declares the license as: ${pkg.license}.`);
        lines.push("");
    }
    return lines.join("\n");
}

// The permission and warranty text of the MIT License, taken from DesignFix's own LICENSE.
function mitLicenseBody() {
    const text = fs.readFileSync(path.join(EXTENSION_ROOT, "LICENSE"), "utf8").replace(/\r\n/g, "\n");
    const start = text.indexOf("Permission is hereby granted");
    if (start < 0) {
        fail("LICENSE does not contain the MIT license text.");
    }
    return text.slice(start).trim();
}

function writeNotices() {
    const dashboardPackages = uniquePackages(
        [...collectBundledPackageDirs()].map((dir) => path.join(CLIENT_ROOT, dir)));
    const runtimePackages = uniquePackages(
        EXTENSION_RUNTIME_PACKAGES.map((name) => path.join(EXTENSION_ROOT, "node_modules", name)));

    const parts = [
        "# Third-party notices",
        "",
        "DesignFix is released under the MIT License (see LICENSE). The extension also contains the "
            + "third-party software listed below. Each component is distributed under its own license, "
            + "reproduced in full in this file.",
        "",
        "This file is generated by tools/build-dashboard.js. Do not edit it by hand.",
        "",
        fs.readFileSync(path.join(NOTICES_DIR, "srcml.md"), "utf8").trim(),
        "",
    ];
    for (const [title, file] of SRCML_LICENSE_TEXTS) {
        parts.push(`### ${title}`, "", fenced(fs.readFileSync(path.join(NOTICES_DIR, "licenses", file), "utf8").trim()), "");
    }
    parts.push(packageSection("2. Dashboard (dashboard/)",
        "The bundled dashboard is compiled from DesignFix-client and contains the npm packages below.",
        dashboardPackages));
    parts.push(packageSection("3. Extension runtime dependencies (node_modules/)",
        "The extension itself loads the npm packages below at runtime.",
        runtimePackages));

    parts.push(fs.readFileSync(path.join(NOTICES_DIR, "vendored.md"), "utf8").trim(), "");
    const mitBody = mitLicenseBody();
    for (const [title, holder] of VENDORED_MIT_COMPONENTS) {
        parts.push(`### ${title}`, "", fenced(`MIT License\n\nCopyright (c) ${holder}\n\n${mitBody}`), "");
    }

    fs.writeFileSync(NOTICES_FILE, parts.join("\n").replace(/\r\n/g, "\n") + "\n", "utf8");
    console.log(`build-dashboard: wrote ${path.relative(EXTENSION_ROOT, NOTICES_FILE)} `
        + `(${dashboardPackages.length} dashboard packages, ${runtimePackages.length} runtime packages).`);
}

function summarize() {
    const files = walkFiles(OUTPUT_DIR);
    const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
    console.log(`build-dashboard: done. ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB in dashboard/.`);
}

buildDashboard();
scanForSecrets();
writeNotices();
fs.rmSync(STATS_FILE, { force: true });
summarize();
