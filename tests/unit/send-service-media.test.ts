import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth', () => ({
    getAccessToken: vi.fn().mockResolvedValue('token_abc'),
}));

vi.mock('../../src/media-utils', () => ({
    uploadMedia: vi.fn(),
    detectMediaTypeFromExtension: vi.fn(),
}));

vi.mock('axios', () => {
    const mockAxios = vi.fn();
    return {
        default: mockAxios,
        isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
    };
});

import { sendBySession, sendProactiveMedia } from '../../src/send-service';
import { uploadMedia as uploadMediaUtil } from '../../src/media-utils';

const mockedAxios = vi.mocked(axios);
const mockedUploadMedia = vi.mocked(uploadMediaUtil);

describe('send-service media branches', () => {
    beforeEach(() => {
        mockedAxios.mockReset();
        mockedUploadMedia.mockReset();
    });

    it('sendBySession uses native image body when upload succeeds', async () => {
        mockedUploadMedia.mockResolvedValueOnce('media_img_1');
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
        expect(req.data).toEqual({ msgtype: 'text', text: { content: 'fallback text' } });
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

    it('sendProactiveMedia maps voice payload to sampleAudio template', async () => {
        mockedUploadMedia.mockResolvedValueOnce('media_voice_1');
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_voice' } } as any);

        const result = await sendProactiveMedia(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'user_123',
            '/tmp/a.amr',
            'voice'
        );

        const req = mockedAxios.mock.calls[0]?.[0] as any;
        expect(req.data.msgKey).toBe('sampleAudio');
        expect(JSON.parse(req.data.msgParam)).toEqual({ mediaId: 'media_voice_1', duration: '0' });
        expect(result.ok).toBe(true);
    });
});
