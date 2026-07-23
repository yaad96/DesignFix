/**
 * Re-apply LLM replacement edits against the CURRENT on-disk content instead of
 * trusting the client's precomputed full-file rewrite. That rewrite is built from
 * a srcML round-trip snapshot that can drift from (or lag behind) the real file,
 * so a byte mismatch between the snapshot and disk does not prove the edited code
 * changed. Each replacement is anchored by its exact `oldText`; the edit is applied
 * only when every anchor is present exactly once in the current file, so a target
 * that genuinely moved or changed still fails (returns null).
 *
 * This mirrors the client's applyReplacements (editProtocol.js): normalize
 * newlines, require a single occurrence per anchor, reject overlaps, apply back to
 * front, and restore the file's own newline style.
 */

const normalizeNewlines = (text: string): string =>
    String(text == null ? '' : text).replace(/\r\n?/g, '\n');

function countOccurrences(text: string, search: string): number {
    if (search.length === 0) { return 0; }
    let count = 0;
    let offset = 0;
    while (offset <= text.length - search.length) {
        const index = text.indexOf(search, offset);
        if (index === -1) { break; }
        count++;
        offset = index + search.length;
    }
    return count;
}

export function reanchorReplacements(
    diskContent: string,
    replacements: readonly any[] | undefined
): string | null {
    if (!Array.isArray(replacements) || replacements.length === 0) {
        return null;
    }
    const original = normalizeNewlines(diskContent);

    const located: { start: number; end: number; newText: string }[] = [];
    for (const replacement of replacements) {
        if (!replacement ||
            typeof replacement.oldText !== 'string' ||
            typeof replacement.newText !== 'string') {
            return null;
        }
        const oldText = normalizeNewlines(replacement.oldText);
        const newText = normalizeNewlines(replacement.newText);
        if (oldText.length === 0 || countOccurrences(original, oldText) !== 1) {
            return null; // anchor missing or ambiguous in the current file
        }
        const start = original.indexOf(oldText);
        located.push({ start, end: start + oldText.length, newText });
    }

    const ordered = [...located].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
        if (ordered[i].start < ordered[i - 1].end) {
            return null; // overlapping anchors
        }
    }

    let modified = original;
    for (const replacement of [...located].sort((a, b) => b.start - a.start)) {
        modified = modified.slice(0, replacement.start) + replacement.newText + modified.slice(replacement.end);
    }
    if (modified === original) {
        return null; // no-op
    }

    const newline = diskContent.includes('\r\n') ? '\r\n' : '\n';
    return newline === '\n' ? modified : modified.replace(/\n/g, newline);
}
