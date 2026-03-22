import { beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosRequestMock, axiosGetMock, axiosPostMock, getAccessTokenMock, dnsLookupMock } = vi.hoisted(() => ({
    axiosRequestMock: vi.fn(),
    axiosGetMock: vi.fn(),
    axiosPostMock: vi.fn(),
    getAccessTokenMock: vi.fn(),
    dnsLookupMock: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk/googlechat', () => ({
    extractToolSend: vi.fn((args: Record<string, unknown>) => {
        const target = args.to;
        if (typeof target !== 'string' || !target.trim()) {
            return null;
        }
        return { to: target.trim() };
    }),
}));

vi.mock('openclaw/plugin-sdk/matrix', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
    jsonResult: vi.fn((payload: unknown) => payload),
    readStringParam: vi.fn((params: Record<string, unknown>, key: string, opts?: { required?: boolean; allowEmpty?: boolean; trim?: boolean }) => {
        const raw = params[key];
        if (raw == null) {
            if (opts?.required) {
                throw new Error(`${key} is required`);
            }
            return undefined;
        }
        if (typeof raw !== 'string') {
            if (opts?.required) {
                throw new Error(`${key} must be a string`);
            }
            return undefined;
        }
        const normalized = opts?.trim === false ? raw : raw.trim();
        if (!opts?.allowEmpty && normalized.length === 0) {
            if (opts?.required) {
                throw new Error(`${key} is required`);
            }
            return undefined;
        }
        return normalized;
    }),
}));

vi.mock('dingtalk-stream', () => ({
    TOPIC_CARD: 'TOPIC_CARD',
    DWClient: vi.fn(),
    TOPIC_ROBOT: 'TOPIC_ROBOT',
}));

vi.mock('node:dns/promises', () => ({
    lookup: dnsLookupMock,
}));

vi.mock('../../src/auth', () => ({
    getAccessToken: getAccessTokenMock,
}));

vi.mock('axios', () => {
    const mockAxios = Object.assign(axiosRequestMock, {
        get: axiosGetMock,
        post: axiosPostMock,
        isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
    });
    return {
        default: mockAxios,
        isAxiosError: mockAxios.isAxiosError,
    };
});

import { dingtalkPlugin } from '../../src/channel';

describe('actions.send mediaUrl redirect integration', () => {
    beforeEach(() => {
        axiosRequestMock.mockReset();
        axiosGetMock.mockReset();
        axiosPostMock.mockReset();
        getAccessTokenMock.mockReset();
        dnsLookupMock.mockReset();

        getAccessTokenMock.mockResolvedValue('token_abc');
    });

    it('follows redirect with per-hop DNS pinning and uploads media before proactive send', async () => {
        dnsLookupMock
            .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as any)
            .mockResolvedValueOnce([{ address: '104.26.4.30', family: 4 }] as any);

        axiosGetMock
            .mockResolvedValueOnce({
                status: 302,
                headers: { location: 'https://cdn.example.com/img.png' },
                data: Buffer.from(''),
            } as any)
            .mockResolvedValueOnce({
                status: 200,
                headers: { 'content-type': 'image/png' },
                data: Buffer.from('img-bytes'),
            } as any);

        axiosPostMock.mockResolvedValueOnce({
            data: { errcode: 0, media_id: 'media_uploaded_1' },
        } as any);

        axiosRequestMock.mockResolvedValueOnce({
            data: { processQueryKey: 'proactive_1' },
        } as any);

        const result = await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: {
                channels: {
                    dingtalk: {
                        clientId: 'id',
                        clientSecret: 'sec',
                    },
                },
            },
            params: {
                to: 'cidA1B2C3',
                mediaUrl: 'https://example.com/path/photo',
            },
            accountId: 'default',
            dryRun: false,
        } as any);

        expect(result).toEqual(
            expect.objectContaining({
                ok: true,
                to: 'cidA1B2C3',
                mediaType: 'image',
                messageId: 'proactive_1',
            })
        );
        expect(getAccessTokenMock).toHaveBeenCalledTimes(2);
        expect(axiosGetMock).toHaveBeenCalledTimes(2);
        expect(axiosPostMock).toHaveBeenCalledTimes(1);
        expect(axiosRequestMock).toHaveBeenCalledTimes(1);

        const firstGetConfig = axiosGetMock.mock.calls[0]?.[1] as {
            lookup?: (hostname: string) => Promise<{ address: string; family: number }>;
        };
        const secondGetConfig = axiosGetMock.mock.calls[1]?.[1] as {
            lookup?: (hostname: string) => Promise<{ address: string; family: number }>;
        };

        expect(firstGetConfig.lookup).toBeTypeOf('function');
        expect(secondGetConfig.lookup).toBeTypeOf('function');
        await expect(firstGetConfig.lookup?.('example.com')).resolves.toEqual({
            address: '93.184.216.34',
            family: 4,
        });
        await expect(firstGetConfig.lookup?.('cdn.example.com')).rejects.toThrow(/unexpected host/);
        await expect(secondGetConfig.lookup?.('cdn.example.com')).resolves.toEqual({
            address: '104.26.4.30',
            family: 4,
        });
        await expect(secondGetConfig.lookup?.('example.com')).rejects.toThrow(/unexpected host/);

        expect(axiosPostMock.mock.calls[0]?.[0]).toContain(
            'https://oapi.dingtalk.com/media/upload?access_token=token_abc&type=image'
        );

        const proactiveRequest = axiosRequestMock.mock.calls[0]?.[0] as {
            url: string;
            data: { msgKey: string; msgParam: string; openConversationId: string };
            headers: Record<string, string>;
        };
        expect(proactiveRequest.url).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send');
        expect(proactiveRequest.headers['x-acs-dingtalk-access-token']).toBe('token_abc');
        expect(proactiveRequest.data.msgKey).toBe('sampleImageMsg');
        expect(proactiveRequest.data.openConversationId).toBe('cidA1B2C3');
        expect(JSON.parse(proactiveRequest.data.msgParam)).toEqual({ photoURL: 'media_uploaded_1' });

    });
});
