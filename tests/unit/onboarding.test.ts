import { describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk', () => ({
    DEFAULT_ACCOUNT_ID: 'default',
    normalizeAccountId: (value: string) => value.trim() || 'default',
    formatDocsLink: (path: string) => `https://docs.example${path}`,
}));

import { dingtalkOnboardingAdapter } from '../../src/onboarding';

describe('dingtalkOnboardingAdapter', () => {
    it('getStatus returns configured=false for empty config', async () => {
        const result = await dingtalkOnboardingAdapter.getStatus({ cfg: {} as any });

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
            .mockResolvedValueOnce('7');

        const confirm = vi
            .fn()
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

        expect(result.accountId).toBe('default');
        expect(result.cfg.channels.dingtalk.clientId).toBe('ding_client');
        expect(result.cfg.channels.dingtalk.clientSecret).toBe('ding_secret');
        expect(result.cfg.channels.dingtalk.robotCode).toBe('ding_robot');
        expect(result.cfg.channels.dingtalk.messageType).toBe('card');
        expect(result.cfg.channels.dingtalk.cardTemplateId).toBe('tmpl.schema');
        expect(result.cfg.channels.dingtalk.cardTemplateKey).toBe('msgContent');
        expect(result.cfg.channels.dingtalk.allowFrom).toEqual(['user_a', 'user_b']);
        expect(result.cfg.channels.dingtalk.maxReconnectCycles).toBe(7);
        expect(note).toHaveBeenCalled();
    });
});
