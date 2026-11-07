import * as assert from 'assert';
import * as path from 'path';
import {
    contentTypeFor,
    isAllowedHost,
    isLoopbackAddress,
    isOriginAllowed,
    originAuthority,
    resolveInside
} from '../requestGuards';

suite('requestGuards', () => {
    const allowed: ReadonlySet<string> = new Set(['127.0.0.1:5123', 'localhost:5123']);

    test('accepts only loopback peers', () => {
        assert.ok(isLoopbackAddress('127.0.0.1'));
        assert.ok(isLoopbackAddress('::1'));
        assert.ok(isLoopbackAddress('::ffff:127.0.0.1'));
        assert.ok(!isLoopbackAddress('192.168.1.20'));
        assert.ok(!isLoopbackAddress('::ffff:10.0.0.5'));
        assert.ok(!isLoopbackAddress(undefined));
    });

    test('accepts only the server\'s own Host header (DNS rebinding)', () => {
        assert.ok(isAllowedHost('127.0.0.1:5123', allowed));
        assert.ok(isAllowedHost('LOCALHOST:5123', allowed));
        assert.ok(!isAllowedHost('evil.example:5123', allowed));
        assert.ok(!isAllowedHost('127.0.0.1:9999', allowed));
        assert.ok(!isAllowedHost(undefined, allowed));
    });

    test('accepts only http(s) origins of allowed authorities', () => {
        assert.strictEqual(originAuthority('http://127.0.0.1:5123'), '127.0.0.1:5123');
        assert.ok(isOriginAllowed('http://127.0.0.1:5123', allowed));
        assert.ok(isOriginAllowed('http://localhost:5123', allowed));
        assert.ok(!isOriginAllowed('https://evil.example', allowed));
        assert.ok(!isOriginAllowed('http://127.0.0.1:5123.evil.example', allowed));
        assert.ok(!isOriginAllowed('null', allowed));
        assert.ok(!isOriginAllowed('file://', allowed));
        assert.ok(!isOriginAllowed(undefined, allowed));
    });

    test('keeps resolved paths inside the root', () => {
        const root = path.resolve('some-root', 'LearningDR');
        assert.strictEqual(resolveInside(root, 'features.txt'), path.join(root, 'features.txt'));
        assert.strictEqual(resolveInside(root, 'sub/file.txt'), path.join(root, 'sub', 'file.txt'));
        assert.strictEqual(resolveInside(root, '../escape.txt'), undefined);
        assert.strictEqual(resolveInside(root, '..\\..\\escape.txt'), undefined);
        assert.strictEqual(resolveInside(root, 'a/../../escape.txt'), undefined);
        assert.strictEqual(resolveInside(root, path.resolve('elsewhere', 'x.txt')), undefined);
        assert.strictEqual(resolveInside(root, '.'), undefined);
        assert.strictEqual(resolveInside(root, ''), undefined);
        assert.strictEqual(resolveInside(root, 'bad\0name'), undefined);
    });

    test('maps dashboard assets to content types', () => {
        assert.strictEqual(contentTypeFor('index.html'), 'text/html; charset=utf-8');
        assert.strictEqual(contentTypeFor('static/js/main.chunk.JS'), 'text/javascript; charset=utf-8');
        assert.strictEqual(contentTypeFor('font.woff2'), 'font/woff2');
        assert.strictEqual(contentTypeFor('unknown.bin'), 'application/octet-stream');
    });
});
