import * as assert from 'assert';
import { LearnDesignRules } from '../core/model/LearnDesignRules';
import { classifySrcmlFailure } from '../srcmlRunner';

suite('classifySrcmlFailure', () => {
    test('recognizes a missing srcML executable', () => {
        assert.strictEqual(classifySrcmlFailure({ code: 'ENOENT' }), 'not-found');
    });

    test('recognizes a missing Visual C++ runtime in either exit-code form', () => {
        assert.strictEqual(classifySrcmlFailure({ code: 0xC0000135 }), 'missing-runtime');
        assert.strictEqual(classifySrcmlFailure({ code: -1073741515 }), 'missing-runtime');
    });

    test('reports everything else as other', () => {
        assert.strictEqual(classifySrcmlFailure({ code: 1 }), 'other');
        assert.strictEqual(classifySrcmlFailure(new Error('boom')), 'other');
        assert.strictEqual(classifySrcmlFailure(undefined), 'other');
    });
});

suite('LearnDesignRules input validation', () => {
    test('accepts only the known SPMF algorithms', () => {
        assert.ok(LearnDesignRules.isSupportedAlgorithm('FPMax'));
        assert.ok(LearnDesignRules.isSupportedAlgorithm('CHUI-MinerMax'));
        assert.ok(!LearnDesignRules.isSupportedAlgorithm('FPMax & calc'));
        assert.ok(!LearnDesignRules.isSupportedAlgorithm('toString'));
        assert.ok(!LearnDesignRules.isSupportedAlgorithm(undefined));
    });

    test('accepts the numeric thresholds the dashboard sends', () => {
        assert.ok(LearnDesignRules.areValidParameters([1000]));
        assert.ok(LearnDesignRules.areValidParameters([0.005]));
        assert.ok(LearnDesignRules.areValidParameters(['60%', 1e-7]));
        assert.ok(LearnDesignRules.areValidParameters([]));
    });

    test('rejects anything that could smuggle in a command', () => {
        assert.ok(!LearnDesignRules.areValidParameters(['0.5 & calc.exe']));
        assert.ok(!LearnDesignRules.areValidParameters(['1; rm -rf ~']));
        assert.ok(!LearnDesignRules.areValidParameters(['$(whoami)']));
        assert.ok(!LearnDesignRules.areValidParameters('0.5'));
    });
});
