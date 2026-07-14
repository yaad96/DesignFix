/**
 * Normalize paths before using them as snapshot identities. The extension can
 * emit either slash style on Windows, while the rest of the client expects
 * forward slashes.
 */
export const normalizeSnapshotFilePath = (filePath) => {
    let normalized = String(filePath ?? "").trim().replace(/\\/g, "/");
    const isUncPath = normalized.startsWith("//");
    normalized = normalized.replace(/\/{2,}/g, "/");
    if (isUncPath) normalized = "/" + normalized;

    // Keep filesystem roots intact while removing non-semantic trailing slashes.
    if (normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized))
        normalized = normalized.replace(/\/+$/, "");

    return normalized;
};

export const canonicalSnapshotFilePath = (filePath) => {
    const normalized = normalizeSnapshotFilePath(filePath);

    // Windows drive and UNC paths are case-insensitive. Do not case-fold POSIX
    // paths, where differently-cased names may identify different files.
    if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//"))
        return normalized.toLowerCase();
    return normalized;
};

/**
 * Mutable staging area for one complete extension snapshot. Nothing in this
 * object is published to Redux until VERIFY_RULES closes the transaction.
 */
export class SnapshotAccumulator {
    constructor() {
        this.reset();
    }

    reset() {
        this.xmlByPath = new Map();
        this.ruleTable = [];
        this.tagTable = [];
    }

    upsertXml(xmlFile) {
        if (!xmlFile || typeof xmlFile !== "object") return;

        const filePath = normalizeSnapshotFilePath(xmlFile.filePath);
        const key = canonicalSnapshotFilePath(filePath);
        if (!key) return;

        this.xmlByPath.set(key, {...xmlFile, filePath});
    }

    deleteXml(filePath) {
        this.xmlByPath.delete(canonicalSnapshotFilePath(filePath));
    }

    replaceXmlFiles(xmlFiles) {
        this.xmlByPath.clear();
        (Array.isArray(xmlFiles) ? xmlFiles : []).forEach((xmlFile) => this.upsertXml(xmlFile));
    }

    setRuleTable(ruleTable) {
        this.ruleTable = Array.isArray(ruleTable) ? ruleTable : [];
    }

    setTagTable(tagTable) {
        this.tagTable = Array.isArray(tagTable) ? tagTable : [];
    }

    snapshot() {
        return {
            // Conversion completes asynchronously in the extension, so arrival
            // order is not a stable project property. Sort by the canonical key
            // before rule evaluation and display.
            xmlFiles: Array.from(this.xmlByPath.entries())
                .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
                .map(([, xmlFile]) => xmlFile),
            ruleTable: this.ruleTable,
            tagTable: this.tagTable
        };
    }
}
