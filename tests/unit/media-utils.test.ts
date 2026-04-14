import * as fs from 'node:fs';
import * as dnsPromises from 'node:dns/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectMediaTypeFromExtension, getVoiceDurationMs, prepareMediaInput, resolveOutboundMediaType, uploadMedia } from '../../src/media-utils';

const mockLoadWebMedia = vi.fn();
const { mockRunFfmpeg, mockRunFfprobe } = vi.hoisted(() => ({
    mockRunFfmpeg: vi.fn(),
    mockRunFfprobe: vi.fn(),
}));

vi.mock('../../src/runtime', () => ({
    getDingTalkRuntime: () => ({
        media: { loadWebMedia: mockLoadWebMedia },
        channel: { media: { saveMediaBuffer: vi.fn() } },
    }),
}));

vi.mock('openclaw/plugin-sdk/media-runtime', () => ({
    runFfmpeg: mockRunFfmpeg,
    runFfprobe: mockRunFfprobe,
}));

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

function createSilentWavBuffer(durationMs: number, sampleRate = 16000): Buffer {
    const channels = 1;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const sampleCount = Math.round(sampleRate * durationMs / 1000);
    const dataSize = sampleCount * channels * bytesPerSample;
    const byteRate = sampleRate * channels * bytesPerSample;
    const blockAlign = channels * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    return buffer;
}

afterEach(() => {
    mockedAxiosGet.mockReset();
    mockedAxiosPost.mockReset();
    mockedDnsLookup.mockReset();
    mockRunFfmpeg.mockReset();
    mockRunFfprobe.mockReset();
});

beforeEach(() => {
    mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
});

describe('media-utils', () => {
    it('detects media type from file extension', () => {
        expect(detectMediaTypeFromExtension('/tmp/a.jpg')).toBe('image');
        expect(detectMediaTypeFromExtension('/tmp/a.mp3')).toBe('voice');
        expect(detectMediaTypeFromExtension('/tmp/a.ogg')).toBe('voice');
        expect(detectMediaTypeFromExtension('/tmp/a.mp4')).toBe('video');
        expect(detectMediaTypeFromExtension('/tmp/a.pdf')).toBe('file');
    });

    it('resolveOutboundMediaType returns "file" for audio extensions when asVoice is false', () => {
        expect(resolveOutboundMediaType({ mediaPath: '/tmp/a.mp3', asVoice: false })).toBe('file');
        expect(resolveOutboundMediaType({ mediaPath: '/tmp/a.wav', asVoice: false })).toBe('file');
        expect(resolveOutboundMediaType({ mediaPath: '/tmp/a.ogg', asVoice: false })).toBe('file');
        expect(resolveOutboundMediaType({ mediaPath: '/tmp/a.amr', asVoice: false })).toBe('file');
    });

    it('resolveOutboundMediaType returns "voice" for audio extensions when asVoice is true', () => {
        expect(resolveOutboundMediaType({ mediaPath: '/tmp/a.mp3', asVoice: true })).toBe('voice');
        expect(resolveOutboundMediaType({ mediaPath: '/tmp/a.wav', asVoice: true })).toBe('voice');
        expect(resolveOutboundMediaType({ mediaPath: '/tmp/a.ogg', asVoice: true })).toBe('voice');
        expect(resolveOutboundMediaType({ mediaPath: '/tmp/a.amr', asVoice: true })).toBe('voice');
    });

    it('resolveOutboundMediaType respects explicit mediaType for non-audio files', () => {
        expect(resolveOutboundMediaType({ mediaPath: '/tmp/a.png', mediaType: 'image', asVoice: false })).toBe('image');
        expect(resolveOutboundMediaType({ mediaPath: '/tmp/a.mp4', asVoice: false })).toBe('video');
        expect(resolveOutboundMediaType({ mediaPath: '/tmp/a.pdf', asVoice: false })).toBe('file');
    });

    it('resolveOutboundMediaType respects explicit mediaType="voice" even when asVoice is false', () => {
        expect(resolveOutboundMediaType({ mediaPath: '/tmp/a.mp3', mediaType: 'voice', asVoice: false })).toBe('voice');
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

    it('returns actual duration for valid wav voice files', async () => {
        const wavPath = createTempFileWithExt(createSilentWavBuffer(2500), '.wav');

        const durationMs = await getVoiceDurationMs(wavPath, 'voice');

        expect(durationMs).toBe(2500);
        fs.rmSync(path.dirname(wavPath), { recursive: true, force: true });
    });

    it('returns actual duration for ogg voice files via ffprobe', async () => {
        const oggPath = createTempFileWithExt(Buffer.from('OggS'), '.ogg');
        mockRunFfprobe.mockResolvedValueOnce('2.75\n');

        const durationMs = await getVoiceDurationMs(oggPath, 'voice');

        expect(durationMs).toBe(2750);
        expect(mockRunFfprobe).toHaveBeenCalled();
        fs.rmSync(path.dirname(oggPath), { recursive: true, force: true });
    });

    it('uploads media and returns media_id on success', async () => {
        const mediaPath = createTempFile(Buffer.from('hello world'));
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_123' } } as any);

        const result = await uploadMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            mediaPath,
            'file',
            vi.fn().mockResolvedValue('token_abc')
        );

        expect(result?.mediaId).toBe('media_123');
        expect(result?.buffer).toEqual(Buffer.from('hello world'));
        expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
        expect(mockedAxiosPost.mock.calls[0]?.[0]).toContain('access_token=token_abc&type=file');

        fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
    });

    it('transcodes wav voice uploads to ogg before posting to DingTalk', async () => {
        const wavPath = createTempFileWithExt(createSilentWavBuffer(1800), '.wav');
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_voice_ogg' } } as any);
        mockRunFfprobe.mockResolvedValueOnce('1.8\n');
        mockRunFfmpeg.mockImplementationOnce(async (args: string[]) => {
            const outputPath = args[args.length - 1];
            fs.writeFileSync(outputPath, Buffer.from('OggS converted voice'));
            return '';
        });

        const result = await uploadMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            wavPath,
            'voice',
            vi.fn().mockResolvedValue('token_abc')
        );

        expect(result?.mediaId).toBe('media_voice_ogg');
        expect(result?.durationMs).toBe(1800);
        expect(mockRunFfmpeg).toHaveBeenCalledTimes(1);
        expect(mockRunFfmpeg.mock.calls[0]?.[0]?.at(-1)).toMatch(/\.ogg$/);
        fs.rmSync(path.dirname(wavPath), { recursive: true, force: true });
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

    it('follows redirects and pins DNS lookup for each hop', async () => {
        mockedDnsLookup
            .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as any)
            .mockResolvedValueOnce([{ address: '104.26.4.30', family: 4 }] as any);

        mockedAxiosGet
            .mockResolvedValueOnce({
                status: 302,
                headers: { location: 'https://cdn.example.com/img.png' },
                data: Buffer.from(''),
            } as any)
            .mockResolvedValueOnce({
                status: 200,
                data: Buffer.from('img'),
                headers: { 'content-type': 'image/png' },
            } as any);

        const prepared = await prepareMediaInput('https://example.com/path/photo', {
            debug: vi.fn(),
        } as any);

        expect(mockedAxiosGet).toHaveBeenCalledTimes(2);

        const firstRequestConfig = mockedAxiosGet.mock.calls[0]?.[1] as {
            lookup?: (hostname: string) => Promise<{ address: string; family: number }>;
        };
        const secondRequestConfig = mockedAxiosGet.mock.calls[1]?.[1] as {
            lookup?: (hostname: string) => Promise<{ address: string; family: number }>;
        };

        expect(firstRequestConfig.lookup).toBeTypeOf('function');
        expect(secondRequestConfig.lookup).toBeTypeOf('function');

        await expect(firstRequestConfig.lookup?.('example.com')).resolves.toMatchObject({
            address: '93.184.216.34',
            family: 4,
        });
        await expect(firstRequestConfig.lookup?.('cdn.example.com')).rejects.toThrow(/unexpected host/);

        await expect(secondRequestConfig.lookup?.('cdn.example.com')).resolves.toMatchObject({
            address: '104.26.4.30',
            family: 4,
        });
        await expect(secondRequestConfig.lookup?.('example.com')).rejects.toThrow(/unexpected host/);

        await prepared.cleanup?.();
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

    it('falls back to runtime media bridge for sandbox paths (ENOENT on host)', async () => {
        const sandboxPath = '/workspace/generated-image.png';
        const fileContent = Buffer.from('sandbox-image-data');

        mockLoadWebMedia.mockResolvedValueOnce({
            buffer: fileContent,
            fileName: 'generated-image.png',
            contentType: 'image/png',
        });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_sandbox_1' } } as any);

        const result = await uploadMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            sandboxPath,
            'image',
            vi.fn().mockResolvedValue('token_abc'),
            { debug: vi.fn() } as any,
        );

        expect(result?.mediaId).toBe('media_sandbox_1');
        expect(mockLoadWebMedia).toHaveBeenCalledWith(sandboxPath, { localRoots: undefined });
        expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    });

    it('passes mediaLocalRoots to runtime media bridge', async () => {
        const sandboxPath = '/workspace/output.pdf';
        const fileContent = Buffer.from('pdf-data');
        const localRoots = ['/workspace', '/tmp'];

        mockLoadWebMedia.mockResolvedValueOnce({
            buffer: fileContent,
            fileName: 'output.pdf',
            contentType: 'application/pdf',
        });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_sandbox_2' } } as any);

        const result = await uploadMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            sandboxPath,
            'file',
            vi.fn().mockResolvedValue('token_abc'),
            { debug: vi.fn() } as any,
            { mediaLocalRoots: localRoots },
        );

        expect(result?.mediaId).toBe('media_sandbox_2');
        expect(mockLoadWebMedia).toHaveBeenCalledWith(sandboxPath, { localRoots: localRoots });
    });

    it('returns null when loadWebMedia returns null (sandbox bridge failure)', async () => {
        const sandboxPath = '/workspace/missing.png';

        mockLoadWebMedia.mockResolvedValueOnce(null);

        const log = { error: vi.fn(), debug: vi.fn() };
        const mediaId = await uploadMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            sandboxPath,
            'image',
            vi.fn().mockResolvedValue('token_abc'),
            log as any,
        );

        expect(mediaId).toBeNull();
        expect(log.error).toHaveBeenCalled();
        const errorMsg = String(log.error.mock.calls[0]?.[0] ?? '');
        expect(errorMsg).toContain('not found');
    });

    it('returns null when loadWebMedia returns object without buffer', async () => {
        const sandboxPath = '/workspace/empty.png';

        mockLoadWebMedia.mockResolvedValueOnce({ fileName: 'empty.png' });

        const log = { error: vi.fn(), debug: vi.fn() };
        const mediaId = await uploadMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            sandboxPath,
            'image',
            vi.fn().mockResolvedValue('token_abc'),
            log as any,
        );

        expect(mediaId).toBeNull();
        expect(log.error).toHaveBeenCalled();
    });
});
