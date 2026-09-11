import * as fs from 'node:fs';
import * as dnsPromises from 'node:dns/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareMediaInput, uploadMedia } from '../../src/media-utils';

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

describe('media-utils local roots', () => {
    it('does not read a host file outside mediaLocalRoots', async () => {
        const mediaPath = createTempFile(Buffer.from('host-secret'));
        const bridgeContent = Buffer.from('controlled-media');
        mockLoadWebMedia.mockResolvedValueOnce({ buffer: bridgeContent, fileName: 'media.bin' });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_root_checked' } } as any);

        const result = await uploadMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            mediaPath,
            'file',
            vi.fn().mockResolvedValue('token_abc'),
            { debug: vi.fn() } as any,
            { mediaLocalRoots: ['/allowed'] },
        );

        expect(result?.mediaId).toBe('media_root_checked');
        expect(mockLoadWebMedia).toHaveBeenCalledWith(mediaPath, { localRoots: ['/allowed'] });
        expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
        fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
    });

    // Windows needs Developer Mode / SeCreateSymbolicLinkPrivilege for file symlinks.
    it.skipIf(process.platform === 'win32')('does not follow a symlink inside mediaLocalRoots that points outside the root', async () => {
        const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-root-'));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-outside-'));
        const secretPath = path.join(outsideRoot, 'secret.bin');
        fs.writeFileSync(secretPath, Buffer.from('outside-secret'));
        const linkPath = path.join(allowedRoot, 'link.bin');
        fs.symlinkSync(secretPath, linkPath);

        const bridgeContent = Buffer.from('controlled-media');
        mockLoadWebMedia.mockResolvedValueOnce({ buffer: bridgeContent, fileName: 'media.bin' });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_symlink_blocked' } } as any);

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                linkPath,
                'file',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                { mediaLocalRoots: [allowedRoot] },
            );

            // The escape must be routed to the bridge instead of reading the host file.
            expect(result?.mediaId).toBe('media_symlink_blocked');
            expect(result?.buffer.equals(bridgeContent)).toBe(true);
            expect(mockLoadWebMedia).toHaveBeenCalledWith(linkPath, { localRoots: [allowedRoot] });
            expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
        } finally {
            fs.rmSync(allowedRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === 'win32')('reads a host file inside mediaLocalRoots directly', async () => {
        const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-root-'));
        const realPath = path.join(allowedRoot, 'real.bin');
        fs.writeFileSync(realPath, Buffer.from('inside-data'));
        // A symlink that stays inside the root must remain readable.
        const linkPath = path.join(allowedRoot, 'link.bin');
        fs.symlinkSync(realPath, linkPath);
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_root_inside' } } as any);

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                linkPath,
                'file',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                { mediaLocalRoots: [allowedRoot] },
            );

            expect(result?.mediaId).toBe('media_root_inside');
            expect(result?.buffer.equals(Buffer.from('inside-data'))).toBe(true);
            expect(mockLoadWebMedia).not.toHaveBeenCalled();
            expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
        } finally {
            fs.rmSync(allowedRoot, { recursive: true, force: true });
        }
    });

    it('reports an in-root host miss as ENOENT instead of a root escape', async () => {
        const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-root-'));
        const missingPath = path.join(allowedRoot, 'missing.bin');
        mockLoadWebMedia.mockResolvedValueOnce({ buffer: Buffer.from('bridge-data'), fileName: 'missing.bin' });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_in_root_missing' } } as any);
        const debug = vi.fn();

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                missingPath,
                'file',
                vi.fn().mockResolvedValue('token_abc'),
                { debug } as any,
                { mediaLocalRoots: [allowedRoot] },
            );

            expect(result?.mediaId).toBe('media_in_root_missing');
            const logs = debug.mock.calls.map((args: unknown[]) => String(args[0]));
            expect(logs.some((entry) => entry.includes('File not found on host'))).toBe(true);
            // A missing file inside an allowed root is not a boundary escape.
            expect(logs.some((entry) => entry.includes('outside configured local roots'))).toBe(false);
        } finally {
            fs.rmSync(allowedRoot, { recursive: true, force: true });
        }
    });

    it('logs the out-of-root reason when mediaLocalRoots blocks a host path', async () => {
        const mediaPath = createTempFile(Buffer.from('host-secret'));
        mockLoadWebMedia.mockResolvedValueOnce({ buffer: Buffer.from('bridge-data'), fileName: 'media.bin' });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_out_of_root' } } as any);
        const debug = vi.fn();

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                mediaPath,
                'file',
                vi.fn().mockResolvedValue('token_abc'),
                { debug } as any,
                { mediaLocalRoots: ['/allowed-root-sentinel'] },
            );

            expect(result?.mediaId).toBe('media_out_of_root');
            const logs = debug.mock.calls.map((args: unknown[]) => String(args[0]));
            expect(logs.some((entry) => entry.includes('outside configured local roots'))).toBe(true);
            expect(logs.some((entry) => entry.includes('File not found on host'))).toBe(false);
        } finally {
            fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
        }
    });

    it('reads plugin-generated remote media temp files outside mediaLocalRoots', async () => {
        const remoteContent = Buffer.from('remote-image-data');
        mockedAxiosGet.mockResolvedValueOnce({
            data: remoteContent,
            headers: { 'content-type': 'image/png' },
            status: 200,
        } as any);
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_remote_temp' } } as any);

        const prepared = await prepareMediaInput('https://example.com/path/photo.png', { debug: vi.fn() } as any);
        try {
            // The configured root deliberately excludes the plugin's temp directory.
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                prepared.path,
                'image',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                { mediaLocalRoots: ['/workspace-only'] },
            );

            expect(result?.mediaId).toBe('media_remote_temp');
            expect(result?.buffer.equals(remoteContent)).toBe(true);
            // Plugin-owned temp media must be read directly, not via the roots-gated bridge.
            expect(mockLoadWebMedia).not.toHaveBeenCalled();
        } finally {
            await prepared.cleanup?.();
        }
    });

    it('reads plugin-generated voice transcode temp files outside mediaLocalRoots', async () => {
        const wavPath = createTempFileWithExt(createSilentWavBuffer(1800), '.wav');
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_voice_temp' } } as any);
        mockRunFfprobe.mockResolvedValueOnce('1.8\n');
        mockRunFfmpeg.mockImplementationOnce(async (args: string[]) => {
            const outputPath = args[args.length - 1];
            fs.writeFileSync(outputPath, Buffer.from('OggS converted voice'));
            return '';
        });

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                wavPath,
                'voice',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                { mediaLocalRoots: ['/workspace-only'] },
            );

            expect(result?.mediaId).toBe('media_voice_temp');
            expect(result?.buffer.equals(Buffer.from('OggS converted voice'))).toBe(true);
            // The transcoded temp file is plugin-owned and must not hit the bridge.
            expect(mockLoadWebMedia).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(path.dirname(wavPath), { recursive: true, force: true });
        }
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
});
