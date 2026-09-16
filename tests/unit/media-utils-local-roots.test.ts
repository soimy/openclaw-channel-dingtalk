import * as fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import * as dnsPromises from 'node:dns/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareMediaInput, uploadMedia } from '../../src/messaging/media-utils';

const mockLoadWebMedia = vi.fn();
const { mockRunFfmpeg, mockRunFfprobe } = vi.hoisted(() => ({
    mockRunFfmpeg: vi.fn(),
    mockRunFfprobe: vi.fn(),
}));

vi.mock('../../src/platform/runtime', () => ({
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

    it('resolves an in-root host file through the bridge with the scoped roots', async () => {
        const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-root-'));
        const realPath = path.join(allowedRoot, 'real.bin');
        fs.writeFileSync(realPath, Buffer.from('inside-data'));
        mockLoadWebMedia.mockResolvedValueOnce({
            buffer: Buffer.from('inside-data'),
            fileName: 'real.bin',
        });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_root_inside' } } as any);

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                realPath,
                'file',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                { mediaLocalRoots: [allowedRoot] },
            );

            expect(result?.mediaId).toBe('media_root_inside');
            expect(result?.buffer.equals(Buffer.from('inside-data'))).toBe(true);
            // Containment is decided by the host, not re-implemented here.
            expect(mockLoadWebMedia).toHaveBeenCalledWith(realPath, { localRoots: [allowedRoot] });
            expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
        } finally {
            fs.rmSync(allowedRoot, { recursive: true, force: true });
        }
    });

    it('returns null when the bridge cannot resolve a caller path', async () => {
        const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-root-'));
        const missingPath = path.join(allowedRoot, 'missing.bin');
        mockLoadWebMedia.mockResolvedValueOnce(undefined);
        const error = vi.fn();

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                missingPath,
                'file',
                vi.fn().mockResolvedValue('token_abc'),
                { error, debug: vi.fn() } as any,
                { mediaLocalRoots: [allowedRoot] },
            );

            expect(result).toBeNull();
            const logs = error.mock.calls.map((args: unknown[]) => String(args[0]));
            expect(logs.some((entry) => entry.includes('Media file not found'))).toBe(true);
            expect(mockedAxiosPost).not.toHaveBeenCalled();
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
            expect(logs.some((entry) => entry.includes('not plugin-owned'))).toBe(true);
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

    it('does not widen the boundary to a sibling agent workspace', async () => {
        // The host scopes roots per agent; a file in `workspace-<other>` must not be
        // read directly just because it sits next to the authorized workspace.
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-state-'));
        const agentWorkspace = path.join(stateDir, 'workspace-main');
        const otherWorkspace = path.join(stateDir, 'workspace-other');
        fs.mkdirSync(agentWorkspace, { recursive: true });
        fs.mkdirSync(otherWorkspace, { recursive: true });
        const otherFile = path.join(otherWorkspace, 'chart.png');
        fs.writeFileSync(otherFile, Buffer.from('other-agent-secret'));
        const bridgeContent = Buffer.from('bridge-copy');
        mockLoadWebMedia.mockResolvedValueOnce({ buffer: bridgeContent, fileName: 'chart.png' });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_other_agent' } } as any);

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                otherFile,
                'image',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                { mediaLocalRoots: [agentWorkspace] },
            );

            expect(result?.mediaId).toBe('media_other_agent');
            expect(result?.buffer.equals(bridgeContent)).toBe(true);
            expect(mockLoadWebMedia).toHaveBeenCalledWith(otherFile, { localRoots: [agentWorkspace] });
        } finally {
            fs.rmSync(stateDir, { recursive: true, force: true });
        }
    });

    it('does not let a broad root authorize a sibling workspace', async () => {
        // Mirrors the host rule that a broad root (shared tmp) must not authorize a
        // sibling `workspace-<agent>`: the plugin simply never applies containment
        // itself, so the bridge stays the only decision point.
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-state-'));
        const agentWorkspace = path.join(stateDir, 'workspace-main');
        const otherWorkspace = path.join(stateDir, 'workspace-other');
        fs.mkdirSync(agentWorkspace, { recursive: true });
        fs.mkdirSync(otherWorkspace, { recursive: true });
        const otherFile = path.join(otherWorkspace, 'chart.png');
        fs.writeFileSync(otherFile, Buffer.from('other-agent-secret'));
        mockLoadWebMedia.mockResolvedValueOnce({ buffer: Buffer.from('bridge-copy'), fileName: 'chart.png' });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_broad_root' } } as any);

        try {
            // A broad root that technically contains the sibling path, plus the
            // agent's own workspace root.
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                otherFile,
                'image',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                { mediaLocalRoots: [os.tmpdir(), agentWorkspace] },
            );

            expect(result?.mediaId).toBe('media_broad_root');
            expect(mockLoadWebMedia).toHaveBeenCalledWith(otherFile, {
                localRoots: [os.tmpdir(), agentWorkspace],
            });
        } finally {
            fs.rmSync(stateDir, { recursive: true, force: true });
        }
    });

    it('refuses host paths outside the agent-scoped roots', async () => {
        const mediaPath = createTempFile(Buffer.from('host-secret'));
        const bridgeContent = Buffer.from('bridge-copy');
        mockLoadWebMedia.mockResolvedValueOnce({ buffer: bridgeContent, fileName: 'secret.bin' });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_scoped_out' } } as any);

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                mediaPath,
                'file',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                { mediaLocalRoots: ['/state/workspace-main'] },
            );

            expect(result?.mediaId).toBe('media_scoped_out');
            expect(result?.buffer.equals(bridgeContent)).toBe(true);
        } finally {
            fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
        }
    });

    it('refuses a direct host read when the host configured no roots at all', async () => {
        const mediaPath = createTempFile(Buffer.from('host-secret'));
        const bridgeContent = Buffer.from('bridge-only');
        mockLoadWebMedia.mockResolvedValueOnce({ buffer: bridgeContent, fileName: 'media.bin' });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_no_roots' } } as any);
        const debug = vi.fn();

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                mediaPath,
                'file',
                vi.fn().mockResolvedValue('token_abc'),
                { debug } as any,
                // No mediaLocalRoots: nothing authorizes this caller path, so it is
                // never opened directly and the bridge decides instead.
            );

            expect(result?.mediaId).toBe('media_no_roots');
            expect(result?.buffer.equals(bridgeContent)).toBe(true);
            expect(mockLoadWebMedia).toHaveBeenCalledWith(mediaPath, { localRoots: undefined });
            const logs = debug.mock.calls.map((args: unknown[]) => String(args[0]));
            expect(logs.some((entry) => entry.includes('not plugin-owned'))).toBe(true);
            expect(logs.some((entry) => entry.includes('File not found on host'))).toBe(false);
        } finally {
            fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
        }
    });

    it('still reads plugin-owned temp media directly when no roots are configured', async () => {
        const remoteContent = Buffer.from('remote-image-data');
        mockedAxiosGet.mockResolvedValueOnce({
            data: remoteContent,
            headers: { 'content-type': 'image/png' },
            status: 200,
        } as any);
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_trusted_no_roots' } } as any);

        const prepared = await prepareMediaInput('https://example.com/path/photo.png', { debug: vi.fn() } as any);
        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                prepared.path,
                'image',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                // No roots, but this path was produced by the plugin's own download.
            );

            expect(result?.mediaId).toBe('media_trusted_no_roots');
            expect(result?.buffer.equals(remoteContent)).toBe(true);
            expect(mockLoadWebMedia).not.toHaveBeenCalled();
        } finally {
            await prepared.cleanup?.();
        }
    });

    it('falls back to the default duration when staging the voice source fails', async () => {
        const sourcePath = createTempFileWithExt(Buffer.from('OggS'), '.ogg');
        mockLoadWebMedia.mockResolvedValueOnce({ buffer: Buffer.from('OggS bridge copy'), fileName: 'voice.ogg' });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_ogg_unstaged' } } as any);
        const writeSpy = vi.spyOn(fsPromises, 'writeFile').mockRejectedValueOnce(
            Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
        );

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                sourcePath,
                'voice',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                { mediaLocalRoots: ['/allowed-root-sentinel'] },
            );

            // A failed staging step must not abort the send; the duration probe is
            // skipped and the default is used instead.
            expect(result?.mediaId).toBe('media_ogg_unstaged');
            expect(result?.durationMs).toBe(1000);
            expect(mockRunFfprobe).not.toHaveBeenCalled();
        } finally {
            writeSpy.mockRestore();
            fs.rmSync(path.dirname(sourcePath), { recursive: true, force: true });
        }
    });

    it('returns null instead of throwing when the boundary refuses and the bridge cannot help', async () => {
        const mediaPath = createTempFile(Buffer.from('host-secret'));
        // No roots and no bridge payload: the read must fail closed, not throw.
        mockLoadWebMedia.mockResolvedValueOnce(undefined);
        const error = vi.fn();

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                mediaPath,
                'file',
                vi.fn().mockResolvedValue('token_abc'),
                { error, debug: vi.fn() } as any,
            );

            expect(result).toBeNull();
            const logs = error.mock.calls.map((args: unknown[]) => String(args[0]));
            expect(logs.some((entry) => entry.includes('Media file not found'))).toBe(true);
            expect(mockedAxiosPost).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
        }
    });

    it('stages an out-of-root voice source before probing its duration', async () => {
        const sourcePath = createTempFileWithExt(Buffer.from('OggS'), '.ogg');
        mockLoadWebMedia.mockResolvedValueOnce({ buffer: Buffer.from('OggS bridge copy'), fileName: 'voice.ogg' });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_ogg_staged' } } as any);
        mockRunFfprobe.mockResolvedValueOnce('2.75\n');

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                sourcePath,
                'voice',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                { mediaLocalRoots: ['/allowed-root-sentinel'] },
            );

            expect(result?.mediaId).toBe('media_ogg_staged');
            expect(result?.durationMs).toBe(2750);
            // ffprobe must receive a staged copy, never the caller-supplied path.
            const probedPath = mockRunFfprobe.mock.calls[0]?.[0]?.at(-1);
            expect(probedPath).not.toBe(sourcePath);
            expect(String(probedPath).startsWith(os.tmpdir())).toBe(true);
        } finally {
            fs.rmSync(path.dirname(sourcePath), { recursive: true, force: true });
        }
    });

    it('stages a bridge-resolved voice source through a plugin-owned temp before transcoding', async () => {
        const sourcePath = '/workspace-only/missing.wav';
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_voice_temp' } } as any);
        // The boundary reader resolves the source once; the transcode temp is plugin-owned.
        mockLoadWebMedia.mockResolvedValueOnce({
            buffer: createSilentWavBuffer(1800),
            fileName: 'missing.wav',
        });
        mockRunFfprobe.mockResolvedValueOnce('1.8\n');
        let ffmpegInput = '';
        mockRunFfmpeg.mockImplementationOnce(async (args: string[]) => {
            ffmpegInput = args[args.indexOf('-i') + 1];
            const outputPath = args[args.length - 1];
            fs.writeFileSync(outputPath, Buffer.from('OggS converted voice'));
            return '';
        });

        const result = await uploadMedia(
            { clientId: 'id', clientSecret: 'sec' } as any,
            sourcePath,
            'voice',
            vi.fn().mockResolvedValue('token_abc'),
            { debug: vi.fn() } as any,
            { mediaLocalRoots: ['/workspace-only'] },
        );

        expect(result?.mediaId).toBe('media_voice_temp');
        expect(result?.buffer.equals(Buffer.from('OggS converted voice'))).toBe(true);
        // ffmpeg must read a staged temp, never the caller-supplied path.
        expect(ffmpegInput).not.toBe(sourcePath);
        expect(ffmpegInput.startsWith(os.tmpdir())).toBe(true);
        // One bridge call for the source; the plugin-owned transcode temp is read directly.
        expect(mockLoadWebMedia).toHaveBeenCalledTimes(1);
        expect(mockLoadWebMedia).toHaveBeenCalledWith(sourcePath, { localRoots: ['/workspace-only'] });
    });

    it('rejects an out-of-root voice source without invoking ffmpeg', async () => {
        const wavPath = createTempFileWithExt(createSilentWavBuffer(1800), '.wav');
        // The bridge cannot provide an out-of-root host path here.
        mockLoadWebMedia.mockResolvedValueOnce(null);
        const ffmpegSpy = vi.fn();
        mockRunFfmpeg.mockImplementationOnce(async () => {
            ffmpegSpy();
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

            expect(result).toBeNull();
            // The out-of-root source must be routed through the boundary, not decoded by ffmpeg.
            expect(ffmpegSpy).not.toHaveBeenCalled();
            expect(mockLoadWebMedia).toHaveBeenCalledWith(wavPath, { localRoots: ['/workspace-only'] });
        } finally {
            fs.rmSync(path.dirname(wavPath), { recursive: true, force: true });
        }
    });

    // Windows needs Developer Mode / SeCreateSymbolicLinkPrivilege for file symlinks.
    it.skipIf(process.platform === 'win32')('falls back to the bridge for a dangling symlink inside mediaLocalRoots', async () => {
        const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-root-'));
        const linkPath = path.join(allowedRoot, 'dangling.bin');
        fs.symlinkSync(path.join(allowedRoot, 'missing-target.bin'), linkPath);
        mockLoadWebMedia.mockResolvedValueOnce({ buffer: Buffer.from('bridge-data'), fileName: 'dangling.bin' });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_dangling' } } as any);

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                linkPath,
                'file',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                { mediaLocalRoots: [allowedRoot] },
            );

            expect(result?.mediaId).toBe('media_dangling');
            expect(mockLoadWebMedia).toHaveBeenCalledWith(linkPath, { localRoots: [allowedRoot] });
        } finally {
            fs.rmSync(allowedRoot, { recursive: true, force: true });
        }
    });

    it('treats a filesystem root entry as invalid and falls back to the bridge', async () => {
        const mediaPath = createTempFile(Buffer.from('host-secret'));
        mockLoadWebMedia.mockResolvedValueOnce({ buffer: Buffer.from('bridge-data'), fileName: 'media.bin' });
        mockedAxiosPost.mockResolvedValueOnce({ data: { errcode: 0, media_id: 'media_root_slash' } } as any);

        try {
            const result = await uploadMedia(
                { clientId: 'id', clientSecret: 'sec' } as any,
                mediaPath,
                'file',
                vi.fn().mockResolvedValue('token_abc'),
                { debug: vi.fn() } as any,
                { mediaLocalRoots: ['/'] },
            );

            expect(result?.mediaId).toBe('media_root_slash');
            expect(mockLoadWebMedia).toHaveBeenCalledWith(mediaPath, { localRoots: ['/'] });
        } finally {
            fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
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
