import { describe, expect, it } from 'vitest';
import { DingTalkConfigSchema } from '../../src/config-schema';

describe('DingTalkConfigSchema', () => {
    it('applies default maxReconnectCycles for top-level config', () => {
        const parsed = DingTalkConfigSchema.parse({
            clientId: 'id',
            clientSecret: 'secret',
        });

        expect(parsed.maxReconnectCycles).toBe(10);
    });

    it('accepts custom maxReconnectCycles for account config', () => {
        const parsed = DingTalkConfigSchema.parse({
            accounts: {
                main: {
                    clientId: 'id',
                    clientSecret: 'secret',
                    maxReconnectCycles: 3,
                },
            },
        });

        expect(parsed.accounts.main?.maxReconnectCycles).toBe(3);
    });
});
