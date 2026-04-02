import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    cleanupOrphanedTempFiles,
    closePluginDebugLog,
    createResolve4FallbackLookupWithDeps,
    formatDingTalkConnectionErrorLog,
    formatDingTalkErrorPayload,
    formatDingTalkErrorPayloadLog,
    maskSensitiveData,
    resolvePluginDebugLog,
    retryWithBackoff,
} from '../../src/utils';

describe('utils', () => {
    describe('maskSensitiveData', () => {
        it('masks token fields recursively', () => {
            const input = {
                token: 'abcdef123456',
                nested: {
                    accessToken: 'xyz987654321',
                    keep: 'plain',
                },
            };

            const masked = maskSensitiveData(input);

            expect(masked.token).toBe('abc******456');
            expect(masked.nested.accessToken).toBe('xyz******321');
            expect(masked.nested.keep).toBe('plain');
        });

        it('returns primitive values unchanged', () => {
            expect(maskSensitiveData('hello')).toBe('hello');
            expect(maskSensitiveData(123)).toBe(123);
            expect(maskSensitiveData(null)).toBeNull();
        });
    });

    describe('formatDingTalkErrorPayload', () => {
        it('formats code and message with serialized payload', () => {
            const text = formatDingTalkErrorPayload({ code: 'invalidParameter', message: 'robotCode required' });

            expect(text).toContain('code=invalidParameter');
            expect(text).toContain('message=robotCode required');
            expect(text).toContain('payload={"code":"invalidParameter","message":"robotCode required"}');
        });

        it('builds log text with unified error payload prefix', () => {
            const text = formatDingTalkErrorPayloadLog('send.message', {
                code: 'invalidParameter',
                message: 'userIds required',
            });

            expect(text).toContain('[DingTalk][ErrorPayload][send.message]');
            expect(text).toContain('code=invalidParameter');
            expect(text).toContain('message=userIds required');
        });

        it('formats websocket-stage connection failures with endpoint and proxy hint', () => {
            const text = formatDingTalkConnectionErrorLog(
                'connect.open',
                Object.assign(new Error('Unexpected server response: 400'), {
                    dingtalkConnectionStage: 'connect.websocket',
                    dingtalkConnectionEndpoint: 'wss://wss-open-connection.dingtalk.com:443/connect',
                }),
                '[main] Failed to establish connection: Unexpected server response: 400'
            );

            expect(text).toContain('[DingTalk][ConnectionError][connect.websocket]');
            expect(text).toContain('endpoint=wss://wss-open-connection.dingtalk.com:443/connect');
            expect(text).toContain('proxy');
        });
    });

    describe('createResolve4FallbackLookupWithDeps', () => {
        it('falls back to resolve4 when lookup returns ENOTFOUND', async () => {
            const dnsImpl = {
                lookup: ((
                    _hostname: string,
                    _options: { family?: number; hints?: number },
                    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
                ) => callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }), '', 0)) as any,
                resolve4: ((
                    _hostname: string,
                    callback: (err: NodeJS.ErrnoException | null, addresses?: string[]) => void
                ) => callback(null, ['47.92.127.191'])) as any,
            };
            const log = { warn: vi.fn() };
            const lookup = createResolve4FallbackLookupWithDeps(log as any, 'default', dnsImpl, { isIP: () => 0 });

            const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
                lookup('wss-open-connection.dingtalk.com', { family: 0, hints: 0 }, (err, address, family) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve({ address: address as string, family: family ?? 0 });
                });
            });

            expect(result).toEqual({ address: '47.92.127.191', family: 4 });
            expect(log.warn).toHaveBeenCalledWith(
                expect.stringContaining('using resolve4 fallback 47.92.127.191'),
            );
        });

        it('preserves successful system lookup without resolve4 fallback', async () => {
            const resolve4 = vi.fn();
            const dnsImpl = {
                lookup: ((
                    _hostname: string,
                    _options: { family?: number; hints?: number },
                    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
                ) => callback(null, '1.2.3.4', 4)) as any,
                resolve4: resolve4 as any,
            };
            const lookup = createResolve4FallbackLookupWithDeps(undefined, undefined, dnsImpl, { isIP: () => 0 });

            const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
                lookup('wss-open-connection.dingtalk.com', { family: 0, hints: 0 }, (err, address, family) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve({ address: address as string, family: family ?? 0 });
                });
            });

            expect(result).toEqual({ address: '1.2.3.4', family: 4 });
            expect(resolve4).not.toHaveBeenCalled();
        });

        it('returns lookup-address array for IP literals when options.all is true', async () => {
            const dnsImpl = {
                lookup: vi.fn(),
                resolve4: vi.fn(),
            };
            const lookup = createResolve4FallbackLookupWithDeps(undefined, undefined, dnsImpl as any, { isIP: () => 4 });

            const result = await new Promise<{ address: { address: string; family: number }[]; family: number }>((resolve, reject) => {
                lookup('1.2.3.4', { all: true }, (err, address, family) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve({ address: address as { address: string; family: number }[], family: family ?? 0 });
                });
            });

            expect(result).toEqual({
                address: [{ address: '1.2.3.4', family: 4 }],
                family: 4,
            });
            expect(dnsImpl.lookup).not.toHaveBeenCalled();
            expect(dnsImpl.resolve4).not.toHaveBeenCalled();
        });
    });

    describe('retryWithBackoff', () => {
        it('retries retryable status and eventually succeeds', async () => {
            vi.useFakeTimers();
            const fn = vi
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce({ response: { status: 429 } })
                .mockResolvedValueOnce('ok');

            const promise = retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10 });
            await vi.advanceTimersByTimeAsync(12);
            const result = await promise;

            expect(result).toBe('ok');
            expect(fn).toHaveBeenCalledTimes(2);
            vi.useRealTimers();
        });

        it('throws immediately on non-retryable status', async () => {
            const fn = vi.fn<() => Promise<string>>().mockRejectedValue({ response: { status: 400 } });

            await expect(retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10 })).rejects.toBeDefined();
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('logs payload details with unified prefix before retry decision', async () => {
            const fn = vi
                .fn<() => Promise<string>>()
                .mockRejectedValue({ response: { status: 400, data: { code: 'invalidParameter', message: 'bad payload' } } });
            const log = { debug: vi.fn() };

            await expect(retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10, log: log as any })).rejects.toBeDefined();

            const debugLogs = log.debug.mock.calls.map((args: unknown[]) => String(args[0]));
            expect(
                debugLogs.some(
                    (entry) =>
                        entry.includes('[DingTalk][ErrorPayload][retry.beforeDecision]') &&
                        entry.includes('code=invalidParameter') &&
                        entry.includes('message=bad payload')
                )
            ).toBe(true);
        });
    });

    describe('cleanupOrphanedTempFiles', () => {
        let oldFile = '';
        let recentFile = '';
        let otherFile = '';

        afterEach(() => {
            for (const file of [oldFile, recentFile, otherFile]) {
                if (file && fs.existsSync(file)) {
                    fs.rmSync(file, { force: true });
                }
            }
        });

        it('removes only stale matching temp files', () => {
            const nonce = Date.now();
            oldFile = path.join(os.tmpdir(), `dingtalk_${nonce}.txt`);
            recentFile = path.join(os.tmpdir(), `dingtalk_${nonce + 1}.txt`);
            otherFile = path.join(os.tmpdir(), `other_${nonce}.txt`);

            fs.writeFileSync(oldFile, 'old');
            fs.writeFileSync(recentFile, 'recent');
            fs.writeFileSync(otherFile, 'other');

            const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
            fs.utimesSync(oldFile, oldTime, oldTime);

            const cleaned = cleanupOrphanedTempFiles();

            expect(cleaned).toBe(1);
            expect(fs.existsSync(oldFile)).toBe(false);
            expect(fs.existsSync(recentFile)).toBe(true);
            expect(fs.existsSync(otherFile)).toBe(true);
        });
    });

    describe('resolvePluginDebugLog', () => {
        let tempDir = '';
        let storePath = '';
        let stdoutSpy: ReturnType<typeof vi.spyOn>;

        afterEach(() => {
            stdoutSpy?.mockRestore();
            if (storePath) {
                closePluginDebugLog({ accountId: 'main', storePath });
            }
            if (tempDir && fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
            tempDir = '';
            storePath = '';
        });

        it('writes plugin debug lines to stdout and the per-account daily log file when debug is enabled', () => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-plugin-log-'));
            storePath = path.join(tempDir, 'session-store.json');
            stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true as any);
            const baseLog = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
            const pluginLog = resolvePluginDebugLog({
                accountId: 'main',
                storePath,
                debug: true,
                baseLog,
                now: () => new Date('2026-04-02T07:04:05.123Z'),
            });

            pluginLog.debug?.('[DingTalk] test line');

            const expectedLogFile = path.join(
                tempDir,
                'logs',
                'dingtalk',
                'main',
                'debug-2026-04-02.log',
            );
            expect(stdoutSpy).toHaveBeenCalled();
            expect(fs.readFileSync(expectedLogFile, 'utf8')).toContain('[account:main] [DingTalk] test line');
            expect(baseLog.debug).toHaveBeenCalledWith('[DingTalk] test line');
        });

        it('skips file creation when debug is disabled and only forwards to upstream debug', () => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-plugin-log-'));
            storePath = path.join(tempDir, 'session-store.json');
            stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true as any);
            const baseLog = { debug: vi.fn(), warn: vi.fn() };
            const pluginLog = resolvePluginDebugLog({
                accountId: 'main',
                storePath,
                debug: false,
                baseLog,
            });

            pluginLog.debug?.('disabled path');

            const expectedLogFile = path.join(
                tempDir,
                'logs',
                'dingtalk',
                'main',
                'debug-2026-04-02.log',
            );
            expect(baseLog.debug).toHaveBeenCalledWith('disabled path');
            expect(stdoutSpy).not.toHaveBeenCalled();
            expect(fs.existsSync(expectedLogFile)).toBe(false);
        });

        it('warns once and keeps debug forwarding when file persistence fails', () => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-plugin-log-'));
            storePath = path.join(tempDir, 'session-store.json');
            stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true as any);
            const baseLog = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
            const pluginLog = resolvePluginDebugLog({
                accountId: 'main',
                storePath,
                debug: true,
                baseLog,
                fsImpl: {
                    mkdirSync: vi.fn(),
                    appendFileSync: vi.fn(() => {
                        throw new Error('disk full');
                    }),
                } as any,
            });

            expect(() => pluginLog.debug?.('one')).not.toThrow();
            expect(() => pluginLog.debug?.('two')).not.toThrow();

            expect(baseLog.warn).toHaveBeenCalledTimes(1);
            expect(baseLog.debug).toHaveBeenCalledTimes(2);
        });

        it('creates the log directory only once for repeated writes on the same writer', () => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-plugin-log-'));
            storePath = path.join(tempDir, 'session-store.json');
            stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true as any);
            const mkdirSync = vi.fn();
            const appendFileSync = vi.fn();
            const baseLog = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
            const pluginLog = resolvePluginDebugLog({
                accountId: 'main',
                storePath,
                debug: true,
                baseLog,
                now: () => new Date('2026-04-02T07:04:05.123Z'),
                fsImpl: { mkdirSync, appendFileSync } as any,
            });

            pluginLog.debug?.('first');
            pluginLog.debug?.('second');

            expect(mkdirSync).toHaveBeenCalledTimes(1);
            expect(appendFileSync).toHaveBeenCalledTimes(2);
        });

        it('keeps file persistence and upstream forwarding when stdout write fails', () => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-plugin-log-'));
            storePath = path.join(tempDir, 'session-store.json');
            stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
                throw new Error('stdout unavailable');
            });
            const baseLog = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
            const pluginLog = resolvePluginDebugLog({
                accountId: 'main',
                storePath,
                debug: true,
                baseLog,
                now: () => new Date('2026-04-02T07:04:05.123Z'),
            });

            expect(() => pluginLog.debug?.('survives stdout failure')).not.toThrow();

            const expectedLogFile = path.join(
                tempDir,
                'logs',
                'dingtalk',
                'main',
                'debug-2026-04-02.log',
            );
            expect(fs.readFileSync(expectedLogFile, 'utf8')).toContain('survives stdout failure');
            expect(baseLog.debug).toHaveBeenCalledWith('survives stdout failure');
        });

        it('writes to stdout only when storePath is missing', () => {
            stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true as any);
            const baseLog = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
            const pluginLog = resolvePluginDebugLog({
                accountId: 'main',
                debug: true,
                baseLog,
            });

            expect(() => pluginLog.debug?.('stdout only')).not.toThrow();

            expect(stdoutSpy).toHaveBeenCalled();
            expect(baseLog.debug).toHaveBeenCalledWith('stdout only');
        });

        it('forwards info warn error without creating debug log files', () => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-plugin-log-'));
            storePath = path.join(tempDir, 'session-store.json');
            stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true as any);
            const baseLog = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
            const pluginLog = resolvePluginDebugLog({
                accountId: 'main',
                storePath,
                debug: true,
                baseLog,
            });

            pluginLog.info?.('info path');
            pluginLog.warn?.('warn path');
            pluginLog.error?.('error path');

            expect(baseLog.info).toHaveBeenCalledWith('info path');
            expect(baseLog.warn).toHaveBeenCalledWith('warn path');
            expect(baseLog.error).toHaveBeenCalledWith('error path');
            expect(fs.existsSync(path.join(tempDir, 'logs', 'dingtalk', 'main'))).toBe(false);
            expect(stdoutSpy).not.toHaveBeenCalled();
        });

        it('does not recreate a file writer after close for the same wrapper, but a fresh wrapper can reopen it', () => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-plugin-log-'));
            storePath = path.join(tempDir, 'session-store.json');
            stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true as any);
            const baseLog = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
            const firstLog = resolvePluginDebugLog({
                accountId: 'main',
                storePath,
                debug: true,
                baseLog,
                now: () => new Date('2026-04-02T07:04:05.123Z'),
            });

            firstLog.debug?.('before close');
            closePluginDebugLog({ accountId: 'main', storePath });
            firstLog.debug?.('after close should not append');

            const expectedLogFile = path.join(
                tempDir,
                'logs',
                'dingtalk',
                'main',
                'debug-2026-04-02.log',
            );
            const firstContents = fs.readFileSync(expectedLogFile, 'utf8');
            expect(firstContents).toContain('before close');
            expect(firstContents).not.toContain('after close should not append');

            const reopenedLog = resolvePluginDebugLog({
                accountId: 'main',
                storePath,
                debug: true,
                baseLog,
                now: () => new Date('2026-04-02T07:04:05.123Z'),
            });
            reopenedLog.debug?.('after reopen');

            const reopenedContents = fs.readFileSync(expectedLogFile, 'utf8');
            expect(reopenedContents).toContain('after reopen');
        });
    });
});
