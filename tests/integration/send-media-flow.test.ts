import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveOutboundMediaTypeMock, prepareMediaInputMock, sendProactiveMediaMock } = vi.hoisted(() => ({
    resolveOutboundMediaTypeMock: vi.fn(),
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
    sendMessage: vi.fn(),
    sendProactiveMedia: sendProactiveMediaMock,
    sendBySession: vi.fn(),
    uploadMedia: vi.fn(),
}));

vi.mock('../../src/media-utils', async () => ({
    prepareMediaInput: prepareMediaInputMock,
    resolveOutboundMediaType: resolveOutboundMediaTypeMock,
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
        resolveOutboundMediaTypeMock.mockReset();
        prepareMediaInputMock.mockReset();
        sendProactiveMediaMock.mockReset();
        prepareMediaInputMock.mockImplementation(async (input: string) => ({ path: input }));
    });

    it('auto-detects mediaType and sends with resolved absolute path', async () => {
        const sendMedia = requireSendMedia();
        resolveOutboundMediaTypeMock.mockReturnValueOnce('image');
        sendProactiveMediaMock.mockResolvedValueOnce({
            ok: true,
            data: { processQueryKey: 'media_1' },
            messageId: 'media_1',
        });

        const request = {
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'cidA1B2C3',
            text: '',
            mediaPath: './fixtures/photo.png',
            accountId: 'default',
        };
        const result = await sendMedia(request);

        expect(resolveOutboundMediaTypeMock).toHaveBeenCalledWith({
            mediaType: undefined,
            mediaPath: path.resolve('./fixtures/photo.png'),
            asVoice: false,
        });
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
        const sendMedia = requireSendMedia();
        resolveOutboundMediaTypeMock.mockReturnValueOnce('voice');
        sendProactiveMediaMock.mockResolvedValueOnce({
            ok: true,
            data: { messageId: 'manual_1' },
            messageId: 'manual_1',
        });

        const request = {
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'user_123',
            text: '',
            mediaPath: '/tmp/voice.wav',
            mediaType: 'voice',
            accountId: 'default',
        };
        await sendMedia(request);

        expect(resolveOutboundMediaTypeMock).toHaveBeenCalledWith({
            mediaType: 'voice',
            mediaPath: '/tmp/voice.wav',
            asVoice: false,
        });
        expect(sendProactiveMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'user_123',
            '/tmp/voice.wav',
            'voice',
            expect.any(Object)
        );
    });

    it('downloads remote mediaUrl before upload when input is an HTTP URL', async () => {
        const sendMedia = requireSendMedia();
        prepareMediaInputMock.mockResolvedValueOnce({
            path: '/tmp/dingtalk_123.png',
            cleanup: vi.fn(),
        });
        resolveOutboundMediaTypeMock.mockReturnValueOnce('image');
        sendProactiveMediaMock.mockResolvedValueOnce({
            ok: true,
            data: { processQueryKey: 'remote_1' },
            messageId: 'remote_1',
        });

        const request = {
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'cidA1B2C3',
            text: '',
            mediaUrl: 'https://example.com/photo.png',
            accountId: 'default',
        };
        await sendMedia(request);

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
        const sendMedia = requireSendMedia();
        resolveOutboundMediaTypeMock.mockReturnValueOnce('voice');
        sendProactiveMediaMock.mockResolvedValueOnce({
            ok: true,
            data: { messageId: 'voice_1' },
            messageId: 'voice_1',
        });

        const request = {
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'user_123',
            text: '',
            mediaPath: '/tmp/audio.mp3',
            asVoice: true,
            accountId: 'default',
        };
        await sendMedia(request);

        expect(sendProactiveMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'user_123',
            '/tmp/audio.mp3',
            'voice',
            expect.any(Object)
        );
    });

    it('fails before proactive send when asVoice media is not audio', async () => {
        const sendMedia = requireSendMedia();
        resolveOutboundMediaTypeMock.mockImplementationOnce(() => {
            throw new Error('asVoice requires an audio file (mp3, amr, wav).');
        });

        const request = {
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'user_123',
            text: '',
            mediaPath: '/tmp/not-audio.pdf',
            asVoice: true,
            accountId: 'default',
        };

        await expect(
            sendMedia(request)
        ).rejects.toThrow(/requires an audio file/i);

        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
    });

    it('throws when DingTalk send returns known error code', async () => {
        const sendMedia = requireSendMedia();
        resolveOutboundMediaTypeMock.mockReturnValueOnce('file');
        sendProactiveMediaMock.mockResolvedValueOnce({ ok: false, error: 'DingTalk API error 300001' });

        const request = {
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'cidA1B2C3',
            text: '',
            mediaPath: '/tmp/doc.pdf',
            accountId: 'default',
        };

        await expect(
            sendMedia(request)
        ).rejects.toThrow(/300001/);
    });

    it('throws download-stage error and does not call proactive send', async () => {
        const sendMedia = requireSendMedia();
        const err = Object.assign(new Error('remote media URL points to private or local network host'), {
            code: 'ERR_MEDIA_PRIVATE_HOST',
        });
        prepareMediaInputMock.mockRejectedValueOnce(err);

        const request = {
            cfg: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            to: 'cidA1B2C3',
            text: '',
            mediaUrl: 'http://127.0.0.1/photo.png',
            accountId: 'default',
        };

        await expect(
            sendMedia(request)
        ).rejects.toThrow(/remote media preparation failed: \[ERR_MEDIA_PRIVATE_HOST\]/);

        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
    });

    it('passes mediaUrlAllowlist from account config to media preparation', async () => {
        const sendMedia = requireSendMedia();
        prepareMediaInputMock.mockResolvedValueOnce({ path: '/tmp/dingtalk_123.png', cleanup: vi.fn() });
        resolveOutboundMediaTypeMock.mockReturnValueOnce('image');
        sendProactiveMediaMock.mockResolvedValueOnce({ ok: true, messageId: 'm_1' });

        const request = {
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
        };
        await sendMedia(request);

        expect(prepareMediaInputMock).toHaveBeenCalledWith(
            'http://192.168.1.23/photo.png',
            undefined,
            ['192.168.1.23', 'cdn.example.com']
        );
    });
});
