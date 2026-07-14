import * as assert from 'assert';
import { normalizeSourceSnapshot, sourceSnapshotsEqual } from '../sourceSnapshot';

suite('Source snapshot normalization', () => {
    test('accepts srcML wrapper blank lines and newline conversion', () => {
        const disk = 'package demo;\n\nclass Project {\n\tint value;\n}\n';
        const srcmlRoundTrip = '\r\npackage demo;\r\n\r\nclass Project {\r\n\tint value;\r\n}\r\n\r\n';

        assert.strictEqual(sourceSnapshotsEqual(disk, srcmlRoundTrip), true);
        assert.strictEqual(normalizeSourceSnapshot(disk), normalizeSourceSnapshot(srcmlRoundTrip));
    });

    test('accepts a UTF-8 BOM but retains internal source differences', () => {
        assert.strictEqual(sourceSnapshotsEqual('\uFEFFclass A {}\n', 'class A {}'), true);
        assert.strictEqual(sourceSnapshotsEqual('class A { int x; }', 'class A { long x; }'), false);
        assert.strictEqual(sourceSnapshotsEqual('class A {  int x; }', 'class A { int x; }'), false);
    });
});
