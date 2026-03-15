import { describe, expect, it } from 'vitest';
import { DingTalkConfigSchema } from '../../src/config-schema';

describe('DingTalkConfigSchema', () => {
    it('applies default journalTTLDays for top-level config', () => {
        const parsed = DingTalkConfigSchema.parse({
            clientId: 'id',
            clientSecret: 'secret',
        }) as { journalTTLDays?: number };

        expect(parsed.journalTTLDays).toBe(7);
    });

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

    it('accepts custom journalTTLDays for account config', () => {
        const parsed = DingTalkConfigSchema.parse({
            accounts: {
                main: {
                    clientId: 'id',
                    clientSecret: 'secret',
                    journalTTLDays: 14,
                },
            },
        }) as { accounts: Record<string, { journalTTLDays?: number }> };

        expect(parsed.accounts.main?.journalTTLDays).toBe(14);
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

    it('accepts learning config and default auto-apply/note ttl', () => {
        const parsed = DingTalkConfigSchema.parse({
            clientId: 'id',
            clientSecret: 'secret',
            learningEnabled: true,
            allowFrom: ['owner-test-id'],
        }) as { learningEnabled?: boolean; allowFrom?: string[]; learningAutoApply?: boolean; learningNoteTtlMs?: number };

        expect(parsed.learningEnabled).toBe(true);
        expect(parsed.allowFrom).toEqual(['owner-test-id']);
        expect(parsed.learningAutoApply).toBeUndefined();
        expect(parsed.learningNoteTtlMs).toBeUndefined();
    });

    it('keeps backward compatibility for legacy feedback learning keys', () => {
        const parsed = DingTalkConfigSchema.parse({
            clientId: 'id',
            clientSecret: 'secret',
            feedbackLearningEnabled: true,
            feedbackLearningAutoApply: true,
            feedbackLearningNoteTtlMs: 120000,
        }) as {
            learningEnabled?: boolean;
            learningAutoApply?: boolean;
            learningNoteTtlMs?: number;
            feedbackLearningEnabled?: boolean;
            feedbackLearningAutoApply?: boolean;
            feedbackLearningNoteTtlMs?: number;
        };

        expect(parsed.learningEnabled).toBeUndefined();
        expect(parsed.learningAutoApply).toBeUndefined();
        expect(parsed.learningNoteTtlMs).toBeUndefined();
        expect(parsed.feedbackLearningEnabled).toBe(true);
        expect(parsed.feedbackLearningAutoApply).toBe(true);
        expect(parsed.feedbackLearningNoteTtlMs).toBe(120000);
    });

    it('accepts ackReaction config and defaults it to the native DingTalk ack reaction', () => {
        const parsed = DingTalkConfigSchema.parse({
            clientId: 'id',
            clientSecret: 'secret',
            ackReaction: '✅',
        }) as { ackReaction?: string };

        expect(parsed.ackReaction).toBe('✅');

        const defaults = DingTalkConfigSchema.parse({
            clientId: 'id',
            clientSecret: 'secret',
        }) as { ackReaction?: string };

        expect(defaults.ackReaction).toBe('🤔思考中');
    });

    it('exports control-ui-compatible JSON schema nodes', () => {
        const jsonSchema = DingTalkConfigSchema.toJSONSchema({
            target: 'draft-07',
            unrepresentable: 'any',
        }) as {
            type?: string;
            properties?: Record<string, any>;
        };

        expect(jsonSchema.type).toBe('object');
        expect(jsonSchema.properties?.accounts?.type).toBe('object');
        expect(jsonSchema.properties?.accounts?.additionalProperties?.type).toBe('object');
    });

});
