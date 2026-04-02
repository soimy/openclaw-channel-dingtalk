import { describe, expect, it } from 'vitest';
import { getLogger, setCurrentLogger } from '../../src/logger-context';

describe('logger-context', () => {
    it('keeps account-scoped loggers while preserving the latest global fallback', () => {
        const logA = { debug: () => undefined };
        const logB = { debug: () => undefined };

        setCurrentLogger(logA as any, 'account-a');
        setCurrentLogger(logB as any, 'account-b');

        expect(getLogger('account-a')).toBe(logA);
        expect(getLogger('account-b')).toBe(logB);
        expect(getLogger()).toBe(logB);
    });
});
