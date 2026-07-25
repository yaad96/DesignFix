/**
 * Locate a code snippet inside a document.
 *
 * The snippet shown for a rule result is `resText` from the client: the first
 * couple of non-empty lines of the matched element, with comments and
 * annotations already stripped. It is therefore NOT a verbatim substring of the
 * file (the file may carry a comment or annotation between those lines), and
 * srcML is not run with --position so there is no line number to fall back on.
 *
 * Matching is done line by line on trimmed text, skipping comment and blank
 * lines that appear between snippet lines in the file. Using the whole snippet
 * rather than any single line is what disambiguates files that repeat a
 * signature: FunctionCommand.java declares
 * `public void execute(Function function, String projectId)` thirteen times, so
 * only the snippet's following body line pins the correct one.
 */

export interface SnippetLocation {
    /** Character offset of the first matched character (leading indent excluded). */
    start: number;
    /** Character offset at the end of the last matched line. */
    end: number;
    /** True when the snippet matched more than once and `start` is the first hit. */
    ambiguous: boolean;
}

interface FileLine {
    /** The line text, without its trailing newline (and without a trailing CR). */
    text: string;
    /** Offset of the first character of the line. */
    start: number;
    /** Offset one past the last character of the line, before the newline. */
    end: number;
}

function splitLines(text: string): FileLine[] {
    const lines: FileLine[] = [];
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
        if (i === text.length || text[i] === '\n') {
            let end = i;
            if (end > start && text[end - 1] === '\r') {
                end--;
            }
            lines.push({ text: text.slice(start, end), start, end });
            start = i + 1;
        }
    }
    return lines;
}

// Blank lines and comment lines may sit between snippet lines in the real file
// (the client strips them from the snippet), so the matcher steps over them.
function isSkippable(trimmed: string): boolean {
    return trimmed === ''
        || trimmed.startsWith('//')
        || trimmed.startsWith('/*')
        || trimmed.startsWith('*')
        || trimmed.startsWith('@');
}

function meaningfulSnippetLines(snippet: string): string[] {
    return snippet
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !isSkippable(line));
}

function leadingWhitespace(text: string): number {
    const match = /^\s*/.exec(text);
    return match ? match[0].length : 0;
}

function toLocation(fileLines: FileLine[], startIndex: number, endIndex: number, ambiguous: boolean): SnippetLocation {
    const first = fileLines[startIndex];
    return {
        start: first.start + leadingWhitespace(first.text),
        end: fileLines[endIndex].end,
        ambiguous,
    };
}

/**
 * Try to match every snippet line, in order, starting at file line `startIndex`.
 * File comment/blank lines between snippet lines are skipped. Returns the index
 * of the last matched file line, or -1 when the sequence does not match here.
 */
function matchSequence(fileLines: FileLine[], startIndex: number, snippetLines: string[]): number {
    let fileIndex = startIndex;
    let lastMatched = startIndex;
    for (let k = 1; k < snippetLines.length; k++) {
        fileIndex++;
        while (fileIndex < fileLines.length && isSkippable(fileLines[fileIndex].text.trim())) {
            fileIndex++;
        }
        if (fileIndex >= fileLines.length || fileLines[fileIndex].text.trim() !== snippetLines[k]) {
            return -1;
        }
        lastMatched = fileIndex;
    }
    return lastMatched;
}

/**
 * @param documentText full text of the file the snippet came from
 * @param snippet the displayed snippet text (comment-stripped)
 * @returns the matched character range, or null when the snippet is not found
 */
export function locateSnippet(documentText: string, snippet: string): SnippetLocation | null {
    if (typeof documentText !== 'string' || typeof snippet !== 'string') {
        return null;
    }
    const snippetLines = meaningfulSnippetLines(snippet);
    if (snippetLines.length === 0) {
        return null;
    }

    const fileLines = splitLines(documentText);

    // Primary strategy: every place the whole snippet matches as an ordered
    // sequence of lines. More than one block means the snippet is genuinely
    // repeated; the first is used but the caller is told it was ambiguous.
    const blocks: Array<{ start: number; end: number }> = [];
    for (let s = 0; s < fileLines.length; s++) {
        if (fileLines[s].text.trim() !== snippetLines[0]) {
            continue;
        }
        const last = matchSequence(fileLines, s, snippetLines);
        if (last !== -1) {
            blocks.push({ start: s, end: last });
        }
    }
    if (blocks.length > 0) {
        return toLocation(fileLines, blocks[0].start, blocks[0].end, blocks.length > 1);
    }

    // Fallback: the reconstruction did not line up (e.g. srcML re-serialized the
    // text differently). Anchor on whichever snippet line is unique in the file,
    // preferring later body lines over the signature, which tends to repeat.
    for (let k = snippetLines.length - 1; k >= 0; k--) {
        const hits: number[] = [];
        for (let i = 0; i < fileLines.length; i++) {
            if (fileLines[i].text.trim() === snippetLines[k]) {
                hits.push(i);
            }
        }
        if (hits.length === 1) {
            return toLocation(fileLines, hits[0], hits[0], false);
        }
    }

    // Last resort: the first snippet line's first occurrence, flagged ambiguous
    // when it repeats, so the caller can warn rather than silently mislead.
    let firstHit = -1;
    let count = 0;
    for (let i = 0; i < fileLines.length; i++) {
        if (fileLines[i].text.trim() === snippetLines[0]) {
            if (firstHit === -1) {
                firstHit = i;
            }
            count++;
        }
    }
    if (firstHit === -1) {
        return null;
    }
    return toLocation(fileLines, firstHit, firstHit, count > 1);
}

/**
 * Fallback used when no displayed snippet is available and only a reconstructed
 * blob is on hand. Mirrors the original behaviour: anchor on the blob's last
 * meaningful line. Kept single-line and conservative on purpose.
 * @param documentText full text of the file
 * @param reconstructed reconstructed Java (may span from file start to element)
 */
export function locateByLastLine(documentText: string, reconstructed: string): SnippetLocation | null {
    if (typeof documentText !== 'string' || typeof reconstructed !== 'string') {
        return null;
    }
    const lines = reconstructed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const lastLine = lines[lines.length - 1];
    if (!lastLine) {
        return null;
    }

    const fileLines = splitLines(documentText);
    let firstHit = -1;
    let count = 0;
    for (let i = 0; i < fileLines.length; i++) {
        if (fileLines[i].text.includes(lastLine)) {
            if (firstHit === -1) {
                firstHit = i;
            }
            count++;
        }
    }
    if (firstHit === -1) {
        return null;
    }
    return toLocation(fileLines, firstHit, firstHit, count > 1);
}
