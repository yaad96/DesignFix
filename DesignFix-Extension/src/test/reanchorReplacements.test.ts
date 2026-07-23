import * as assert from 'assert';
import { reanchorReplacements } from '../reanchorReplacements';

suite('reanchorReplacements', () => {
    test('applies a single anchored replacement against the current file', () => {
        const disk = 'class A {\n\tprotected static class Delete extends X {}\n}\n';
        const out = reanchorReplacements(disk, [
            { oldText: 'protected static class Delete', newText: 'public class Delete' },
        ]);
        assert.strictEqual(out, 'class A {\n\tpublic class Delete extends X {}\n}\n');
    });

    test('applies multiple non-overlapping replacements', () => {
        const disk = 'a1\nb2\nc3\n';
        const out = reanchorReplacements(disk, [
            { oldText: 'a1', newText: 'A1' },
            { oldText: 'c3', newText: 'C3' },
        ]);
        assert.strictEqual(out, 'A1\nb2\nC3\n');
    });

    test('returns null when an anchor is not present (a genuine change)', () => {
        assert.strictEqual(reanchorReplacements('class A {}\n', [{ oldText: 'not here', newText: 'x' }]), null);
    });

    test('returns null when an anchor is ambiguous (more than one match)', () => {
        assert.strictEqual(reanchorReplacements('foo;\nfoo;\n', [{ oldText: 'foo;', newText: 'bar;' }]), null);
    });

    test('returns null when anchors overlap', () => {
        assert.strictEqual(reanchorReplacements('abcdef\n', [
            { oldText: 'abcd', newText: 'X' },
            { oldText: 'cdef', newText: 'Y' },
        ]), null);
    });

    test('preserves the CRLF line endings of the current file', () => {
        assert.strictEqual(
            reanchorReplacements('x\r\nfoo\r\ny\r\n', [{ oldText: 'foo', newText: 'BAR' }]),
            'x\r\nBAR\r\ny\r\n'
        );
    });

    test('matches an LF-normalized multi-line anchor against a CRLF file', () => {
        // Client anchors are normalized to LF, but the file on disk may be CRLF.
        const out = reanchorReplacements('a\r\nfoo\r\nbar\r\nb\r\n', [
            { oldText: 'foo\nbar', newText: 'X\nY\nZ' },
        ]);
        assert.strictEqual(out, 'a\r\nX\r\nY\r\nZ\r\nb\r\n');
    });

    test('returns null for empty or missing replacements', () => {
        assert.strictEqual(reanchorReplacements('x\n', []), null);
        assert.strictEqual(reanchorReplacements('x\n', undefined), null);
    });

    test('returns null when a replacement is malformed', () => {
        assert.strictEqual(reanchorReplacements('foo\n', [{ oldText: 'foo' } as any]), null); // missing newText
        assert.strictEqual(reanchorReplacements('foo\n', [{ oldText: '', newText: 'x' }]), null); // empty anchor
    });

    test('applies against the CURRENT file even when the client snapshot drifted elsewhere', () => {
        // The bug scenario: the fix was generated from a client snapshot that differs
        // from disk in an UNRELATED region (a header comment and an added field), but
        // the anchored region is unchanged. The fix must still apply to the real file.
        const disk =
            '// header comment added later\n' +
            'class A {\n' +
            '\tprotected static class Delete extends X {}\n' +
            '\tint extra = 1;\n' +
            '}\n';
        const out = reanchorReplacements(disk, [
            { oldText: 'protected static class Delete', newText: 'public class Delete' },
        ]);
        assert.strictEqual(
            out,
            '// header comment added later\n' +
            'class A {\n' +
            '\tpublic class Delete extends X {}\n' +
            '\tint extra = 1;\n' +
            '}\n'
        );
    });
});
