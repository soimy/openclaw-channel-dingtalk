import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth', () => ({
    getAccessToken: vi.fn().mockResolvedValue('token_abc'),
}));

const messageContextMocks = vi.hoisted(() => ({
    upsertOutboundMessageContextMock: vi.fn(),
}));

vi.mock('../../src/message-context-store', async () => {
    const actual = await vi.importActual<typeof import('../../src/message-context-store')>('../../src/message-context-store');
    return {
        ...actual,
        upsertOutboundMessageContext: messageContextMocks.upsertOutboundMessageContextMock,
    };
});

vi.mock('../../src/media-utils', () => ({
    uploadMedia: vi.fn(),
    detectMediaTypeFromExtension: vi.fn(),
    getVoiceDurationMs: vi.fn(),
}));

vi.mock('axios', () => {
    const mockAxios = vi.fn();
    return {
        default: mockAxios,
        isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
    };
});

import { sendBySession, sendProactiveMedia } from '../../src/send-service';
import { getVoiceDurationMs, uploadMedia as uploadMediaUtil } from '../../src/media-utils';

const mockedAxios = vi.mocked(axios);
const mockedUploadMedia = vi.mocked(uploadMediaUtil);
const mockedGetVoiceDurationMs = vi.mocked(getVoiceDurationMs);

describe('send-service media branches', () => {
    beforeEach(() => {
        mockedAxios.mockReset();
        (mockedAxios as any).isAxiosError = (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError);
        mockedUploadMedia.mockReset();
        mockedGetVoiceDurationMs.mockReset();
        mockedGetVoiceDurationMs.mockResolvedValue(1000);
        messageContextMocks.upsertOutboundMessageContextMock.mockReset();
    });

    it('sendBySession uses native image body when upload succeeds', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_img_1', buffer: Buffer.from('img') });
        mockedAxios.mockResolvedValueOnce({ data: { ok: true } } as any);

        await sendBySession(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'https://session.webhook',
            'ignored text',
            { mediaPath: '/tmp/a.png', mediaType: 'image' }
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.data).toEqual({ msgtype: 'image', image: { media_id: 'media_img_1' } });
    });

    it('forwards mediaLocalRoots when sendBySession uploads media', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_img_roots', buffer: Buffer.from('img') });
        mockedAxios.mockResolvedValueOnce({ data: { ok: true } } as any);

        await sendBySession(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'https://session.webhook',
            'ignored text',
            {
                mediaPath: '/tmp/a.png',
                mediaType: 'image',
                mediaLocalRoots: ['/sandbox/media', '/workspace/media'],
            }
        );

        expect(mockedUploadMedia).toHaveBeenCalledWith(
            expect.anything(),
            '/tmp/a.png',
            'image',
            expect.any(Function),
            undefined,
            { mediaLocalRoots: ['/sandbox/media', '/workspace/media'] },
        );
    });

    it('sendBySession falls back to plain text when media upload fails', async () => {
        mockedUploadMedia.mockResolvedValueOnce(null);
        mockedAxios.mockResolvedValueOnce({ data: { ok: true } } as any);

        await sendBySession(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'https://session.webhook',
            'fallback text',
            { mediaPath: '/tmp/a.png', mediaType: 'image', useMarkdown: false }
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.data).toEqual({
            msgtype: 'text',
            text: { content: 'fallback text\n\n📎 媒体发送失败，兜底链接/路径：/tmp/a.png' },
        });
    });

    it('sendBySession bypasses proxy when configured', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_img_proxy', buffer: Buffer.from('data') });
        mockedAxios.mockResolvedValueOnce({ data: { ok: true } } as any);

        await sendBySession(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id', bypassProxyForSend: true } as any,
            'https://session.webhook',
            'ignored text',
            { mediaPath: '/tmp/a.png', mediaType: 'image' }
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.proxy).toBe(false);
    });

    it('sendProactiveMedia returns upload failure when media upload fails', async () => {
        mockedUploadMedia.mockResolvedValueOnce(null);

        const result = await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'cidA1B2C3',
            '/tmp/a.pdf',
            'file'
        );

        expect(result).toEqual({ ok: false, error: 'Failed to upload media' });
        expect(mockedAxios).not.toHaveBeenCalled();
    });

    it('sendProactiveMedia maps image payload to sampleImageMsg template', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_img_2', buffer: Buffer.from('data') });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_image' } } as any);

        const result = await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'cidA1B2C3',
            '/tmp/a.png',
            'image'
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.data.msgKey).toBe('sampleImageMsg');
        expect(JSON.parse(req.data.msgParam)).toEqual({ photoURL: 'media_img_2' });
        expect(result.ok).toBe(true);
    });

    it('forwards mediaLocalRoots when sendProactiveMedia uploads media', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_img_roots_2', buffer: Buffer.from('data') });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_image_roots' } } as any);

        await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'cidA1B2C3',
            '/tmp/a.png',
            'image',
            { mediaLocalRoots: ['/sandbox/media'] }
        );

        expect(mockedUploadMedia).toHaveBeenCalledWith(
            expect.anything(),
            '/tmp/a.png',
            'image',
            expect.any(Function),
            undefined,
            { mediaLocalRoots: ['/sandbox/media'] },
        );
    });

    it('sendProactiveMedia maps voice payload to sampleAudio template', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_voice_1', buffer: Buffer.from('data') });
        mockedGetVoiceDurationMs.mockResolvedValueOnce(1000);
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_voice' } } as any);

        const result = await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'user_123',
            '/tmp/a.amr',
            'voice'
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.data.msgKey).toBe('sampleAudio');
        expect(JSON.parse(req.data.msgParam)).toEqual({ mediaId: 'media_voice_1', duration: '1000' });
        expect(result.ok).toBe(true);
    });

    it('delegates proactive media journaling when storePath is provided', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_voice_2', buffer: Buffer.from('data') });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_voice_2' } } as any);

        await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'user_123',
            '/tmp/a.amr',
            'voice',
            {
                accountId: 'main',
                storePath: '/tmp/sessions.json',
                quotedRef: {
                    targetDirection: 'inbound',
                    key: 'msgId',
                    value: 'msg_in_media_1',
                },
            } as any,
        );

        expect(messageContextMocks.upsertOutboundMessageContextMock).toHaveBeenCalledWith(
            expect.objectContaining({
                storePath: '/tmp/sessions.json',
                accountId: 'main',
                conversationId: 'user_123',
                createdAt: expect.any(Number),
                messageType: 'outbound-proactive-media',
                senderId: 'bot',
                senderName: 'OpenClaw',
                chatType: 'direct',
                quotedRef: {
                    targetDirection: 'inbound',
                    key: 'msgId',
                    value: 'msg_in_media_1',
                },
                delivery: expect.objectContaining({
                    processQueryKey: 'q_voice_2',
                    kind: 'proactive-media',
                }),
            }),
        );
    });

    it('persists proactive media fallback text without emoji prefix', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_file_fallback', buffer: Buffer.from('data') });
        mockedAxios
            .mockRejectedValueOnce({
                message: 'upload send failed',
                response: { status: 500, statusText: 'Server Error', data: { code: 'system.err' } },
                isAxiosError: true,
            })
            .mockResolvedValueOnce({ data: { processQueryKey: 'fallback_q_1' } } as any);

        const result = await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'user_123',
            '/tmp/a.pdf',
            'file',
            {
                accountId: 'main',
                storePath: '/tmp/sessions.json',
            } as any,
        );

        expect(result.ok).toBe(true);
        expect(messageContextMocks.upsertOutboundMessageContextMock).toHaveBeenCalledWith(
            expect.objectContaining({
                storePath: '/tmp/sessions.json',
                accountId: 'main',
                conversationId: 'user_123',
                text: '媒体发送失败，兜底链接/路径：/tmp/a.pdf',
                messageType: 'outbound-proactive-fallback',
                senderId: 'bot',
                senderName: 'OpenClaw',
                chatType: 'direct',
                delivery: expect.objectContaining({
                    processQueryKey: 'fallback_q_1',
                }),
            }),
        );
    });

    it('sendProactiveMedia bypasses proxy when configured', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_voice_proxy', buffer: Buffer.from('data') });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_proxy' } } as any);

        await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id', bypassProxyForSend: true } as any,
            'user_123',
            '/tmp/a.amr',
            'voice'
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.proxy).toBe(false);
    });
});
