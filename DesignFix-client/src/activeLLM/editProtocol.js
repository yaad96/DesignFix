export const EDIT_PROTOCOL_VERSION = 2;

const MAX_EDITS = 20;
const MAX_REPLACEMENTS_PER_FILE = 50;
const LARGE_FILE_LINE_COUNT = 20;
const MAX_ANCHOR_FRACTION = 0.7;

export class EditProtocolError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = "EditProtocolError";
        this.code = code;
        this.details = details;
    }
}

const fail = (code, message, details) => {
    throw new EditProtocolError(code, message, details);
};

const normalizeNewlines = (text) => String(text ?? "").replace(/\r\n?/g, "\n");

export function normalizeFilePath(filePath) {
    let normalized = String(filePath ?? "").trim().replace(/\\/g, "/");
    normalized = normalized.replace(/\/{2,}/g, "/");
    if (/^[A-Za-z]:\//.test(normalized)) {
        normalized = normalized[0].toLowerCase() + normalized.slice(1);
    }
    return normalized;
}

// A small deterministic fingerprint is enough here: the model only echoes it
// back so we can prove that an edit targets the exact snapshot in its prompt.
export function hashContent(content) {
    const text = normalizeNewlines(content);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildCandidateManifest(files) {
    const byPath = new Map();

    for (const file of Array.isArray(files) ? files : []) {
        const filePath = String(file?.filePath ?? "").trim();
        const normalizedPath = normalizeFilePath(filePath);
        if (!normalizedPath) {
            fail("INVALID_CANDIDATE", "A candidate file is missing its path.");
        }

        const content = String(file?.content ?? "");
        const existing = byPath.get(normalizedPath);
        if (existing) {
            if (normalizeNewlines(existing.content) !== normalizeNewlines(content)) {
                fail("DUPLICATE_CANDIDATE", `Candidate path has conflicting contents: ${filePath}`);
            }
            existing.allowCreate = existing.allowCreate || file?.allowCreate === true;
            continue;
        }

        byPath.set(normalizedPath, {
            filePath,
            normalizedPath,
            content,
            allowCreate: file?.allowCreate === true,
            baseHash: hashContent(content),
        });
    }

    return Array.from(byPath.values());
}

function countOccurrences(text, search) {
    let count = 0;
    let offset = 0;
    while (offset <= text.length - search.length) {
        const index = text.indexOf(search, offset);
        if (index === -1) break;
        count++;
        offset = index + Math.max(search.length, 1);
    }
    return count;
}

function containsAbbreviationPlaceholder(text) {
    const patterns = [
        /\/\/\s*(?:\.\.\.\s*)?(?:existing|remaining|unchanged)\s+(?:code|methods?|classes?|implementation)\b/i,
        /\/\/\s*(?:rest|remainder)\s+of\s+(?:the\s+)?(?:file|code|methods?|classes?)\b/i,
        /\b(?:code|methods?|classes?|implementation)\s+(?:omitted|unchanged)\b/i,
        /\/\*\s*\.\.\.\s*\*\//,
        /^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*(?:\.\.\.|…)\s*;?\s*$/m,
    ];
    return patterns.some((pattern) => pattern.test(text));
}

function validateReplacementShape(replacement, filePath) {
    if (!replacement || typeof replacement !== "object") {
        fail("INVALID_REPLACEMENT", `Replacement for ${filePath} must be an object.`);
    }
    if (typeof replacement.oldText !== "string" || replacement.oldText.length === 0) {
        fail("EMPTY_ANCHOR", `Replacement for ${filePath} has an empty oldText anchor.`);
    }
    if (typeof replacement.newText !== "string") {
        fail("INVALID_REPLACEMENT", `Replacement for ${filePath} is missing newText.`);
    }
    if (replacement.expectedOccurrences !== 1) {
        fail("INVALID_OCCURRENCE_COUNT", `Replacement for ${filePath} must set expectedOccurrences to 1.`);
    }
    if (replacement.oldText === replacement.newText) {
        fail("NO_OP_EDIT", `Replacement for ${filePath} does not change the file.`);
    }
    if (replacement.newText.includes("```") || containsAbbreviationPlaceholder(replacement.newText)) {
        fail("INCOMPLETE_EDIT", `Replacement for ${filePath} contains Markdown or abbreviation placeholders.`);
    }
}

function applyReplacements(candidate, replacements) {
    if (!Array.isArray(replacements) || replacements.length === 0) {
        fail("MISSING_REPLACEMENTS", `Modify edit for ${candidate.filePath} has no replacements.`);
    }
    if (replacements.length > MAX_REPLACEMENTS_PER_FILE) {
        fail("TOO_MANY_REPLACEMENTS", `Modify edit for ${candidate.filePath} has too many replacements.`);
    }

    const original = normalizeNewlines(candidate.content);
    const originalLineCount = original.split("\n").length;
    const located = replacements.map((replacement, index) => {
        validateReplacementShape(replacement, candidate.filePath);
        const oldText = normalizeNewlines(replacement.oldText);
        const newText = normalizeNewlines(replacement.newText);
        const occurrences = countOccurrences(original, oldText);

        if (occurrences !== 1) {
            fail(
                occurrences === 0 ? "ANCHOR_NOT_FOUND" : "AMBIGUOUS_ANCHOR",
                `Replacement ${index + 1} for ${candidate.filePath} matched ${occurrences} times; exactly one match is required.`,
                {filePath: candidate.filePath, replacementIndex: index, occurrences},
            );
        }

        const oldLineCount = oldText.split("\n").length;
        const newLineCount = newText.split("\n").length;
        if (originalLineCount >= LARGE_FILE_LINE_COUNT && oldText.length / Math.max(original.length, 1) > MAX_ANCHOR_FRACTION) {
            fail("FULL_FILE_REWRITE", `Replacement ${index + 1} for ${candidate.filePath} covers most of the file.`);
        }
        if (newLineCount > 40 && newLineCount > Math.max(oldLineCount * 4, oldLineCount + 40)) {
            fail("EXCESSIVE_EXPANSION", `Replacement ${index + 1} for ${candidate.filePath} expands a small anchor into a large block.`);
        }
        if (/^\s*package\s+[\w.]+\s*;/m.test(newText) && !/^\s*package\s+[\w.]+\s*;/m.test(oldText)) {
            fail("INCOMPLETE_EDIT", `Replacement ${index + 1} for ${candidate.filePath} inserts a package declaration into a smaller anchor.`);
        }
        if (/^\s*(?:public\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+\w+/m.test(newText)
            && !/^\s*(?:public\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+\w+/m.test(oldText)) {
            fail("INCOMPLETE_EDIT", `Replacement ${index + 1} for ${candidate.filePath} inserts a top-level declaration into a smaller anchor.`);
        }

        const start = original.indexOf(oldText);
        return {start, end: start + oldText.length, newText, index};
    });

    const ordered = [...located].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
        if (ordered[i].start < ordered[i - 1].end) {
            fail("OVERLAPPING_REPLACEMENTS", `Replacements for ${candidate.filePath} overlap.`);
        }
    }
    const coveredCharacters = ordered.reduce((total, replacement) => total + replacement.end - replacement.start, 0);
    if (originalLineCount >= LARGE_FILE_LINE_COUNT
        && coveredCharacters / Math.max(original.length, 1) > MAX_ANCHOR_FRACTION) {
        fail("FULL_FILE_REWRITE", `Replacements for ${candidate.filePath} collectively cover most of the file.`);
    }

    let modified = original;
    for (const replacement of [...located].sort((a, b) => b.start - a.start)) {
        modified = modified.slice(0, replacement.start) + replacement.newText + modified.slice(replacement.end);
    }

    if (modified === original) {
        fail("NO_OP_EDIT", `Edit for ${candidate.filePath} does not change the file.`);
    }

    const newline = String(candidate.content).includes("\r\n") ? "\r\n" : "\n";
    return newline === "\n" ? modified : modified.replace(/\n/g, newline);
}

function validateCreate(candidate, edit) {
    if (!candidate.allowCreate) {
        fail("CREATE_NOT_ALLOWED", `Creation was not explicitly allowed for ${candidate.filePath}.`);
    }
    if (candidate.content.length > 0) {
        fail("FILE_ALREADY_EXISTS", `Create edit targets an existing file: ${candidate.filePath}.`);
    }
    if (typeof edit.code !== "string" || edit.code.trim().length === 0) {
        fail("EMPTY_CREATED_FILE", `Create edit for ${candidate.filePath} has no content.`);
    }
    if (edit.code.includes("```") || containsAbbreviationPlaceholder(edit.code)) {
        fail("INCOMPLETE_EDIT", `Create edit for ${candidate.filePath} contains Markdown or abbreviation placeholders.`);
    }
    return edit.code;
}

export function materializeEdits(rawEdits, candidates) {
    if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        fail("NO_EDITS", "The model returned no file edits.");
    }
    if (rawEdits.length > MAX_EDITS) {
        fail("TOO_MANY_EDITS", "The model returned too many file edits.");
    }

    const manifest = Array.isArray(candidates) ? candidates : [];
    const byPath = new Map(manifest.map((candidate) => [candidate.normalizedPath, candidate]));
    const seen = new Set();

    // Build the whole batch in local memory. Nothing is returned to the UI until
    // every file and every anchor has passed validation.
    return rawEdits.map((edit) => {
        if (!edit || typeof edit !== "object") {
            fail("INVALID_EDIT", "Every edit must be an object.");
        }
        const normalizedPath = normalizeFilePath(edit.filePath);
        const candidate = byPath.get(normalizedPath);
        if (!candidate) {
            fail("UNKNOWN_FILE_PATH", `Edit target was not supplied as a candidate: ${edit.filePath || "(missing path)"}`);
        }
        if (seen.has(normalizedPath)) {
            fail("DUPLICATE_EDIT", `The model returned more than one edit for ${candidate.filePath}.`);
        }
        seen.add(normalizedPath);

        if (edit.baseHash !== candidate.baseHash) {
            fail("STALE_BASE", `Edit for ${candidate.filePath} does not reference the supplied file snapshot.`);
        }

        const operation = edit.operation || "modify";
        let modifiedFileContent;
        if (operation === "modify") {
            if (candidate.allowCreate && candidate.content.length === 0) {
                fail("INVALID_OPERATION", `Empty candidate ${candidate.filePath} must use operation \"create\".`);
            }
            modifiedFileContent = applyReplacements(candidate, edit.replacements);
        } else if (operation === "create") {
            modifiedFileContent = validateCreate(candidate, edit);
        } else {
            fail("INVALID_OPERATION", `Unsupported operation \"${operation}\" for ${candidate.filePath}.`);
        }

        return {
            filePath: candidate.filePath,
            originalFileContent: candidate.content,
            modifiedFileContent,
            operation,
            baseHash: candidate.baseHash,
            replacements: operation === "modify" ? edit.replacements : undefined,
        };
    });
}

export function parseAndMaterializeResponse(parsedResponse, candidates) {
    if (!parsedResponse || typeof parsedResponse !== "object") {
        fail("INVALID_RESPONSE", "The model response must be a JSON object.");
    }
    if (parsedResponse.schemaVersion !== EDIT_PROTOCOL_VERSION) {
        fail("UNSUPPORTED_SCHEMA", `Expected edit schema version ${EDIT_PROTOCOL_VERSION}.`);
    }

    return {
        explanation: typeof parsedResponse.explanation === "string" ? parsedResponse.explanation : "",
        edits: materializeEdits(parsedResponse.edits, candidates),
    };
}
