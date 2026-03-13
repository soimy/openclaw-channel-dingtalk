import { describe, expect, it } from 'vitest';
import { listDingTalkAccountIds, resolveDingTalkAccount } from '../../src/types';

describe('types helpers', () => {
    it('lists default and named account ids', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'cli_default',
                    accounts: {
                        main: { clientId: 'cli_main', clientSecret: 'sec_main' },
                        backup: { clientId: 'cli_bak', clientSecret: 'sec_bak' },
                    },
                },
            },
        } as any;

        expect(listDingTalkAccountIds(cfg)).toEqual(['default', 'main', 'backup']);
    });

    it('resolves default account from top-level config', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'cli_default',
                    clientSecret: 'sec_default',
                    robotCode: 'robot_default',
                    dmPolicy: 'allowlist',
                },
            },
        } as any;

        const account = resolveDingTalkAccount(cfg, 'default');

        expect(account.accountId).toBe('default');
        expect(account.clientId).toBe('cli_default');
        expect(account.robotCode).toBe('robot_default');
        expect(account.configured).toBe(true);
    });

    it('resolves named account with channel-level defaults and falls back to empty when account missing', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    dmPolicy: 'allowlist',
                    messageType: 'card',
                    accounts: {
                        main: { clientId: 'cli_main', clientSecret: 'sec_main', enabled: true },
                    },
                },
            },
        } as any;

        const main = resolveDingTalkAccount(cfg, 'main');
        const missing = resolveDingTalkAccount(cfg, 'not_found');

        expect(main.accountId).toBe('main');
        expect(main.configured).toBe(true);
        expect(main.dmPolicy).toBe('allowlist');
        expect(main.messageType).toBe('card');
        expect((main as any).accounts).toBeUndefined();
        expect(missing).toEqual({
            clientId: '',
            clientSecret: '',
            accountId: 'not_found',
            configured: false,
        });
    });

    it('resolves default account with mediaMaxMb from config', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'cli',
                    clientSecret: 'sec',
                    mediaMaxMb: 50,
                    aicardDegradeMs: 120000,
                    bypassProxyForSend: true,
                },
            },
        } as any;

        const account = resolveDingTalkAccount(cfg, 'default');
        expect(account.mediaMaxMb).toBe(50);
        expect(account.aicardDegradeMs).toBe(120000);
        expect(account.bypassProxyForSend).toBe(true);
        expect(account.aicardDegradeMs).toBe(120000);
        expect(account.bypassProxyForSend).toBe(true);
    });

    it('resolves named account with inherited bypassProxyForSend default', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    bypassProxyForSend: true,
                    learningEnabled: true,
                    allowFrom: ['owner-test-id'],
                    learningAutoApply: true,
                    learningNoteTtlMs: 120000,
                    accounts: {
                        main: { clientId: 'cli_main', clientSecret: 'sec_main' },
                    },
                },
            },
        } as any;

        const account = resolveDingTalkAccount(cfg, 'main');
        expect(account.bypassProxyForSend).toBe(true);
        expect(account.learningEnabled).toBe(true);
        expect(account.allowFrom).toEqual(['owner-test-id']);
        expect(account.learningAutoApply).toBe(true);
        expect(account.learningNoteTtlMs).toBe(120000);
    });

    it('resolves journalTTLDays from top-level and named account config', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'cli_default',
                    clientSecret: 'sec_default',
                    journalTTLDays: 7,
                    accounts: {
                        main: { clientId: 'cli_main', clientSecret: 'sec_main', journalTTLDays: 21 },
                    },
                },
            },
        } as any;

        expect(resolveDingTalkAccount(cfg, 'default').journalTTLDays).toBe(7);
        expect(resolveDingTalkAccount(cfg, 'main').journalTTLDays).toBe(21);
    });
});
