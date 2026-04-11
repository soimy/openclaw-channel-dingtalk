import { describe, expect, it } from 'vitest';
import { listDingTalkAccountIds, resolveDingTalkAccount } from '../../src/config';

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
                    dmPolicy: 'allowlist',
                    displayNameResolution: 'all',
                    cardStreamingMode: 'off',
                },
            },
        } as any;

        const account = resolveDingTalkAccount(cfg, 'default');

        expect(account.accountId).toBe('default');
        expect(account.clientId).toBe('cli_default');
        expect(account.displayNameResolution).toBe('all');
        expect(account.cardStreamingMode).toBe('off');
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

    it('does not copy verboseRealtimeStream onto resolved accounts', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'cli_default',
                    clientSecret: 'sec_default',
                    verboseRealtimeStream: true,
                    accounts: {
                        main: {
                            clientId: 'cli_main',
                            clientSecret: 'sec_main',
                            verboseRealtimeStream: true,
                        },
                    },
                },
            },
        } as any;

        const defaultAccount = resolveDingTalkAccount(cfg, 'default') as Record<string, unknown>;
        const mainAccount = resolveDingTalkAccount(cfg, 'main') as Record<string, unknown>;

        expect('verboseRealtimeStream' in defaultAccount).toBe(false);
        expect('verboseRealtimeStream' in mainAccount).toBe(false);
        expect('verboseRealtimeStream' in ((defaultAccount.accounts as any)?.main ?? {})).toBe(false);
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

    it('resolves named account cardStreamingMode with account override', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    cardStreamingMode: 'off',
                    accounts: {
                        main: {
                            clientId: 'cli_main',
                            clientSecret: 'sec_main',
                            cardStreamingMode: 'all',
                        },
                    },
                },
            },
        } as any;

        const account = resolveDingTalkAccount(cfg, 'main');
        expect(account.cardStreamingMode).toBe('all');
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

    it('does not expose removed cardStreamReasoning from resolved accounts', () => {
        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'cli_default',
                    clientSecret: 'sec_default',
                    cardStreamReasoning: true,
                    accounts: {
                        main: {
                            clientId: 'cli_main',
                            clientSecret: 'sec_main',
                            cardStreamReasoning: true,
                        },
                    },
                },
            },
        } as any;

        const defaultAccount = resolveDingTalkAccount(cfg, 'default') as Record<string, unknown>;
        const mainAccount = resolveDingTalkAccount(cfg, 'main') as Record<string, unknown>;

        expect('cardStreamReasoning' in defaultAccount).toBe(false);
        expect('cardStreamReasoning' in mainAccount).toBe(false);
        expect('cardStreamReasoning' in ((defaultAccount.accounts as any)?.main ?? {})).toBe(false);
    });
});
