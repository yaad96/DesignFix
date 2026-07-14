/**
 * Canonical form used only to decide whether two source snapshots represent
 * the same file. srcML round-tripping adds blank wrapper lines and normalizes
 * line endings, neither of which is an on-disk code change.
 *
 * Internal whitespace and every nonblank source line remain byte-sensitive.
 */
export function normalizeSourceSnapshot(text: string): string {
    const lines = String(text ?? '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .split('\n');

    while (lines.length > 0 && /^[\t ]*$/.test(lines[0])) {
        lines.shift();
    }
    while (lines.length > 0 && /^[\t ]*$/.test(lines[lines.length - 1])) {
        lines.pop();
    }

    return lines.join('\n');
}

export function sourceSnapshotsEqual(left: string, right: string): boolean {
    return normalizeSourceSnapshot(left) === normalizeSourceSnapshot(right);
}
