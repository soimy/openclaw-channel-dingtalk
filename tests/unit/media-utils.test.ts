import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectMediaTypeFromExtension, prepareMediaInput, uploadMedia } from '../../src/media-utils';

vi.mock('axios', () => {
    const mockAxios = {
        get: vi.fn(),
        post: vi.fn(),
        isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
    };
    return {
        default: mockAxios,
        isAxiosError: mockAxios.isAxiosError,
    };
});

const mockedAxiosGet = vi.mocked((axios as any).get);
const mockedAxiosPost = vi.mocked((axios as any).post);

function createTempFile(content: Buffer): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-media-')), `f_${Date.now()}.bin`);
    fs.writeFileSync(file, content);
    return file;
}

afterEach(() => {
    mockedAxiosGet.mockReset();
    mockedAxiosPost.mockReset();
});

describe('media-utils', () => {
    it('detects media type from file extension', () => {
        expect(detectMediaTypeFromExtension('/tmp/a.jpg')).toBe('image');
        expect(detectMediaTypeFromExtension('/tmp/a.mp3')).toBe('voice');
        expect(detectMediaTypeFromExtension('/tmp/a.mp4')).toBe('video');
        expect(detectMediaTypeFromExtension('/tmp/a.pdf')).toBe('file');
    });

    it('uploads media and returns media_id on success', async () => {
        const mediaPath = createTempFile(Buffer.from('hello world'));
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_123' } } as any);

        const mediaId = await uploadMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            mediaPath,
            'file',
            vi.fn().mockResolvedValue('token_abc')
        );

        expect(mediaId).toBe('media_123');
        expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
        expect(mockedAxiosPost.mock.calls[0]?.[0]).toContain('access_token=token_abc&type=file');

        fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
    });

    it('downloads remote media to a temp file and cleans it up', async () => {
        mockedAxiosGet.mockResolvedValueOnce({
            data: Buffer.from('img'),
            headers: { 'content-type': 'image/png' },
        } as any);

        const prepared = await prepareMediaInput('https://example.com/path/photo', {
            debug: vi.fn(),
        } as any);

        expect(prepared.path).toMatch(/dingtalk_[0-9a-f-]{36}\.png$/);
        expect(fs.existsSync(prepared.path)).toBe(true);
        const requestConfig = mockedAxiosGet.mock.calls[0]?.[1] as Record<string, unknown>;
        expect(requestConfig.timeout).toBe(10000);
        expect(requestConfig.maxContentLength).toBe(20 * 1024 * 1024);

        await prepared.cleanup?.();
        expect(fs.existsSync(prepared.path)).toBe(false);
    });

    it('rejects local or private network media URLs', async () => {
        await expect(prepareMediaInput('http://127.0.0.1/internal.png')).rejects.toThrow(
            /private or local network host/
        );
        await expect(prepareMediaInput('http://localhost/internal.png')).rejects.toThrow(
            /private or local network host/
        );
        expect(mockedAxiosGet).not.toHaveBeenCalled();
    });

    it('logs warn when cleanup fails for unexpected file-system errors', async () => {
        mockedAxiosGet.mockResolvedValueOnce({
            data: Buffer.from('img'),
            headers: { 'content-type': 'image/png' },
        } as any);

        const log = { warn: vi.fn(), debug: vi.fn() } as any;
        const prepared = await prepareMediaInput('https://example.com/path/photo', log);
        const unlinkSpy = vi.spyOn(fs.promises, 'unlink').mockRejectedValueOnce({ code: 'EPERM', message: 'denied' } as any);

        await prepared.cleanup?.();

        expect(log.warn).toHaveBeenCalledTimes(1);
        unlinkSpy.mockRestore();
    });

    it('returns null when file exceeds media size limit', async () => {
        const tooLargeVoice = createTempFile(Buffer.alloc(2 * 1024 * 1024 + 10, 1));

        const mediaId = await uploadMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            tooLargeVoice,
            'voice',
            vi.fn().mockResolvedValue('token_abc')
        );

        expect(mediaId).toBeNull();
        expect(mockedAxiosPost).not.toHaveBeenCalled();

        fs.rmSync(path.dirname(tooLargeVoice), { recursive: true, force: true });
    });

    it('returns null when axios upload throws', async () => {
        const mediaPath = createTempFile(Buffer.from('hello'));
        const log = { error: vi.fn(), debug: vi.fn() };
        mockedAxiosPost.mockRejectedValueOnce({
            isAxiosError: true,
            response: { status: 400, statusText: 'Bad Request', data: { code: 'invalidParameter', message: 'file invalid' } },
            message: 'upload failed',
        });

        const mediaId = await uploadMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            mediaPath,
            'file',
            vi.fn().mockResolvedValue('token_abc'),
            log as any
        );

        expect(mediaId).toBeNull();
        expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
        const logs = log.error.mock.calls.map((args: unknown[]) => String(args[0]));
        expect(
            logs.some(
                (entry) =>
                    entry.includes('[DingTalk][ErrorPayload][media.upload]') &&
                    entry.includes('code=invalidParameter') &&
                    entry.includes('message=file invalid')
            )
        ).toBe(true);

        fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
    });
});
