import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    cleanupOrphanedTempFiles,
    formatDingTalkConnectionErrorLog,
    formatDingTalkErrorPayload,
    formatDingTalkErrorPayloadLog,
    maskSensitiveData,
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
});
