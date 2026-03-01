import { describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk', () => ({
    DEFAULT_ACCOUNT_ID: 'default',
    normalizeAccountId: (value: string) => value.trim() || 'default',
    formatDocsLink: (path: string) => `https://docs.example${path}`,
}));

import { dingtalkOnboardingAdapter } from '../../src/onboarding';

describe('dingtalkOnboardingAdapter', () => {
    it('getStatus returns configured=false for empty config', async () => {
        const result = await dingtalkOnboardingAdapter.getStatus({ cfg: {}, accountOverrides: {} });

        expect(result.channel).toBe('dingtalk');
        expect(result.configured).toBe(false);
    });

    it('configure writes card + allowlist settings', async () => {
        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce('ding_client')
            .mockResolvedValueOnce('ding_secret')
            .mockResolvedValueOnce('ding_robot')
            .mockResolvedValueOnce('ding_corp')
            .mockResolvedValueOnce('12345')
            .mockResolvedValueOnce('tmpl.schema')
            .mockResolvedValueOnce('msgContent')
            .mockResolvedValueOnce('user_a, user_b')
            .mockResolvedValueOnce('7')
            .mockResolvedValueOnce('20');

        const confirm = vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true);

        const select = vi
            .fn()
            .mockResolvedValueOnce('allowlist')
            .mockResolvedValueOnce('allowlist');

        const result = await dingtalkOnboardingAdapter.configure({
            cfg: {} as any,
            prompter: { note, text, confirm, select },
            accountOverrides: {},
            shouldPromptAccountIds: false,
        } as any);

        const dingtalkConfig = result.cfg.channels?.dingtalk;
        expect(dingtalkConfig).toBeTruthy();
        if (!dingtalkConfig) {
            throw new Error('Expected dingtalk config to be present');
        }

        expect(result.accountId).toBe('default');
        expect(dingtalkConfig.clientId).toBe('ding_client');
        expect(dingtalkConfig.clientSecret).toBe('ding_secret');
        expect(dingtalkConfig.robotCode).toBe('ding_robot');
        expect(dingtalkConfig.messageType).toBe('card');
        expect(dingtalkConfig.cardTemplateId).toBe('tmpl.schema');
        expect(dingtalkConfig.cardTemplateKey).toBe('msgContent');
        expect(dingtalkConfig.allowFrom).toEqual(['user_a', 'user_b']);
        expect(dingtalkConfig.maxReconnectCycles).toBe(7);
        expect(dingtalkConfig.mediaMaxMb).toBe(20);
        expect(note).toHaveBeenCalled();
    });
});
