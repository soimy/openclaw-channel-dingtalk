import { describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('dingtalk-stream', () => ({
    DWClient: vi.fn(),
    TOPIC_ROBOT: 'TOPIC_ROBOT',
}));

import { dingtalkPlugin } from '../../src/channel';

describe('channel config + status helpers', () => {
    it('resolves account list and account metadata', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    accounts: {
                        main: { clientId: 'id1', clientSecret: 'sec1', enabled: true, name: 'Main' },
                        backup: { clientId: 'id2', clientSecret: 'sec2', enabled: false },
                    },
                },
            },
        } as any;

        const ids = dingtalkPlugin.config.listAccountIds(cfg);
        const account = dingtalkPlugin.config.resolveAccount(cfg, 'main');

        expect(ids).toEqual(['main', 'backup']);
        expect(account.accountId).toBe('main');
        expect(account.configured).toBe(true);
        expect(dingtalkPlugin.config.describeAccount(account).name).toBe('Main');
    });

    it('validates outbound resolveTarget and messaging/security helpers', () => {
        const resolved = dingtalkPlugin.outbound.resolveTarget({ to: 'group:cidAbC' } as any);
        const invalid = dingtalkPlugin.outbound.resolveTarget({ to: '   ' } as any);

        expect(resolved).toEqual({ ok: true, to: 'cidAbC' });
        expect(invalid.ok).toBe(false);
        expect(dingtalkPlugin.messaging.normalizeTarget('dingtalk:user_1')).toBe('user_1');

        const dmPolicy = dingtalkPlugin.security.resolveDmPolicy({ account: { config: {} } } as any);
        expect(dmPolicy.policy).toBe('open');
        expect(dmPolicy.normalizeEntry('dd:User1')).toBe('User1');
    });

    it('builds status summary and issues from account snapshot', () => {
        const issues = dingtalkPlugin.status.collectStatusIssues([
            { accountId: 'a1', configured: false },
            { accountId: 'a2', configured: true },
        ] as any);

        const summary = dingtalkPlugin.status.buildChannelSummary({
            snapshot: { configured: true, running: false, lastError: 'err' },
        } as any);

        const snap = dingtalkPlugin.status.buildAccountSnapshot({
            account: { accountId: 'a1', name: 'A1', enabled: true, configured: true, config: { clientId: 'id1' } },
            runtime: { running: true, lastStartAt: 1, lastStopAt: null, lastError: null },
            snapshot: {},
            probe: { ok: true },
        } as any);

        expect(issues).toHaveLength(1);
        expect(summary.lastError).toBe('err');
        expect(snap.running).toBe(true);
        expect(snap.clientId).toBe('id1');
    });
});
