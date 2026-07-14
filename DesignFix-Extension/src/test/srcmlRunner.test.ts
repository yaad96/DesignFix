import * as assert from 'assert';
import { ExecFileException } from 'child_process';
import {
    buildJavaToXmlArguments,
    convertJavaToXml,
    extractFirstSourceUnit,
    isRetryableSrcmlCrash,
    SrcmlExecutor
} from '../srcmlRunner';

function srcmlError(code: number | string): ExecFileException {
    return Object.assign(new Error(`srcML failed with ${code}`), { code }) as ExecFileException;
}

suite('srcML runner', () => {
    test('uses stable single-threaded Java arguments without shell quoting', () => {
        assert.deepStrictEqual(
            buildJavaToXmlArguments('C:\\Project With Spaces\\Example.java'),
            [
                '--max-threads',
                '1',
                '--in-order',
                '--language',
                'Java',
                'C:\\Project With Spaces\\Example.java'
            ]
        );
    });

    test('recognizes unsigned and signed native Windows crash codes', () => {
        assert.strictEqual(isRetryableSrcmlCrash(srcmlError(0xC0000374)), true);
        assert.strictEqual(isRetryableSrcmlCrash(srcmlError(-1073740940)), true);
        assert.strictEqual(isRetryableSrcmlCrash(srcmlError(0xC0000005)), true);
        assert.strictEqual(isRetryableSrcmlCrash(srcmlError('ENOENT')), false);
        assert.strictEqual(isRetryableSrcmlCrash(srcmlError(1)), false);
    });

    test('retries native crashes and returns the successful XML', async () => {
        const calls: ReadonlyArray<string>[] = [];
        const outcomes = [
            srcmlError(0xC0000374),
            srcmlError(0xC0000005),
            null
        ];
        const executor: SrcmlExecutor = (_binary, args, callback) => {
            calls.push([...args]);
            const error = outcomes.shift() ?? null;
            callback(error, error ? '<partial/>' : '<unit language="Java"/>', 'diagnostic');
        };

        const xml = await convertJavaToXml('Example.java', executor);

        assert.strictEqual(xml, '<unit language="Java"/>');
        assert.strictEqual(calls.length, 3);
    });

    test('stops after three native crashes', async () => {
        let calls = 0;
        const executor: SrcmlExecutor = (_binary, _args, callback) => {
            calls += 1;
            callback(srcmlError(0xC0000374), '<unit/>', '');
        };

        await assert.rejects(
            convertJavaToXml('Example.java', executor),
            (error: ExecFileException) => error.code === 0xC0000374
        );
        assert.strictEqual(calls, 3);
    });

    test('does not retry ordinary command failures', async () => {
        let calls = 0;
        const executor: SrcmlExecutor = (_binary, _args, callback) => {
            calls += 1;
            callback(srcmlError(1), '', 'parse error');
        };

        await assert.rejects(
            convertJavaToXml('Example.java', executor),
            (error: ExecFileException) => error.code === 1
        );
        assert.strictEqual(calls, 1);
    });

    test('uses the stable execution settings when extracting a source unit', async () => {
        let capturedArgs: readonly string[] = [];
        const executor: SrcmlExecutor = (_binary, args, callback) => {
            capturedArgs = [...args];
            callback(null, 'class Example {}', '');
        };

        const source = await extractFirstSourceUnit('Example.xml', executor);

        assert.strictEqual(source, 'class Example {}');
        assert.deepStrictEqual(capturedArgs, [
            '--max-threads',
            '1',
            '--in-order',
            '--unit',
            '1',
            'Example.xml'
        ]);
    });
});
