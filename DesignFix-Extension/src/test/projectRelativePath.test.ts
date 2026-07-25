import * as assert from 'assert';
import { FollowAndAuthorRulesProcessor } from '../FollowAndAuthorRulesProcessor';

// toProjectRelativePath is private; the logging behaviour it guards is worth
// pinning independently of the class's WebSocket surface.
const relativize = (projectRoot: string, filePath: unknown): string => {
    const processor = new FollowAndAuthorRulesProcessor(projectRoot, null);
    return (processor as any).toProjectRelativePath(filePath);
};

const stripRoot = (projectRoot: string, text: string): string => {
    const processor = new FollowAndAuthorRulesProcessor(projectRoot, null);
    return (processor as any).stripProjectRootFromText(text);
};

suite('Project-relative path logging', () => {
    test('strips the project root and normalizes separators', () => {
        assert.strictEqual(
            relativize('f:/CrowdCoding-ActiveDocumentation',
                'f:/CrowdCoding-ActiveDocumentation/src/com/crowdcoding/commands/TestCommand.java'),
            'src/com/crowdcoding/commands/TestCommand.java'
        );
        assert.strictEqual(
            relativize('f:\\CrowdCoding-ActiveDocumentation',
                'f:\\CrowdCoding-ActiveDocumentation\\src\\com\\Test.java'),
            'src/com/Test.java'
        );
    });

    test('tolerates a trailing separator or drive-letter case drift in the root', () => {
        assert.strictEqual(
            relativize('f:/CrowdCoding-ActiveDocumentation/',
                'f:/CrowdCoding-ActiveDocumentation/src/A.java'),
            'src/A.java'
        );
        assert.strictEqual(
            relativize('F:/CrowdCoding-ActiveDocumentation',
                'f:/CrowdCoding-ActiveDocumentation/src/A.java'),
            'src/A.java'
        );
    });

    test('keeps a file at the project root as a bare name', () => {
        assert.strictEqual(
            relativize('f:/project', 'f:/project/ruleTable.json'),
            'ruleTable.json'
        );
    });

    test('keeps the original path when a relative form would mislead', () => {
        // Outside the project root.
        assert.strictEqual(
            relativize('f:/project', 'f:/elsewhere/Other.java'),
            'f:/elsewhere/Other.java'
        );
        // The root itself has no meaningful relative form.
        assert.strictEqual(relativize('f:/project', 'f:/project'), 'f:/project');
        // No project root known.
        assert.strictEqual(relativize('', 'f:/project/src/A.java'), 'f:/project/src/A.java');
    });

    test('returns an empty string for absent or non-string paths', () => {
        assert.strictEqual(relativize('f:/project', undefined), '');
        assert.strictEqual(relativize('f:/project', null), '');
        assert.strictEqual(relativize('f:/project', ''), '');
        assert.strictEqual(relativize('f:/project', '   '), '');
        assert.strictEqual(relativize('f:/project', 42), '');
    });
});

suite('Project root stripping in recorded prompts and responses', () => {
    const root = 'f:/All CrowdCode Versions/No_Compilation_Error_CrowdCode';

    test('strips every occurrence in free text, including a root with spaces', () => {
        const prompt = [
            'Example file path: f:/All CrowdCode Versions/No_Compilation_Error_CrowdCode/src/com/x/A.java',
            '<<<ORIGINAL_FILE_PATH>>>',
            'f:/All CrowdCode Versions/No_Compilation_Error_CrowdCode/src/com/x/B.java',
        ].join('\n');

        assert.strictEqual(stripRoot(root, prompt), [
            'Example file path: src/com/x/A.java',
            '<<<ORIGINAL_FILE_PATH>>>',
            'src/com/x/B.java',
        ].join('\n'));
    });

    test('strips inside JSON string literals', () => {
        assert.strictEqual(
            stripRoot(root, '{"filePath":"f:/All CrowdCode Versions/No_Compilation_Error_CrowdCode/src/A.java"}'),
            '{"filePath":"src/A.java"}'
        );
    });

    test('matches either separator style and any drive-letter case', () => {
        assert.strictEqual(
            stripRoot('f:/project', 'see F:\\project\\src\\A.java and f:/project/src/B.java'),
            'see src\\A.java and src/B.java'
        );
    });

    test('leaves unrelated text and similar-but-different roots alone', () => {
        assert.strictEqual(stripRoot(root, 'no paths here'), 'no paths here');
        assert.strictEqual(
            stripRoot('f:/project', 'g:/project/src/A.java'),
            'g:/project/src/A.java'
        );
        // A longer sibling directory must not be truncated into a relative path.
        assert.strictEqual(
            stripRoot('f:/project', 'f:/project-archive/src/A.java'),
            'f:/project-archive/src/A.java'
        );
    });

    test('is a no-op when no project root is known', () => {
        assert.strictEqual(stripRoot('', 'f:/project/src/A.java'), 'f:/project/src/A.java');
    });
});
