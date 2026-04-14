import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth', () => ({
    getAccessToken: vi.fn().mockResolvedValue('token_abc'),
}));

const messageContextMocks = vi.hoisted(() => ({
    upsertOutboundMessageContextMock: vi.fn(),
}));

const cardRunRegistryMocks = vi.hoisted(() => ({
    resolveCardRunByConversationMock: vi.fn(),
    resolveCardRunByOwnerMock: vi.fn(),
}));

vi.mock('../../src/message-context-store', async () => {
    const actual = await vi.importActual<typeof import('../../src/message-context-store')>('../../src/message-context-store');
    return {
        ...actual,
        upsertOutboundMessageContext: messageContextMocks.upsertOutboundMessageContextMock,
    };
});

vi.mock('../../src/card/card-run-registry', () => ({
    resolveCardRunByConversation: cardRunRegistryMocks.resolveCardRunByConversationMock,
    resolveCardRunByOwner: cardRunRegistryMocks.resolveCardRunByOwnerMock,
}));

vi.mock('../../src/media-utils', () => ({
    uploadMedia: vi.fn(),
    detectMediaTypeFromExtension: vi.fn(),
    getVoiceDurationMs: vi.fn(),
    prepareMediaInput: vi.fn(),
    resolveOutboundMediaType: vi.fn(),
}));

vi.mock('axios', () => {
    const mockAxios = vi.fn();
    return {
        default: mockAxios,
        isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
    };
});

import { sendBySession, sendMessage, sendProactiveMedia } from '../../src/send-service';
import { getVoiceDurationMs, prepareMediaInput, resolveOutboundMediaType, uploadMedia as uploadMediaUtil } from '../../src/media-utils';

const mockedAxios = vi.mocked(axios);
const mockedUploadMedia = vi.mocked(uploadMediaUtil);
const mockedGetVoiceDurationMs = vi.mocked(getVoiceDurationMs);
const mockedPrepareMediaInput = vi.mocked(prepareMediaInput);
const mockedResolveOutboundMediaType = vi.mocked(resolveOutboundMediaType);

describe('send-service media branches', () => {
    beforeEach(() => {
        mockedAxios.mockReset();
        (mockedAxios as any).isAxiosError = (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError);
        mockedUploadMedia.mockReset();
        mockedGetVoiceDurationMs.mockReset();
        mockedPrepareMediaInput.mockReset();
        mockedResolveOutboundMediaType.mockReset();
        mockedGetVoiceDurationMs.mockResolvedValue(1000);
        mockedPrepareMediaInput.mockImplementation(async (input: string) => ({ path: input }));
        mockedResolveOutboundMediaType.mockImplementation(({ mediaType, mediaPath }: { mediaType?: string | null; mediaPath: string }) => {
            if (mediaType) {
                return mediaType as any;
            }
            return mediaPath.endsWith('.png') ? 'image' : 'file';
        });
        cardRunRegistryMocks.resolveCardRunByConversationMock.mockReset().mockReturnValue(null);
        cardRunRegistryMocks.resolveCardRunByOwnerMock.mockReset().mockReturnValue(null);
        messageContextMocks.upsertOutboundMessageContextMock.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sendMedia reroutes markdown mode media to proactive media delivery', async () => {
        const sendMedia = (await import('../../src/send-service')).sendMedia;
        mockedPrepareMediaInput.mockResolvedValueOnce({
            path: '/tmp/dingtalk_remote.png',
            cleanup: vi.fn(),
        });
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_img_unified', buffer: Buffer.from('img') });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_unified_image' } } as any);

        const result = await sendMedia(
            { clientId: 'id', clientSecret: 'sec', messageType: 'markdown' } as any,
            'cidA1B2C3',
            'https://example.com/photo.png',
            { accountId: 'default' } as any,
        );

        expect(mockedPrepareMediaInput).toHaveBeenCalledWith(
            'https://example.com/photo.png',
            undefined,
            undefined,
        );
        expect(mockedUploadMedia).toHaveBeenCalledWith(
            expect.objectContaining({
                clientId: 'id',
                clientSecret: 'sec',
                messageType: 'markdown',
            }),
            '/tmp/dingtalk_remote.png',
            'image',
            expect.any(Function),
            undefined,
            expect.objectContaining({ mediaLocalRoots: undefined }),
        );
        expect(result).toMatchObject({ ok: true, messageId: 'q_unified_image' });
    });

    it('sendMedia embeds card images into active card instead of proactive send', async () => {
        const sendMedia = (await import('../../src/send-service')).sendMedia;
        const appendImageBlock = vi.fn().mockResolvedValue(undefined);
        mockedPrepareMediaInput.mockResolvedValueOnce({
            path: '/tmp/card-image.png',
            cleanup: vi.fn(),
        });
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: '@media_card_embed', buffer: Buffer.from('img') });
        cardRunRegistryMocks.resolveCardRunByConversationMock.mockReturnValue({
            outTrackId: 'track_1',
            ownerUserId: 'manager0831',
            controller: { appendImageBlock },
        });

        const result = await sendMedia(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'cidA1B2C3',
            './artifacts/demo.png',
            {
                accountId: 'default',
                conversationId: 'cidA1B2C3', // Explicitly provide conversationId
                expectedCardOwnerId: 'manager0831',
            } as any,
        );

        expect(cardRunRegistryMocks.resolveCardRunByConversationMock).toHaveBeenCalledWith(
            'default',
            'cidA1B2C3',
            { ownerUserId: 'manager0831' },
        );
        expect(appendImageBlock).toHaveBeenCalledWith('@media_card_embed');
        expect(mockedAxios).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, mediaId: '@media_card_embed' });
    });

    it('sendMedia still resolves active card by conversationId when expectedCardOwnerId is omitted', async () => {
        const sendMedia = (await import('../../src/send-service')).sendMedia;
        const appendImageBlock = vi.fn().mockResolvedValue(undefined);
        mockedPrepareMediaInput.mockResolvedValueOnce({
            path: '/tmp/card-image-no-owner.png',
            cleanup: vi.fn(),
        });
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: '@media_card_embed_no_owner', buffer: Buffer.from('img') });
        cardRunRegistryMocks.resolveCardRunByConversationMock.mockReturnValue({
            outTrackId: 'track_no_owner_1',
            ownerUserId: 'manager8031',
            controller: { appendImageBlock },
        });

        const result = await sendMedia(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'manager8031',
            './artifacts/demo.png',
            {
                accountId: 'default',
                conversationId: 'manager8031',
            } as any,
        );

        expect(cardRunRegistryMocks.resolveCardRunByConversationMock).toHaveBeenCalledWith(
            'default',
            'manager8031',
            undefined,
        );
        expect(appendImageBlock).toHaveBeenCalledWith('@media_card_embed_no_owner');
        expect(mockedAxios).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, mediaId: '@media_card_embed_no_owner' });
    });

    it('sendMedia falls back to conversation-only lookup when owner-filtered lookup misses active card', async () => {
        const sendMedia = (await import('../../src/send-service')).sendMedia;
        const appendImageBlock = vi.fn().mockResolvedValue(undefined);
        mockedPrepareMediaInput.mockResolvedValueOnce({
            path: '/tmp/card-image-owner-fallback.png',
            cleanup: vi.fn(),
        });
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: '@media_card_owner_fallback', buffer: Buffer.from('img') });
        cardRunRegistryMocks.resolveCardRunByConversationMock
            .mockReturnValueOnce(null)
            .mockReturnValueOnce({
                outTrackId: 'track_owner_fallback_1',
                ownerUserId: 'manager8031',
                controller: { appendImageBlock },
            });

        const result = await sendMedia(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'manager8031',
            './artifacts/demo.png',
            {
                accountId: 'default',
                conversationId: 'manager8031',
                expectedCardOwnerId: 'manager0831',
            } as any,
        );

        expect(cardRunRegistryMocks.resolveCardRunByConversationMock).toHaveBeenNthCalledWith(
            1,
            'default',
            'manager8031',
            { ownerUserId: 'manager0831' },
        );
        expect(cardRunRegistryMocks.resolveCardRunByConversationMock).toHaveBeenNthCalledWith(
            2,
            'default',
            'manager8031',
            undefined,
        );
        expect(appendImageBlock).toHaveBeenCalledWith('@media_card_owner_fallback');
        expect(mockedAxios).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, mediaId: '@media_card_owner_fallback' });
    });

    it('waits briefly for card controller attachment before falling back to proactive media', async () => {
        vi.useFakeTimers();
        const sendMedia = (await import('../../src/send-service')).sendMedia;
        const appendImageBlock = vi.fn().mockResolvedValue(undefined);
        const activeRun = {
            outTrackId: 'track_race_1',
            ownerUserId: 'manager8031',
            controller: undefined as { appendImageBlock: (mediaId: string) => Promise<void> } | undefined,
        };

        mockedPrepareMediaInput.mockResolvedValueOnce({
            path: '/tmp/card-race.png',
            cleanup: vi.fn(),
        });
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: '@media_card_race', buffer: Buffer.from('img') });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_race_fallback' } } as any);
        cardRunRegistryMocks.resolveCardRunByConversationMock.mockImplementation(() => activeRun);

        setTimeout(() => {
            activeRun.controller = { appendImageBlock };
        }, 10);

        const resultPromise = sendMedia(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'manager8031',
            './artifacts/demo.png',
            {
                accountId: 'default',
                conversationId: 'manager8031',
                expectedCardOwnerId: 'manager8031',
            } as any,
        );

        await vi.advanceTimersByTimeAsync(50);

        const result = await resultPromise;
        expect(appendImageBlock).toHaveBeenCalledWith('@media_card_race');
        expect(mockedAxios).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, mediaId: '@media_card_race' });
    });

    it('sendMedia resolves active card by conversationId instead of target when they differ', async () => {
        const sendMedia = (await import('../../src/send-service')).sendMedia;
        const appendImageBlock = vi.fn().mockResolvedValue(undefined);
        mockedPrepareMediaInput.mockResolvedValueOnce({
            path: '/tmp/card-image.png',
            cleanup: vi.fn(),
        });
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: '@media_card_embed_ctx', buffer: Buffer.from('img') });
        cardRunRegistryMocks.resolveCardRunByConversationMock.mockReturnValue({
            outTrackId: 'track_ctx_1',
            ownerUserId: 'manager0831',
            controller: { appendImageBlock },
        });

        const result = await sendMedia(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'manager8031',
            './artifacts/demo.png',
            {
                accountId: 'default',
                conversationId: 'cidA1B2C3',
                expectedCardOwnerId: 'manager0831',
            } as any,
        );

        expect(cardRunRegistryMocks.resolveCardRunByConversationMock).toHaveBeenCalledWith(
            'default',
            'cidA1B2C3',
            { ownerUserId: 'manager0831' },
        );
        expect(appendImageBlock).toHaveBeenCalledWith('@media_card_embed_ctx');
        expect(mockedAxios).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, mediaId: '@media_card_embed_ctx' });
    });

    it('sendBySession uses native image body when upload succeeds', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_img_1', buffer: Buffer.from('img') });
        mockedAxios.mockResolvedValueOnce({ data: { ok: true } } as any);

        await sendBySession(
            { clientId: 'id', clientSecret: 'sec' } as any,
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
            { clientId: 'id', clientSecret: 'sec' } as any,
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
            { clientId: 'id', clientSecret: 'sec' } as any,
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
            { clientId: 'id', clientSecret: 'sec', bypassProxyForSend: true } as any,
            'https://session.webhook',
            'ignored text',
            { mediaPath: '/tmp/a.png', mediaType: 'image' }
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.proxy).toBe(false);
    });

    it('sendBySession throws when media session webhook returns business failure payload', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_voice_fail', buffer: Buffer.from('data') });
        mockedAxios.mockResolvedValueOnce({
            data: { success: false, code: 'invalidParameter.media', message: 'media rejected' },
        } as any);

        await expect(
            sendBySession(
                { clientId: 'id', clientSecret: 'sec' } as any,
                'https://session.webhook',
                'ignored text',
                { mediaPath: '/tmp/a.amr', mediaType: 'voice' }
            )
        ).rejects.toThrow(/media rejected/i);
    });

    it('sendMessage routes session voice replies through proactive media API instead of sendBySession webhook', async () => {
        mockedUploadMedia.mockResolvedValueOnce({
            mediaId: 'media_voice_session_reply',
            buffer: Buffer.from('data'),
            durationMs: 1000,
        });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_voice_session_reply' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec' } as any,
            'user_123',
            'ignored text',
            {
                sessionWebhook: 'https://session.webhook',
                mediaPath: '/tmp/a.amr',
                mediaType: 'voice',
                accountId: 'main',
                storePath: '/tmp/sessions.json',
            } as any,
        );

        expect(result).toEqual({
            ok: true,
            data: { processQueryKey: 'q_voice_session_reply' },
            messageId: 'q_voice_session_reply',
        });
        expect(mockedAxios).toHaveBeenCalledTimes(1);
        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.url).toContain('/v1.0/robot/oToMessages/batchSend');
        expect(req.url).not.toBe('https://session.webhook');
        expect(messageContextMocks.upsertOutboundMessageContextMock).toHaveBeenCalledWith(
            expect.objectContaining({
                messageType: 'outbound-proactive-media',
                delivery: expect.objectContaining({
                    processQueryKey: 'q_voice_session_reply',
                    kind: 'proactive-media',
                }),
            }),
        );
    });

    it('sendProactiveMedia returns upload failure when media upload fails', async () => {
        mockedUploadMedia.mockResolvedValueOnce(null);

        const result = await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
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
            { clientId: 'id', clientSecret: 'sec' } as any,
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
            { clientId: 'id', clientSecret: 'sec' } as any,
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
        mockedUploadMedia.mockResolvedValueOnce({
            mediaId: 'media_voice_1',
            buffer: Buffer.from('data'),
            durationMs: 1000,
        });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_voice' } } as any);

        const result = await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            'user_123',
            '/tmp/a.amr',
            'voice'
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.data.msgKey).toBe('sampleAudio');
        expect(JSON.parse(req.data.msgParam)).toEqual({ mediaId: 'media_voice_1', duration: '1000' });
        expect(mockedGetVoiceDurationMs).not.toHaveBeenCalled();
        expect(result.ok).toBe(true);
    });

    it('sendProactiveMedia uses upload-time duration without requiring an uploaded temp path', async () => {
        mockedUploadMedia.mockResolvedValueOnce({
            mediaId: 'media_voice_transcoded',
            buffer: Buffer.from('ogg-data'),
            durationMs: 7700,
        });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_voice_transcoded' } } as any);

        await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            'user_123',
            '/tmp/original.wav',
            'voice'
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(JSON.parse(req.data.msgParam)).toEqual({ mediaId: 'media_voice_transcoded', duration: '7700' });
        expect(mockedGetVoiceDurationMs).not.toHaveBeenCalled();
    });

    it('sendBySession voice media uses upload-time duration without requiring an uploaded temp path', async () => {
        mockedUploadMedia.mockResolvedValueOnce({
            mediaId: 'media_voice_session_duration',
            buffer: Buffer.from('ogg-data'),
            durationMs: 6400,
        });
        mockedAxios.mockResolvedValueOnce({
            data: { success: true, result: true, messageId: 'session_voice_1' },
        } as any);

        await sendBySession(
            { clientId: 'id', clientSecret: 'sec' } as any,
            'https://session.webhook',
            'ignored text',
            { mediaPath: '/tmp/original.wav', mediaType: 'voice' }
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.data).toEqual({
            msgtype: 'voice',
            voice: { media_id: 'media_voice_session_duration', duration: '6400' },
        });
        expect(mockedGetVoiceDurationMs).not.toHaveBeenCalled();
    });

    it('delegates proactive media journaling when storePath is provided', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_voice_2', buffer: Buffer.from('data') });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_voice_2' } } as any);

        await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
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

    it('forces template text fallback when proactive user media fails in card mode', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_file_card_fallback', buffer: Buffer.from('data') });
        mockedAxios
            .mockRejectedValueOnce({
                message: 'upload send failed',
                response: { status: 500, statusText: 'Server Error', data: { code: 'system.err' } },
                isAxiosError: true,
            })
            .mockResolvedValueOnce({ data: { processQueryKey: 'fallback_card_q_1' } } as any);

        const result = await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'user_123',
            '/tmp/a.pdf',
            'file',
            {
                accountId: 'main',
                storePath: '/tmp/sessions.json',
            } as any,
        );

        expect(result.ok).toBe(true);
        expect(mockedAxios).toHaveBeenCalledTimes(2);
        const fallbackReq = mockedAxios.mock.calls[1]?.[0] as any;
        expect(fallbackReq.url).toContain('/v1.0/robot/oToMessages/batchSend');
        expect(fallbackReq.data.msgKey).toBe('sampleText');
        expect(JSON.parse(fallbackReq.data.msgParam)).toEqual({
            content: '📎 媒体发送失败，兜底链接/路径：/tmp/a.pdf',
        });
    });

    it('sendProactiveMedia bypasses proxy when configured', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_voice_proxy', buffer: Buffer.from('data') });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_proxy' } } as any);

        await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec', bypassProxyForSend: true } as any,
            'user_123',
            '/tmp/a.amr',
            'voice'
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.proxy).toBe(false);
    });
    it('sendBySession warns when media session webhook response has no delivery metadata', async () => {
        const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_voice_warn', buffer: Buffer.from('data') });
        mockedAxios.mockResolvedValueOnce({
            data: { success: true, result: true },
        } as any);

        await sendBySession(
            { clientId: 'id', clientSecret: 'sec' } as any,
            'https://session.webhook',
            'ignored text',
            { mediaPath: '/tmp/a.amr', mediaType: 'voice', log: log as any }
        );

        expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining('response missing delivery metadata')
        );
    });

    it('sendMessage routes session voice replies through proactive media API instead of sendBySession webhook', async () => {
        mockedUploadMedia.mockResolvedValueOnce({
            mediaId: 'media_voice_proactive',
            buffer: Buffer.from('data'),
            durationMs: 1000,
        });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_voice_session_reply' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec' } as any,
            'cidA1B2C3',
            '',
            {
                sessionWebhook: 'https://session.webhook',
                mediaPath: '/tmp/a.amr',
                mediaType: 'voice',
                accountId: 'main',
                storePath: '/tmp/sessions.json',
            } as any,
        );

        expect(result).toEqual({
            ok: true,
            data: { processQueryKey: 'q_voice_session_reply' },
            messageId: 'q_voice_session_reply',
        });
        expect(mockedAxios).toHaveBeenCalledTimes(1);
        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.url).toContain('/v1.0/robot/groupMessages/send');
        expect(req.url).not.toBe('https://session.webhook');
        expect(messageContextMocks.upsertOutboundMessageContextMock).toHaveBeenCalledWith(
            expect.objectContaining({
                messageType: 'outbound-proactive-media',
                delivery: expect.objectContaining({
                    processQueryKey: 'q_voice_session_reply',
                    kind: 'proactive-media',
                }),
            }),
        );
    });

    it('sendProactiveMedia returns upload failure when media upload fails', async () => {
        mockedUploadMedia.mockResolvedValueOnce(null);

        const result = await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
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
            { clientId: 'id', clientSecret: 'sec' } as any,
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
            { clientId: 'id', clientSecret: 'sec' } as any,
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
        mockedUploadMedia.mockResolvedValueOnce({
            mediaId: 'media_voice_1',
            buffer: Buffer.from('data'),
            durationMs: 1000,
        });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_voice' } } as any);

        const result = await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            'user_123',
            '/tmp/a.amr',
            'voice'
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.data.msgKey).toBe('sampleAudio');
        expect(JSON.parse(req.data.msgParam)).toEqual({ mediaId: 'media_voice_1', duration: '1000' });
        expect(mockedGetVoiceDurationMs).not.toHaveBeenCalled();
        expect(result.ok).toBe(true);
    });

    it('sendProactiveMedia uses upload-time duration without requiring an uploaded temp path', async () => {
        mockedUploadMedia.mockResolvedValueOnce({
            mediaId: 'media_voice_transcoded',
            buffer: Buffer.from('ogg-data'),
            durationMs: 7700,
        });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_voice_transcoded' } } as any);

        await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            'user_123',
            '/tmp/original.wav',
            'voice'
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(JSON.parse(req.data.msgParam)).toEqual({ mediaId: 'media_voice_transcoded', duration: '7700' });
        expect(mockedGetVoiceDurationMs).not.toHaveBeenCalled();
    });

    it('sendBySession voice media uses upload-time duration without requiring an uploaded temp path', async () => {
        mockedUploadMedia.mockResolvedValueOnce({
            mediaId: 'media_voice_session_duration',
            buffer: Buffer.from('ogg-data'),
            durationMs: 6400,
        });
        mockedAxios.mockResolvedValueOnce({
            data: { success: true, result: true, messageId: 'session_voice_1' },
        } as any);

        await sendBySession(
            { clientId: 'id', clientSecret: 'sec' } as any,
            'https://session.webhook',
            'ignored text',
            { mediaPath: '/tmp/original.wav', mediaType: 'voice' }
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.data).toEqual({
            msgtype: 'voice',
            voice: { media_id: 'media_voice_session_duration', duration: '6400' },
        });
        expect(mockedGetVoiceDurationMs).not.toHaveBeenCalled();
    });

    it('delegates proactive media journaling when storePath is provided', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_voice_2', buffer: Buffer.from('data') });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_voice_2' } } as any);

        await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
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

    it('forces template text fallback when proactive user media fails in card mode', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_file_card_fallback', buffer: Buffer.from('data') });
        mockedAxios
            .mockRejectedValueOnce({
                message: 'upload send failed',
                response: { status: 500, statusText: 'Server Error', data: { code: 'system.err' } },
                isAxiosError: true,
            })
            .mockResolvedValueOnce({ data: { processQueryKey: 'fallback_card_q_1' } } as any);

        const result = await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'user_123',
            '/tmp/a.pdf',
            'file',
            {
                accountId: 'main',
                storePath: '/tmp/sessions.json',
            } as any,
        );

        expect(result.ok).toBe(true);
        expect(mockedAxios).toHaveBeenCalledTimes(2);
        const fallbackReq = mockedAxios.mock.calls[1]?.[0] as any;
        expect(fallbackReq.url).toContain('/v1.0/robot/oToMessages/batchSend');
        expect(fallbackReq.data.msgKey).toBe('sampleText');
        expect(JSON.parse(fallbackReq.data.msgParam)).toEqual({
            content: '📎 媒体发送失败，兜底链接/路径：/tmp/a.pdf',
        });
    });

    it('sendProactiveMedia bypasses proxy when configured', async () => {
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: 'media_voice_proxy', buffer: Buffer.from('data') });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_proxy' } } as any);

        await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec', bypassProxyForSend: true } as any,
            'user_123',
            '/tmp/a.amr',
            'voice'
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.proxy).toBe(false);
    });
});
