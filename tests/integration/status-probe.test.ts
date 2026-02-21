import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAccessTokenMock } = vi.hoisted(() => ({
    getAccessTokenMock: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('dingtalk-stream', () => ({
    DWClient: vi.fn(),
    TOPIC_ROBOT: 'TOPIC_ROBOT',
}));

vi.mock('../../src/auth', () => ({
    getAccessToken: getAccessTokenMock,
}));

import { dingtalkPlugin } from '../../src/channel';

describe('dingtalkPlugin.status.probeAccount', () => {
    beforeEach(() => {
        getAccessTokenMock.mockReset();
    });

    it('uses current account credentials for multi-account config', async () => {
        const cfg = {
            channels: {
                dingtalk: {
                    accounts: {
                        main: {
                            clientId: 'cli_main',
                            clientSecret: 'sec_main',
                            enabled: true,
                        },
                    },
                },
            },
        } as OpenClawConfig;

        const account = dingtalkPlugin.config.resolveAccount(cfg, 'main');
        getAccessTokenMock.mockResolvedValueOnce('token_main');

        const result = await dingtalkPlugin.status.probeAccount?.({ account, timeoutMs: 1000 });

        expect(getAccessTokenMock).toHaveBeenCalledTimes(1);
        expect(getAccessTokenMock).toHaveBeenCalledWith(
            expect.objectContaining({ clientId: 'cli_main', clientSecret: 'sec_main' })
        );
        expect(result).toEqual({ ok: true, details: { clientId: 'cli_main' } });
    });

    it('returns not configured when account is missing credentials', async () => {
        const account = {
            accountId: 'default',
            configured: false,
            config: {},
        } as any;

        const result = await dingtalkPlugin.status.probeAccount?.({ account, timeoutMs: 1000 });

        expect(result).toEqual({ ok: false, error: 'Not configured' });
        expect(getAccessTokenMock).not.toHaveBeenCalled();
    });

    it('returns failed probe result when token retrieval throws', async () => {
        const account = {
            accountId: 'default',
            configured: true,
            config: { clientId: 'ding_id', clientSecret: 'ding_sec' },
        } as any;

        getAccessTokenMock.mockRejectedValueOnce(new Error('DingTalk API error 300001'));

        const result = await dingtalkPlugin.status.probeAccount?.({ account, timeoutMs: 1000 });

        expect(result).toEqual({ ok: false, error: 'DingTalk API error 300001' });
    });
});
