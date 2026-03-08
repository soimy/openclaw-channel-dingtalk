import { describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('dingtalk-stream', () => ({
    TOPIC_CARD: 'TOPIC_CARD',
    DWClient: vi.fn(),
    TOPIC_ROBOT: 'TOPIC_ROBOT',
}));

import { dingtalkPlugin } from '../../src/channel';

const plugin = dingtalkPlugin as any;

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

        const ids = plugin.config.listAccountIds(cfg);
        const account = plugin.config.resolveAccount(cfg, 'main');

        expect(ids).toEqual(['main', 'backup']);
        expect(account.accountId).toBe('main');
        expect(account.configured).toBe(true);
        expect(plugin.config.describeAccount(account).name).toBe('Main');
    });

    it('resolveAccount merges channel-level defaults into named account', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    dmPolicy: 'allowlist',
                    allowFrom: ['user1'],
                    messageType: 'card',
                    cardTemplateId: 'tpl.schema',
                    showThinking: false,
                    accounts: {
                        main: { clientId: 'id1', clientSecret: 'sec1', name: 'Main' },
                        custom: { clientId: 'id2', clientSecret: 'sec2', dmPolicy: 'open' },
                    },
                },
            },
        } as any;

        const main = plugin.config.resolveAccount(cfg, 'main');
        expect(main.config.clientId).toBe('id1');
        expect(main.config.dmPolicy).toBe('allowlist');
        expect(main.config.allowFrom).toEqual(['user1']);
        expect(main.config.messageType).toBe('card');
        expect(main.config.cardTemplateId).toBe('tpl.schema');
        expect(main.config.showThinking).toBe(false);

        const custom = plugin.config.resolveAccount(cfg, 'custom');
        expect(custom.config.dmPolicy).toBe('open');
        expect(custom.config.messageType).toBe('card');
    });

    it('validates outbound resolveTarget and messaging/security helpers', () => {
        const resolved = plugin.outbound.resolveTarget({ to: 'group:cidAbC' } as any);
        const invalid = plugin.outbound.resolveTarget({ to: '   ' } as any);

        expect(resolved).toEqual({ ok: true, to: 'cidAbC' });
        expect(invalid.ok).toBe(false);
        expect(plugin.messaging.normalizeTarget('dingtalk:user_1')).toBe('user_1');

        const dmPolicy = plugin.security.resolveDmPolicy({ account: { config: {} } } as any);
        expect(dmPolicy.policy).toBe('open');
        expect(dmPolicy.normalizeEntry('dd:User1')).toBe('User1');
    });

    it('builds status summary and issues from account snapshot', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-08T12:00:00.000Z'));
        try {
            const issues = plugin.status.collectStatusIssues([
                { accountId: 'a1', configured: false },
                { accountId: 'a2', configured: true },
            ] as any);

            const summary = plugin.status.buildChannelSummary({
                snapshot: { configured: true, running: false, lastError: 'err' },
            } as any);

            const snap = plugin.status.buildAccountSnapshot({
                account: { accountId: 'a1', name: 'A1', enabled: true, configured: true, config: { clientId: 'id1' } },
                runtime: { running: true, lastStartAt: 1, lastStopAt: null, lastError: null },
                snapshot: {},
                probe: { ok: true },
            } as any);

            const stoppedSnap = plugin.status.buildAccountSnapshot({
                account: { accountId: 'a1', name: 'A1', enabled: true, configured: true, config: { clientId: 'id1' } },
                runtime: { running: false, lastEventAt: 123, lastStartAt: 1, lastStopAt: null, lastError: null },
                snapshot: {},
                probe: { ok: true },
            } as any);

            expect(issues).toHaveLength(1);
            expect(summary.lastError).toBe('err');
            expect(snap.running).toBe(true);
            expect(snap.clientId).toBe('id1');
            expect(snap.lastEventAt).toBe(Date.now());
            expect(stoppedSnap.lastEventAt).toBe(123);
        } finally {
            vi.useRealTimers();
        }
    });
});
