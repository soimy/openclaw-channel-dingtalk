import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    sendMediaMock,
    getRuntimeMock,
} = vi.hoisted(() => ({
    sendMediaMock: vi.fn(),
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
    sendMessage: vi.fn(),
    sendProactiveMedia: vi.fn(),
    sendBySession: vi.fn(),
    sendMedia: sendMediaMock,
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

function requireSendMedia() {
    const outbound = dingtalkPlugin.outbound;
    if (!outbound?.sendMedia) {
        throw new Error('dingtalk outbound.sendMedia is not available');
    }
    return outbound.sendMedia;
}

describe('dingtalkPlugin.outbound.sendMedia flow', () => {
    beforeEach(() => {
        sendMediaMock.mockReset().mockResolvedValue({
            ok: true,
            data: { messageId: 'media_1' },
            messageId: 'media_1',
        });
        getRuntimeMock.mockReset().mockReturnValue({
            channel: {
                session: {
                    resolveStorePath: vi.fn().mockReturnValue('/tmp/default-store.json'),
                },
            },
        });
        getLoggerMock.mockReset().mockReturnValue(undefined);
    });

    it('delegates outbound media send to unified sendMedia service and normalizes response', async () => {
        const sendMedia = requireSendMedia();

        const result = await sendMedia({
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'cidA1B2C3',
            text: '',
            mediaPath: './fixtures/photo.png',
            accountId: 'default',
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.objectContaining({ clientId: 'id', clientSecret: 'sec' }),
            'cidA1B2C3',
            './fixtures/photo.png',
            expect.objectContaining({
                accountId: 'default',
                storePath: '/tmp/default-store.json',
                conversationId: 'cidA1B2C3',
                mediaType: undefined,
                audioAsVoice: false,
            }),
        );
        expect(result).toEqual(
            expect.objectContaining({
                channel: 'dingtalk',
                messageId: 'media_1',
                meta: { data: { messageId: 'media_1' } },
            }),
        );
    });

    it('passes explicit mediaType and voice flags through to unified sendMedia service', async () => {
        const sendMedia = requireSendMedia();

        await sendMedia({
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'user_123',
            text: '',
            mediaPath: '/tmp/audio.mp3',
            mediaType: 'voice',
            asVoice: true,
            accountId: 'default',
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'user_123',
            '/tmp/audio.mp3',
            expect.objectContaining({
                accountId: 'default',
                mediaType: 'voice',
                audioAsVoice: true,
                conversationId: 'user_123',
            }),
        );
    });

    it('passes remote mediaUrl through without local preprocessing in the wrapper layer', async () => {
        const sendMedia = requireSendMedia();

        await sendMedia({
            cfg: {
                channels: {
                    dingtalk: {
                        clientId: 'id',
                        clientSecret: 'sec',
                        mediaUrlAllowlist: ['192.168.1.23', 'cdn.example.com'],
                    },
                },
            },
            to: 'cidA1B2C3',
            text: '',
            mediaUrl: 'http://192.168.1.23/photo.png',
            accountId: 'default',
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.objectContaining({
                mediaUrlAllowlist: ['192.168.1.23', 'cdn.example.com'],
            }),
            'cidA1B2C3',
            'http://192.168.1.23/photo.png',
            expect.objectContaining({
                accountId: 'default',
                conversationId: 'cidA1B2C3',
            }),
        );
    });

    it('throws when unified sendMedia reports a DingTalk send error', async () => {
        const sendMedia = requireSendMedia();
        sendMediaMock.mockResolvedValueOnce({ ok: false, error: 'DingTalk API error 300001' });

        await expect(
            sendMedia({
                cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
                to: 'cidA1B2C3',
                text: '',
                mediaPath: '/tmp/doc.pdf',
                accountId: 'default',
            } as any),
        ).rejects.toThrow(/300001/);
    });

    it('rethrows sendMedia preparation failures from the unified service', async () => {
        const sendMedia = requireSendMedia();
        sendMediaMock.mockRejectedValueOnce(
            new Error('remote media preparation failed: [ERR_MEDIA_PRIVATE_HOST] private host'),
        );

        await expect(
            sendMedia({
                cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
                to: 'cidA1B2C3',
                text: '',
                mediaUrl: 'http://127.0.0.1/photo.png',
                accountId: 'default',
            } as any),
        ).rejects.toThrow(/remote media preparation failed: \[ERR_MEDIA_PRIVATE_HOST\]/);
    });

    it('prefers the current account plugin log over an explicit outbound log', async () => {
        const sendMedia = requireSendMedia();
        const otherAccountLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const accountLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const explicitLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        getLoggerMock.mockImplementation((accountId?: string) => {
            if (accountId === 'default') {
                return accountLog;
            }
            return otherAccountLog;
        });

        await sendMedia({
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'cidA1B2C3',
            text: '',
            mediaPath: './fixtures/photo.png',
            accountId: 'default',
            log: explicitLog,
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'cidA1B2C3',
            './fixtures/photo.png',
            expect.objectContaining({ log: accountLog }),
        );
        expect(getLoggerMock).toHaveBeenCalledWith('default');
        expect(accountLog.debug).toHaveBeenCalled();
        expect(explicitLog.debug).not.toHaveBeenCalled();
        expect(otherAccountLog.debug).not.toHaveBeenCalled();
    });
});
