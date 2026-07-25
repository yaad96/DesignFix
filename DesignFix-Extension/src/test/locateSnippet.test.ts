import * as assert from 'assert';
import { locateSnippet, locateByLastLine } from '../locateSnippet';

// A file that repeats a signature, which is what defeated the previous
// last-line-only matcher (FunctionCommand.java repeats `execute` 13 times).
// Note the comment line inside class B's method: the displayed snippet has it
// stripped, so the matcher must step over it.
const REPEATED =
    'class Outer {\n' +               // 1
    '    public void execute(final String projectId) {\n' + // 2
    '        first();\n' +            // 3
    '    }\n' +                       // 4
    '\n' +                            // 5
    '    class A {\n' +               // 6
    '        public void execute(Function f, String projectId) {\n' + // 7
    '            alpha();\n' +        // 8
    '        }\n' +                   // 9
    '    }\n' +                       // 10
    '\n' +                            // 11
    '    class B {\n' +               // 12
    '        public void execute(Function f, String projectId) {\n' + // 13
    '            // spawn a review\n' + // 14  (comment the snippet omits)
    '            beta();\n' +         // 15
    '        }\n' +                   // 16
    '    }\n' +                       // 17
    '}\n';                            // 18

const lineOf = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

suite('locateSnippet', () => {
    test('selects the copy the snippet came from, not the first signature match', () => {
        // The displayed snippet: signature + body line, comment already stripped.
        const snippet = 'public void execute(Function f, String projectId) {\nbeta();';
        const found = locateSnippet(REPEATED, snippet);
        assert.ok(found);
        assert.strictEqual(lineOf(REPEATED, found!.start), 13);
        assert.strictEqual(found!.ambiguous, false);
    });

    test('steps over a comment line the snippet omits', () => {
        const snippet = 'public void execute(Function f, String projectId) {\nbeta();';
        const found = locateSnippet(REPEATED, snippet);
        assert.ok(found);
        // Range spans from the signature (13) through the body line (15),
        // skipping the comment at 14.
        assert.strictEqual(lineOf(REPEATED, found!.start), 13);
        assert.strictEqual(lineOf(REPEATED, found!.end), 15);
    });

    test('excludes the leading indentation from the selection start', () => {
        const snippet = 'public void execute(Function f, String projectId) {\nalpha();';
        const found = locateSnippet(REPEATED, snippet);
        assert.ok(found);
        assert.strictEqual(REPEATED[found!.start], 'p');
    });

    test('matches an LF snippet against a CRLF document', () => {
        const crlf = REPEATED.replace(/\n/g, '\r\n');
        const found = locateSnippet(crlf, 'public void execute(Function f, String projectId) {\nbeta();');
        assert.ok(found);
        assert.strictEqual(lineOf(crlf.replace(/\r\n/g, '\n'), crlf.slice(0, found!.start).replace(/\r\n/g, '\n').length), 13);
    });

    test('reports ambiguity when the snippet genuinely repeats', () => {
        // A bare signature matches both class A and class B copies.
        const found = locateSnippet(REPEATED, 'public void execute(Function f, String projectId) {');
        assert.ok(found);
        assert.strictEqual(found!.ambiguous, true);
        assert.strictEqual(lineOf(REPEATED, found!.start), 7);
    });

    test('the unique signature still resolves on its own', () => {
        const found = locateSnippet(REPEATED, 'public void execute(final String projectId) {');
        assert.ok(found);
        assert.strictEqual(lineOf(REPEATED, found!.start), 2);
        assert.strictEqual(found!.ambiguous, false);
    });

    test('falls back to a unique body line when the sequence does not line up', () => {
        // Signature repeats and the following line is not adjacent as given, but
        // `beta();` is unique, so the fallback anchors there.
        const found = locateSnippet(REPEATED, 'public void execute(Function f, String projectId) {\nsomethingElse();\nbeta();');
        assert.ok(found);
        assert.strictEqual(lineOf(REPEATED, found!.start), 15);
    });

    test('returns null when the snippet is absent', () => {
        assert.strictEqual(locateSnippet(REPEATED, 'public void missing(int q) {'), null);
    });

    test('ignores comment-only and annotation-only snippet lines', () => {
        const found = locateSnippet(REPEATED, '// spawn a review\n@Override\nbeta();');
        assert.ok(found);
        assert.strictEqual(lineOf(REPEATED, found!.start), 15);
    });

    test('returns null for empty or non-string input', () => {
        assert.strictEqual(locateSnippet(REPEATED, ''), null);
        assert.strictEqual(locateSnippet(REPEATED, '   \n  '), null);
        assert.strictEqual(locateSnippet(REPEATED, undefined as any), null);
        assert.strictEqual(locateSnippet(undefined as any, 'x'), null);
    });
});

suite('locateByLastLine (fallback for callers without a display snippet)', () => {
    test('anchors on the reconstruction last meaningful line', () => {
        const reconstructed = 'class B {\n    public void execute(Function f, String projectId) {\n        beta();';
        const found = locateByLastLine(REPEATED, reconstructed);
        assert.ok(found);
        assert.strictEqual(lineOf(REPEATED, found!.start), 15);
    });

    test('returns null when the last line is not in the file', () => {
        assert.strictEqual(locateByLastLine(REPEATED, 'nothingHere();'), null);
    });
});
