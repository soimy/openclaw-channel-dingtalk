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
            .mockResolvedValueOnce('ding_client')       // clientId
            .mockResolvedValueOnce('ding_secret')        // clientSecret
            .mockResolvedValueOnce('ding_robot')         // robotCode
            .mockResolvedValueOnce('ding_corp')          // corpId
            .mockResolvedValueOnce('12345')              // agentId
            .mockResolvedValueOnce('tmpl.schema')        // cardTemplateId
            .mockResolvedValueOnce('')                   // cardTemplateKey
            .mockResolvedValueOnce('user_a, user_b')     // allowFrom
            .mockResolvedValueOnce('')                   // mediaUrlAllowlist
            .mockResolvedValueOnce('grp_user1, grp_user2') // groupAllowFrom
            .mockResolvedValueOnce('7')                  // maxReconnectCycles
            .mockResolvedValueOnce('20')                 // mediaMaxMb
            .mockResolvedValueOnce('14');                // journalTTLDays

        const confirm = vi
            .fn()
            .mockResolvedValueOnce(true)   // wantsFullConfig
            .mockResolvedValueOnce(true)   // wantsCardMode
            .mockResolvedValueOnce(true)   // wantsReconnectLimits
            .mockResolvedValueOnce(true)   // wantsMediaMax
            .mockResolvedValueOnce(true);  // wantsJournalTTL

        const select = vi
            .fn()
            .mockResolvedValueOnce('allowlist')  // dmPolicy
            .mockResolvedValueOnce('allowlist')  // groupPolicy
            .mockResolvedValueOnce('all');        // displayNameResolution

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
        expect(dingtalkConfig.cardTemplateKey).toBe('content');
        expect(dingtalkConfig.allowFrom).toEqual(['user_a', 'user_b']);
        expect(dingtalkConfig.groupAllowFrom).toEqual(['grp_user1', 'grp_user2']);
        expect(dingtalkConfig.displayNameResolution).toBe('all');
        expect(dingtalkConfig.mediaUrlAllowlist).toBeUndefined();
        expect(dingtalkConfig.maxReconnectCycles).toBe(7);
        expect(dingtalkConfig.mediaMaxMb).toBe(20);
        expect(dingtalkConfig.journalTTLDays).toBe(14);
        expect(note).toHaveBeenCalled();
    });

    it('configure with disabled groupPolicy skips groupAllowFrom prompt', async () => {
        const note = vi.fn();
        const text = vi
            .fn()
            .mockResolvedValueOnce('ding_client')   // clientId
            .mockResolvedValueOnce('ding_secret')    // clientSecret
            .mockResolvedValueOnce('')               // mediaUrlAllowlist (no card, no full config)
            .mockResolvedValueOnce('7')              // maxReconnectCycles
            .mockResolvedValueOnce('20')             // mediaMaxMb
            .mockResolvedValueOnce('14');            // journalTTLDays

        const confirm = vi
            .fn()
            .mockResolvedValueOnce(false)  // wantsFullConfig
            .mockResolvedValueOnce(false)  // wantsCardMode
            .mockResolvedValueOnce(true)   // wantsReconnectLimits
            .mockResolvedValueOnce(true)   // wantsMediaMax
            .mockResolvedValueOnce(true);  // wantsJournalTTL

        const select = vi
            .fn()
            .mockResolvedValueOnce('open')      // dmPolicy
            .mockResolvedValueOnce('disabled')   // groupPolicy
            .mockResolvedValueOnce('disabled');   // displayNameResolution

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

        expect(dingtalkConfig.groupPolicy).toBe('disabled');
        expect(dingtalkConfig.groupAllowFrom).toBeUndefined();
        // groupAllowFrom text prompt should NOT have been called
        // The text calls should be: clientId, clientSecret, mediaUrlAllowlist, maxReconnectCycles, mediaMaxMb, journalTTLDays
        expect(text).toHaveBeenCalledTimes(6);
    });
});
