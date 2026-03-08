import { describe, expect, it } from 'vitest';
import { DingTalkConfigSchema } from '../../src/config-schema';

describe('DingTalkConfigSchema', () => {
    it('applies default maxReconnectCycles for top-level config', () => {
        const parsed = DingTalkConfigSchema.parse({
            clientId: 'id',
            clientSecret: 'secret',
        }) as { maxReconnectCycles?: number };

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
        }) as { accounts: Record<string, { maxReconnectCycles?: number }> };

        expect(parsed.accounts.main?.maxReconnectCycles).toBe(3);
    });

    it('accepts mediaUrlAllowlist on top-level and account-level config', () => {
        const parsed = DingTalkConfigSchema.parse({
            clientId: 'id',
            clientSecret: 'secret',
            mediaUrlAllowlist: ['cdn.example.com'],
            accounts: {
                main: {
                    clientId: 'id',
                    clientSecret: 'secret',
                    mediaUrlAllowlist: ['192.168.1.23', 'files.internal.example'],
                },
            },
        }) as {
            mediaUrlAllowlist?: string[];
            accounts: Record<string, { mediaUrlAllowlist?: string[] }>;
        };

        expect(parsed.mediaUrlAllowlist).toEqual(['cdn.example.com']);
        expect(parsed.accounts.main?.mediaUrlAllowlist).toEqual(['192.168.1.23', 'files.internal.example']);
    });

    it('keeps keepAlive undefined when omitted', () => {
        const parsed = DingTalkConfigSchema.parse({
            clientId: 'id',
            clientSecret: 'secret',
        }) as { keepAlive?: boolean };

        expect(parsed.keepAlive).toBeUndefined();
    });

    it('keeps account-level keepAlive undefined when omitted', () => {
        const parsed = DingTalkConfigSchema.parse({
            accounts: {
                main: {
                    clientId: 'id',
                    clientSecret: 'secret',
                },
            },
        }) as { accounts: Record<string, { keepAlive?: boolean }> };

        expect(parsed.accounts.main?.keepAlive).toBeUndefined();
                },
            },
        }) as { accounts: Record<string, { keepAlive?: boolean }> };

        expect(parsed.accounts.main?.keepAlive).toBeUndefined();
    });

    it('accepts custom aicardDegradeMs for account config', () => {
        const parsed = DingTalkConfigSchema.parse({
            accounts: {
                main: {
                    clientId: 'id',
                    clientSecret: 'secret',
                    aicardDegradeMs: 120000,
                },
            },
        }) as { accounts: Record<string, { aicardDegradeMs?: number }> };

        expect(parsed.accounts.main?.aicardDegradeMs).toBe(120000);
    });
});
