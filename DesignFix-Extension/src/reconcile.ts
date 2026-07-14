/**
 * Minimal-patch reconciliation for LLM-suggested file rewrites.
 *
 * Problem: the LLM returns a complete replacement file, and it routinely
 * reformats code it did not change (tabs -> 4 spaces, `a,b` -> `a, b`,
 * re-wrapped statements). Applying that output wholesale (a) churns every
 * line of the file in git/diff views, (b) drowns the genuine fix in red/green
 * noise during review, and (c) will silently DELETE the tail of a file if the
 * model's output was truncated.
 *
 * reconcile(original, llmOutput) rebuilds the suggestion as ORIGINAL + minimal
 * hunks:
 *   - lines the LLM left semantically untouched are taken from the ORIGINAL
 *     verbatim. "Untouched" is decided in three passes:
 *       1. line pairing that ignores leading/trailing whitespace (jsdiff),
 *       2. a hunk-level test that ignores ALL whitespace outside Java
 *          string/char literals (catches re-wrapped/joined lines and interior
 *          spacing like `super(0L,x)` vs `super(0L, x)`),
 *       3. the same literal-aware test per line inside mixed hunks;
 *   - genuinely added/changed lines keep the LLM's text, but their leading
 *     indentation is translated to the original file's indent style
 *     (e.g. 4 spaces -> tab) so even new lines match the file's convention;
 *   - whitespace inside string and character literals is ALWAYS significant
 *     (changing "CREATING " to "CREATING" is a real change and is kept);
 *   - hunks that only add/remove blank lines are dropped as formatting noise;
 *   - large blocks the suggestion would delete WITHOUT any replacement are
 *     treated as suspected output truncation: the original lines are KEPT and
 *     the result is flagged, instead of silently destroying code.
 *
 * The module is deliberately free of any vscode imports so it can be unit
 * tested under plain Node against recorded fix runs (the data folder).
 */
import { diffLines, diffArrays } from 'diff';

export interface ReconcileHunk {
    kind: 'replace' | 'insert' | 'delete';
    /** 0-based line index into the ORIGINAL file where the hunk applies. */
    origStartLine: number;
    /** Number of original lines removed by this hunk (0 for pure inserts). */
    origLineCount: number;
    /** Number of new lines introduced by this hunk (0 for pure deletes). */
    newLineCount: number;
}

export interface ReconcileOptions {
    /**
     * When true, large unpaired deletions are applied as-is instead of being
     * kept-and-flagged. Used by the accept path after the user explicitly
     * confirms a big deletion.
     */
    allowLargeDeletions?: boolean;
}

export interface ReconcileResult {
    /** Original text with only the genuine hunks applied (original line endings). */
    patchedText: string;
    hunks: ReconcileHunk[];
    addedLines: number;
    removedLines: number;
    /** True when the suggestion differs from the original only in whitespace/formatting. */
    identicalAfterReconcile: boolean;
    /** True when a large unpaired deletion was detected (possible LLM truncation). */
    truncationSuspected: boolean;
    truncationDetail: string;
    /** Lines the guard kept that the raw suggestion would have deleted. */
    keptDeletionLines: number;
    lineEnding: '\n' | '\r\n';
}

/** A pure deletion of at least this many consecutive lines, with no adjacent
 *  insertion, is treated as suspected truncation of the LLM output. */
export const TRUNCATION_MIN_LINES = 8;

interface IndentStyle {
    tab: boolean;
    width: number; // meaningful when tab === false
}

const normalizeNewlines = (text: string): string => text.replace(/\r\n/g, '\n');

/**
 * Split text into line tokens that RETAIN their trailing '\n' (the same
 * tokenization jsdiff uses for line diffs), so jsdiff part counts can be used
 * as indices into these arrays.
 */
const splitLinesKeepNL = (text: string): string[] => {
    if (text === '') { return []; }
    return text.split(/(?<=\n)/);
};

/**
 * Remove every whitespace character that sits OUTSIDE Java string/char
 * literals. Whitespace inside literals is preserved verbatim, so
 * `"CREATING "+x` and `"CREATING " + x` compare equal, while
 * `"CREATING "` vs `"CREATING"` do not. Used to decide whether a line/hunk
 * change is pure formatting.
 */
export function stripInsignificantWhitespace(text: string): string {
    let out = '';
    let inString = false;
    let inChar = false;
    let escaped = false;
    for (const ch of text) {
        if (inString || inChar) {
            out += ch;
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (inString && ch === '"') {
                inString = false;
            } else if (inChar && ch === '\'') {
                inChar = false;
            }
            continue;
        }
        if (ch === '"') { inString = true; out += ch; continue; }
        if (ch === '\'') { inChar = true; out += ch; continue; }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { continue; }
        out += ch;
    }
    return out;
}

const linesAreCosmeticallyEqual = (a: string, b: string): boolean =>
    stripInsignificantWhitespace(a) === stripInsignificantWhitespace(b);

const isBlankBlock = (lines: string[]): boolean =>
    lines.every(l => l.trim().length === 0);

/** Detect whether a file is tab- or space-indented, and the space width. */
export function detectIndentStyle(text: string): IndentStyle {
    const lines = normalizeNewlines(text).split('\n');
    let tabLines = 0;
    const spaceCounts: number[] = [];
    for (const line of lines) {
        const m = line.match(/^[ \t]+/);
        if (!m || line.trim().length === 0) { continue; }
        if (m[0].includes('\t')) {
            tabLines++;
        } else {
            spaceCounts.push(m[0].length);
        }
    }
    if (tabLines >= spaceCounts.length && tabLines > 0) {
        return { tab: true, width: 4 };
    }
    if (spaceCounts.length === 0) {
        // No indented lines at all; the choice is irrelevant for re-indentation.
        return { tab: false, width: 4 };
    }
    // Pick the candidate unit that divides the most observed indents
    // (ordered large->small so ties prefer the larger, more specific unit).
    // Odd counts from javadoc continuation lines (" * ") simply score low.
    let best = 4;
    let bestScore = -1;
    for (const unit of [8, 4, 3, 2]) {
        const score = spaceCounts.filter(c => c % unit === 0).length;
        if (score > bestScore) {
            best = unit;
            bestScore = score;
        }
    }
    return { tab: false, width: best };
}

const sameIndentStyle = (a: IndentStyle, b: IndentStyle): boolean =>
    a.tab === b.tab && (a.tab || a.width === b.width);

/**
 * Translate ONE line's leading indentation from one style to another.
 * Only whole indent units are translated; any remainder is preserved so
 * alignment padding (e.g. javadoc " * ") survives.
 */
export function reindentLine(line: string, from: IndentStyle, to: IndentStyle): string {
    const m = line.match(/^[ \t]*/);
    const ws = m ? m[0] : '';
    if (!ws) { return line; }
    const body = line.slice(ws.length);

    let level: number;
    let remainder: string;
    if (from.tab) {
        const tabs = ws.match(/^\t+/);
        level = tabs ? tabs[0].length : 0;
        remainder = ws.slice(level);
    } else {
        const spaces = ws.match(/^ +/);
        const n = spaces ? spaces[0].length : 0;
        level = Math.floor(n / from.width);
        remainder = ' '.repeat(n % from.width) + ws.slice(n);
    }

    const indent = to.tab ? '\t'.repeat(level) : ' '.repeat(level * to.width);
    return indent + remainder + body;
}

/**
 * Rebuild an LLM whole-file suggestion as ORIGINAL + minimal hunks.
 * See module docs for the full contract.
 */
export function reconcile(
    originalRaw: string,
    llmRaw: string,
    options: ReconcileOptions = {}
): ReconcileResult {
    const lineEnding: '\n' | '\r\n' = originalRaw.includes('\r\n') ? '\r\n' : '\n';
    const origN = normalizeNewlines(originalRaw);
    const llmN = normalizeNewlines(llmRaw);

    const origStyle = detectIndentStyle(origN);
    const llmStyle = detectIndentStyle(llmN);
    const needReindent = !sameIndentStyle(origStyle, llmStyle);
    const reindent = (l: string): string => (needReindent ? reindentLine(l, llmStyle, origStyle) : l);

    const origTokens = splitLinesKeepNL(origN);
    // Pass 1 - whitespace-tolerant line pairing: lines equal modulo
    // leading/trailing whitespace pair up as "unchanged", which neutralizes
    // the LLM's re-indentation drift.
    const parts = diffLines(origN, llmN, { ignoreWhitespace: true });

    const out: string[] = [];
    const hunks: ReconcileHunk[] = [];
    let origLineCursor = 0;
    let addedLines = 0;
    let removedLines = 0;
    let keptDeletionLines = 0;
    let truncationSuspected = false;
    const truncationNotes: string[] = [];

    const emitOriginal = (count: number): void => {
        out.push(...origTokens.slice(origLineCursor, origLineCursor + count));
        origLineCursor += count;
    };

    const emitAdded = (lines: string[]): void => {
        if (lines.length === 0) { return; }
        // Guard: if the previously emitted token lacks a trailing newline
        // (original file without final newline), insert one before appending.
        if (out.length > 0 && !out[out.length - 1].endsWith('\n')) {
            out[out.length - 1] += '\n';
        }
        out.push(...lines);
    };

    /**
     * Pass 2/3 - refine a replace hunk (removed lines paired with added lines).
     * Hunk level: if the whole hunk is equal ignoring whitespace outside string
     * literals (catches joined/split lines), keep the original block verbatim.
     * Line level: inside mixed hunks, re-diff with a literal-aware comparator so
     * cosmetic line pairs keep their original spelling and only genuine changes
     * survive.
     */
    const processReplaceHunk = (removedCount: number, addedValue: string): void => {
        const origHunk = origTokens.slice(origLineCursor, origLineCursor + removedCount);
        const newHunk = splitLinesKeepNL(addedValue);

        if (linesAreCosmeticallyEqual(origHunk.join(''), newHunk.join(''))) {
            emitOriginal(removedCount); // pure formatting (incl. re-wrapped lines)
            return;
        }

        const refined = diffArrays(origHunk, newHunk, { comparator: linesAreCosmeticallyEqual });
        const hunkStart = origLineCursor;
        let hunkRemoved = 0;
        let hunkAdded = 0;
        for (const part of refined) {
            const count = part.count ?? part.value.length;
            if (part.added) {
                emitAdded(part.value.map(reindent));
                hunkAdded += count;
            } else if (part.removed) {
                origLineCursor += count;
                hunkRemoved += count;
            } else {
                // Equal under the literal-aware comparator: keep ORIGINAL spelling.
                out.push(...origTokens.slice(origLineCursor, origLineCursor + count));
                origLineCursor += count;
            }
        }
        if (hunkRemoved > 0 || hunkAdded > 0) {
            hunks.push({
                kind: hunkRemoved > 0 && hunkAdded > 0 ? 'replace' : (hunkAdded > 0 ? 'insert' : 'delete'),
                origStartLine: hunkStart,
                origLineCount: hunkRemoved,
                newLineCount: hunkAdded
            });
            removedLines += hunkRemoved;
            addedLines += hunkAdded;
        }
    };

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const count = part.count ?? 0;
        if (count === 0) { continue; }

        if (!part.added && !part.removed) {
            emitOriginal(count);
            continue;
        }

        if (part.removed) {
            const next = parts[i + 1];
            if (next && next.added) {
                // Replacement: refine and consume BOTH parts.
                processReplaceHunk(count, next.value ?? '');
                i++;
                continue;
            }

            // Pure deletion (no replacement anywhere adjacent).
            const removedBlock = origTokens.slice(origLineCursor, origLineCursor + count);
            if (isBlankBlock(removedBlock)) {
                emitOriginal(count); // deleting blank lines is formatting noise
                continue;
            }
            if (count >= TRUNCATION_MIN_LINES && !options.allowLargeDeletions) {
                // Suspected truncation: KEEP the original lines and flag it.
                truncationSuspected = true;
                keptDeletionLines += count;
                truncationNotes.push(
                    `kept original lines ${origLineCursor + 1}-${origLineCursor + count} ` +
                    `(${count} lines the suggestion would have deleted with no replacement)`
                );
                emitOriginal(count);
                continue;
            }
            hunks.push({
                kind: 'delete',
                origStartLine: origLineCursor,
                origLineCount: count,
                newLineCount: 0
            });
            removedLines += count;
            origLineCursor += count;
            continue;
        }

        // Pure addition.
        const rawLines = splitLinesKeepNL(part.value ?? '');
        if (isBlankBlock(rawLines)) {
            continue; // adding blank lines is formatting noise
        }
        emitAdded(rawLines.map(reindent));
        addedLines += count;
        hunks.push({
            kind: 'insert',
            origStartLine: origLineCursor,
            origLineCount: 0,
            newLineCount: count
        });
    }

    const patchedN = out.join('');
    const identicalAfterReconcile = patchedN === origN;
    const patchedText = lineEnding === '\r\n' ? patchedN.replace(/\n/g, '\r\n') : patchedN;

    return {
        patchedText,
        hunks,
        addedLines,
        removedLines,
        identicalAfterReconcile,
        truncationSuspected,
        truncationDetail: truncationNotes.join('; '),
        keptDeletionLines,
        lineEnding
    };
}

/** Short human-readable summary for notifications/status messages. */
export function describeReconcile(res: ReconcileResult): string {
    if (res.identicalAfterReconcile) {
        return 'no effective change (formatting-only suggestion)';
    }
    const bits = [`+${res.addedLines} / -${res.removedLines} line(s)`];
    if (res.truncationSuspected) {
        bits.push(`kept ${res.keptDeletionLines} line(s) the suggestion would have deleted`);
    }
    return bits.join(', ');
}
