import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { detectMediaTypeFromExtensionMock, prepareMediaInputMock, sendProactiveMediaMock } = vi.hoisted(() => ({
    detectMediaTypeFromExtensionMock: vi.fn(),
    prepareMediaInputMock: vi.fn(),
    sendProactiveMediaMock: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('dingtalk-stream', () => ({
    DWClient: vi.fn(),
    TOPIC_ROBOT: 'TOPIC_ROBOT',
}));

vi.mock('../../src/send-service', async () => ({
    detectMediaTypeFromExtension: detectMediaTypeFromExtensionMock,
    sendMessage: vi.fn(),
    sendProactiveMedia: sendProactiveMediaMock,
    sendBySession: vi.fn(),
    uploadMedia: vi.fn(),
}));

vi.mock('../../src/media-utils', async () => ({
    prepareMediaInput: prepareMediaInputMock,
}));

import { dingtalkPlugin } from '../../src/channel';

describe('dingtalkPlugin.outbound.sendMedia flow', () => {
    beforeEach(() => {
        detectMediaTypeFromExtensionMock.mockReset();
        prepareMediaInputMock.mockReset();
        sendProactiveMediaMock.mockReset();
        prepareMediaInputMock.mockImplementation(async (input: string) => ({ path: input }));
    });

    it('auto-detects mediaType and sends with resolved absolute path', async () => {
        detectMediaTypeFromExtensionMock.mockReturnValueOnce('image');
        sendProactiveMediaMock.mockResolvedValueOnce({
            ok: true,
            data: { processQueryKey: 'media_1' },
            messageId: 'media_1',
        });

        const result = await dingtalkPlugin.outbound.sendMedia({
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'cidA1B2C3',
            mediaPath: './fixtures/photo.png',
            accountId: 'default',
        });

        expect(detectMediaTypeFromExtensionMock).toHaveBeenCalledWith(path.resolve('./fixtures/photo.png'));
        expect(sendProactiveMediaMock).toHaveBeenCalledWith(
            expect.objectContaining({ clientId: 'id' }),
            'cidA1B2C3',
            path.resolve('./fixtures/photo.png'),
            'image',
            expect.objectContaining({ accountId: 'default' })
        );
        expect(result).toEqual(
            expect.objectContaining({
                channel: 'dingtalk',
                messageId: 'media_1',
            })
        );
    });

    it('uses explicit mediaType without auto-detection', async () => {
        sendProactiveMediaMock.mockResolvedValueOnce({
            ok: true,
            data: { messageId: 'manual_1' },
            messageId: 'manual_1',
        });

        await dingtalkPlugin.outbound.sendMedia({
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'user_123',
            mediaPath: '/tmp/voice.wav',
            mediaType: 'voice',
            accountId: 'default',
        });

        expect(detectMediaTypeFromExtensionMock).not.toHaveBeenCalled();
        expect(sendProactiveMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'user_123',
            '/tmp/voice.wav',
            'voice',
            expect.any(Object)
        );
    });

    it('downloads remote mediaUrl before upload when input is an HTTP URL', async () => {
        prepareMediaInputMock.mockResolvedValueOnce({
            path: '/tmp/dingtalk_123.png',
            cleanup: vi.fn(),
        });
        detectMediaTypeFromExtensionMock.mockReturnValueOnce('image');
        sendProactiveMediaMock.mockResolvedValueOnce({
            ok: true,
            data: { processQueryKey: 'remote_1' },
            messageId: 'remote_1',
        });

        await dingtalkPlugin.outbound.sendMedia({
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'cidA1B2C3',
            mediaUrl: 'https://example.com/photo.png',
            accountId: 'default',
        });

        expect(prepareMediaInputMock).toHaveBeenCalledWith(
            'https://example.com/photo.png',
            undefined,
            undefined
        );
        expect(sendProactiveMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'cidA1B2C3',
            '/tmp/dingtalk_123.png',
            'image',
            expect.objectContaining({ accountId: 'default' })
        );
    });

    it('forces voice template when asVoice=true', async () => {
        sendProactiveMediaMock.mockResolvedValueOnce({
            ok: true,
            data: { messageId: 'voice_1' },
            messageId: 'voice_1',
        });

        await dingtalkPlugin.outbound.sendMedia({
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'user_123',
            mediaPath: '/tmp/audio.mp4',
            asVoice: true,
            accountId: 'default',
        });

        expect(sendProactiveMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'user_123',
            '/tmp/audio.mp4',
            'voice',
            expect.any(Object)
        );
    });

    it('throws when DingTalk send returns known error code', async () => {
        detectMediaTypeFromExtensionMock.mockReturnValueOnce('file');
        sendProactiveMediaMock.mockResolvedValueOnce({ ok: false, error: 'DingTalk API error 300001' });

        await expect(
            dingtalkPlugin.outbound.sendMedia({
                cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
                to: 'cidA1B2C3',
                mediaPath: '/tmp/doc.pdf',
                accountId: 'default',
            })
        ).rejects.toThrow(/300001/);
    });

    it('throws download-stage error and does not call proactive send', async () => {
        const err = new Error('remote media URL points to private or local network host');
        (err as any).code = 'ERR_MEDIA_PRIVATE_HOST';
        prepareMediaInputMock.mockRejectedValueOnce(err);

        await expect(
            dingtalkPlugin.outbound.sendMedia({
                cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
                to: 'cidA1B2C3',
                mediaUrl: 'http://127.0.0.1/photo.png',
                accountId: 'default',
            })
        ).rejects.toThrow(/remote media preparation failed: \[ERR_MEDIA_PRIVATE_HOST\]/);

        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
    });

    it('passes mediaUrlAllowlist from account config to media preparation', async () => {
        prepareMediaInputMock.mockResolvedValueOnce({ path: '/tmp/dingtalk_123.png', cleanup: vi.fn() });
        detectMediaTypeFromExtensionMock.mockReturnValueOnce('image');
        sendProactiveMediaMock.mockResolvedValueOnce({ ok: true, messageId: 'm_1' });

        await dingtalkPlugin.outbound.sendMedia({
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
            mediaUrl: 'http://192.168.1.23/photo.png',
            accountId: 'default',
        });

        expect(prepareMediaInputMock).toHaveBeenCalledWith(
            'http://192.168.1.23/photo.png',
            undefined,
            ['192.168.1.23', 'cdn.example.com']
        );
    });
});
