import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../src/auth', () => ({
    getAccessToken: vi.fn().mockResolvedValue('token_abc'),
}));

vi.mock('axios', () => {
    const mockAxios = vi.fn();
    return {
        default: mockAxios,
        isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
    };
});

import { prepareMediaInput, resolveOutboundMediaType, uploadMedia as uploadMediaUtil } from '../../src/media-utils';

const mockedAxios = vi.mocked(axios);
const mockedUploadMedia = vi.mocked(uploadMediaUtil);
const mockedPrepareMediaInput = vi.mocked(prepareMediaInput);
const mockedResolveOutboundMediaType = vi.mocked(resolveOutboundMediaType);

describe('sendMedia owner-only fallback when conversationId is undefined', () => {
    beforeEach(() => {
        mockedAxios.mockReset();
        (mockedAxios as any).isAxiosError = (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError);
        mockedUploadMedia.mockReset();
        mockedPrepareMediaInput.mockReset();
        mockedResolveOutboundMediaType.mockReset();
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

    it('uses owner-only lookup when conversationId is undefined and expectedCardOwnerId is provided', async () => {
        const sendMedia = (await import('../../src/send-service')).sendMedia;
        const appendImageBlock = vi.fn().mockResolvedValue(undefined);
        mockedPrepareMediaInput.mockResolvedValueOnce({
            path: '/tmp/card-image-owner-only.png',
            cleanup: vi.fn(),
        });
        mockedUploadMedia.mockResolvedValueOnce({ mediaId: '@media_owner_only', buffer: Buffer.from('img') });

        // Simulate sessionKey=- scenario: conversationId is undefined
        cardRunRegistryMocks.resolveCardRunByOwnerMock.mockReturnValueOnce({
            outTrackId: 'track_owner_only_1',
            ownerUserId: 'manager8031',
            controller: { appendImageBlock },
        } as any);

        const result = await sendMedia(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'manager8031',
            './artifacts/demo.png',
            {
                accountId: 'default',
                conversationId: undefined, // sessionKey=- causes this to be undefined
                expectedCardOwnerId: 'manager8031',
            } as any,
        );

        // Should NOT call resolveCardRunByConversation because conversationId is undefined
        expect(cardRunRegistryMocks.resolveCardRunByConversationMock).not.toHaveBeenCalled();
        // Should call resolveCardRunByOwner as fallback
        expect(cardRunRegistryMocks.resolveCardRunByOwnerMock).toHaveBeenCalledWith('default', 'manager8031');
        expect(appendImageBlock).toHaveBeenCalledWith('@media_owner_only');
        expect(mockedAxios).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, mediaId: '@media_owner_only' });
    });

    it('falls back to proactive media when conversationId is undefined and no owner match', async () => {
        const sendMedia = (await import('../../src/send-service')).sendMedia;
        mockedPrepareMediaInput.mockResolvedValueOnce({
            path: '/tmp/card-image-no-match.png',
            cleanup: vi.fn(),
        });
        // First upload for card check, second upload for proactive send
        mockedUploadMedia
            .mockResolvedValueOnce({ mediaId: '@media_no_match', buffer: Buffer.from('img') })
            .mockResolvedValueOnce({ mediaId: '@media_no_match_2', buffer: Buffer.from('img') });

        // Mock proactive media API call
        mockedAxios.mockResolvedValueOnce({
            data: { processQueryKey: 'q_no_match' },
            status: 200,
        } as any);

        // No active card found by owner
        cardRunRegistryMocks.resolveCardRunByOwnerMock.mockReturnValueOnce(null);

        const result = await sendMedia(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'manager8031',
            './artifacts/demo.png',
            {
                accountId: 'default',
                conversationId: undefined,
                expectedCardOwnerId: 'manager8031',
            } as any,
        );

        expect(cardRunRegistryMocks.resolveCardRunByConversationMock).not.toHaveBeenCalled();
        expect(cardRunRegistryMocks.resolveCardRunByOwnerMock).toHaveBeenCalledWith('default', 'manager8031');
        expect(mockedAxios).toHaveBeenCalled(); // Proactive media fallback
        expect(result.ok).toBe(true);
    });

    it('skips owner-only lookup when conversationId is undefined but no expectedCardOwnerId', async () => {
        const sendMedia = (await import('../../src/send-service')).sendMedia;
        mockedPrepareMediaInput.mockResolvedValueOnce({
            path: '/tmp/card-image-no-owner.png',
            cleanup: vi.fn(),
        });
        // First upload for card check, second upload for proactive send
        mockedUploadMedia
            .mockResolvedValueOnce({ mediaId: '@media_no_owner', buffer: Buffer.from('img') })
            .mockResolvedValueOnce({ mediaId: '@media_no_owner_2', buffer: Buffer.from('img') });

        // Mock proactive media API call
        mockedAxios.mockResolvedValueOnce({
            data: { processQueryKey: 'q_no_owner' },
            status: 200,
        } as any);

        const result = await sendMedia(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'manager8031',
            './artifacts/demo.png',
            {
                accountId: 'default',
                conversationId: undefined,
                // No expectedCardOwnerId provided
            } as any,
        );

        expect(cardRunRegistryMocks.resolveCardRunByConversationMock).not.toHaveBeenCalled();
        expect(cardRunRegistryMocks.resolveCardRunByOwnerMock).not.toHaveBeenCalled();
        expect(mockedAxios).toHaveBeenCalled(); // Direct proactive media fallback
        expect(result.ok).toBe(true);
    });
});
