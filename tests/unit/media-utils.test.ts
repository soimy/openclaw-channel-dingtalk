import * as fs from 'node:fs';
import * as dnsPromises from 'node:dns/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectMediaTypeFromExtension, getVoiceDurationMs, prepareMediaInput, uploadMedia } from '../../src/media-utils';

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

vi.mock('node:dns/promises', () => ({
    lookup: vi.fn(),
}));

const mockedAxiosGet = vi.mocked((axios as any).get);
const mockedAxiosPost = vi.mocked((axios as any).post);
const mockedDnsLookup = vi.mocked((dnsPromises as any).lookup);

function createTempFile(content: Buffer): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-media-')), `f_${Date.now()}.bin`);
    fs.writeFileSync(file, content);
    return file;
}

function createTempFileWithExt(content: Buffer, ext: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-media-'));
    const file = path.join(dir, `f_${Date.now()}${ext}`);
    fs.writeFileSync(file, content);
    return file;
}

afterEach(() => {
    mockedAxiosGet.mockReset();
    mockedAxiosPost.mockReset();
    mockedDnsLookup.mockReset();
});

beforeEach(() => {
    mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
});

describe('media-utils', () => {
    it('detects media type from file extension', () => {
        expect(detectMediaTypeFromExtension('/tmp/a.jpg')).toBe('image');
        expect(detectMediaTypeFromExtension('/tmp/a.mp3')).toBe('voice');
        expect(detectMediaTypeFromExtension('/tmp/a.mp4')).toBe('video');
        expect(detectMediaTypeFromExtension('/tmp/a.pdf')).toBe('file');
    });

    it('returns safe fallback duration for unparseable mp3', async () => {
        const mediaPath = createTempFileWithExt(Buffer.from('not-an-mp3'), '.mp3');

        const durationMs = await getVoiceDurationMs(mediaPath, 'voice');

        expect(durationMs).toBe(1000);
        fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
    });

    it('returns safe fallback duration for amr/wav voice files', async () => {
        const amrPath = createTempFileWithExt(Buffer.from('not-amr'), '.amr');

        const durationMs = await getVoiceDurationMs(amrPath, 'voice');

        expect(durationMs).toBe(1000);
        fs.rmSync(path.dirname(amrPath), { recursive: true, force: true });
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

    it('rejects hostname that resolves to private network IP when not allowlisted', async () => {
        mockedDnsLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as any);

        await expect(prepareMediaInput('https://public.example.com/path/photo.png')).rejects.toThrow(
            /resolves to private or local network address/
        );
        expect(mockedAxiosGet).not.toHaveBeenCalled();
    });

    it('allows hostname resolving to private IP when hostname is explicitly allowlisted', async () => {
        mockedDnsLookup.mockResolvedValueOnce([{ address: '192.168.1.10', family: 4 }] as any);
        mockedAxiosGet.mockResolvedValueOnce({
            data: Buffer.from('img'),
            headers: { 'content-type': 'image/png' },
        } as any);

        const prepared = await prepareMediaInput(
            'https://files.internal.example/path/photo.png',
            undefined,
            ['files.internal.example']
        );

        expect(fs.existsSync(prepared.path)).toBe(true);
        await prepared.cleanup?.();
    });

    it('allows private host when host is explicitly in mediaUrlAllowlist', async () => {
        mockedAxiosGet.mockResolvedValueOnce({
            data: Buffer.from('img'),
            headers: { 'content-type': 'image/png' },
        } as any);

        const prepared = await prepareMediaInput(
            'http://192.168.1.23/path/photo.png',
            undefined,
            ['192.168.1.23']
        );

        expect(fs.existsSync(prepared.path)).toBe(true);
        await prepared.cleanup?.();
    });

    it('allows IPv6 private literal when matching IPv6 CIDR allowlist', async () => {
        mockedAxiosGet.mockResolvedValueOnce({
            data: Buffer.from('img'),
            headers: { 'content-type': 'image/png' },
        } as any);

        const prepared = await prepareMediaInput('http://[fd00::1]/path/photo.png', undefined, ['fc00::/7']);

        expect(fs.existsSync(prepared.path)).toBe(true);
        await prepared.cleanup?.();
    });

    it('rejects remote hosts not listed in mediaUrlAllowlist when allowlist is configured', async () => {
        await expect(prepareMediaInput('https://example.com/path/photo.png', undefined, ['cdn.example.com'])).rejects.toThrow(
            /not in mediaUrlAllowlist/
        );
        expect(mockedAxiosGet).not.toHaveBeenCalled();
    });

    it('returns stable error code for allowlist misses', async () => {
        try {
            await prepareMediaInput('https://example.com/path/photo.png', undefined, ['cdn.example.com']);
            throw new Error('expected prepareMediaInput to throw');
        } catch (err: any) {
            expect(err.code).toBe('ERR_MEDIA_ALLOWLIST_MISS');
        }
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
