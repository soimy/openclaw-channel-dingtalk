import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMessageMock, getRuntimeMock } = vi.hoisted(() => ({
    sendMessageMock: vi.fn(),
    getRuntimeMock: vi.fn(),
}));
const { getLoggerMock } = vi.hoisted(() => ({
    getLoggerMock: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk/core', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('dingtalk-stream', () => ({
    TOPIC_CARD: 'TOPIC_CARD',
    DWClient: vi.fn(),
    TOPIC_ROBOT: 'TOPIC_ROBOT',
}));

vi.mock('../../src/send-service', async () => ({
    detectMediaTypeFromExtension: vi.fn().mockReturnValue('file'),
    sendMessage: sendMessageMock,
    sendProactiveTextOrMarkdown: vi.fn(),
    sendProactiveMedia: vi.fn(),
    sendBySession: vi.fn(),
    uploadMedia: vi.fn(),
}));

vi.mock('../../src/runtime', () => ({
    getDingTalkRuntime: getRuntimeMock,
}));
vi.mock('../../src/logger-context', () => ({
    getLogger: getLoggerMock,
    setCurrentLogger: vi.fn(),
}));

import { dingtalkPlugin } from '../../src/channel';

describe('plugin outbound lifecycle', () => {
    beforeEach(() => {
        sendMessageMock.mockReset();
        getRuntimeMock.mockReset();
        getLoggerMock.mockReset();
        getLoggerMock.mockReturnValue(undefined);
        getRuntimeMock.mockReturnValue({
            channel: {
                session: {
                    resolveStorePath: vi.fn().mockReturnValue('/tmp/default-store.json'),
                },
            },
        });
    });

    it('should route outbound.sendText through sendMessage hub', async () => {
        const sendText = dingtalkPlugin.outbound?.sendText;
        if (!sendText) {
            throw new Error('dingtalkPlugin.outbound.sendText is not defined');
        }
        sendMessageMock.mockResolvedValue({ ok: true, data: { messageId: 'm_123' } });

        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'ding-client-id',
                    clientSecret: 'secret',
                },
            },
        };

        const result = await sendText({
            cfg,
            to: 'user_123',
            text: 'hello',
            accountId: 'default',
        });

        expect(sendMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ clientId: 'ding-client-id' }),
            'user_123',
            'hello',
            expect.objectContaining({ accountId: 'default', storePath: expect.any(String) })
        );
        expect(result.channel).toBe('dingtalk');
        expect(result.messageId).toBe('m_123');
    });

    it('should expose proactive card tracking metadata from outbound.sendText', async () => {
        const sendText = dingtalkPlugin.outbound?.sendText;
        if (!sendText) {
            throw new Error('dingtalkPlugin.outbound.sendText is not defined');
        }
        sendMessageMock.mockResolvedValue({
            ok: true,
            tracking: {
                outTrackId: 'track_card_1',
                processQueryKey: 'card_process_1',
                cardInstanceId: 'card_instance_1',
            },
        });

        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'ding-client-id',
                    clientSecret: 'secret',
                },
            },
        };

        const result = await sendText({
            cfg,
            to: 'user_123',
            text: 'hello card',
            accountId: 'default',
        });

        expect(result.channel).toBe('dingtalk');
        expect(result.meta).toEqual(
            expect.objectContaining({
                tracking: {
                    outTrackId: 'track_card_1',
                    processQueryKey: 'card_process_1',
                    cardInstanceId: 'card_instance_1',
                },
            })
        );
    });

    it('should capture DingTalk API error code and throw from sendText', async () => {
        const sendText = dingtalkPlugin.outbound?.sendText;
        if (!sendText) {
            throw new Error('dingtalkPlugin.outbound.sendText is not defined');
        }
        sendMessageMock.mockResolvedValue({ ok: false, error: 'DingTalk API error 300001: invalid robot code' });

        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'ding-client-id',
                    clientSecret: 'secret',
                },
            },
        };

        await expect(
            sendText({
                cfg,
                to: 'cidA1B2C3',
                text: 'hello',
                accountId: 'default',
            })
        ).rejects.toThrow(/300001/);
    });

    it('prefers the current account plugin log over an explicit outbound log', async () => {
        const sendText = dingtalkPlugin.outbound?.sendText;
        if (!sendText) {
            throw new Error('dingtalkPlugin.outbound.sendText is not defined');
        }
        const otherAccountLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const accountLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const explicitLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        getLoggerMock.mockImplementation((accountId?: string) => {
            if (accountId === 'default') {
                return accountLog;
            }
            return otherAccountLog;
        });
        sendMessageMock.mockResolvedValue({ ok: true, data: { messageId: 'm_explicit' } });

        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'ding-client-id',
                    clientSecret: 'secret',
                },
            },
        };

        await sendText({
            cfg,
            to: 'user_123',
            text: 'hello explicit',
            accountId: 'default',
            log: explicitLog,
        });

        expect(sendMessageMock).toHaveBeenCalledWith(
            expect.any(Object),
            'user_123',
            'hello explicit',
            expect.objectContaining({ log: accountLog }),
        );
        expect(getLoggerMock).toHaveBeenCalledWith('default');
        expect(accountLog.debug).toHaveBeenCalled();
        expect(explicitLog.debug).not.toHaveBeenCalled();
        expect(otherAccountLog.debug).not.toHaveBeenCalled();
    });

});
