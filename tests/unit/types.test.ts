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

    it('resolves named account and falls back to empty when account missing', () => {
        const cfg = {
            channels: {
                dingtalk: {
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
                },
            },
        } as any;

        const account = resolveDingTalkAccount(cfg, 'default');
        expect(account.mediaMaxMb).toBe(50);
    });
});
