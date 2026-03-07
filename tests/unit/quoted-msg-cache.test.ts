import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    cacheInboundDownloadCode,
    getCachedDownloadCode,
    clearQuotedMsgCacheForTest,
} from '../../src/quoted-msg-cache';
import { resolveNamespacePath } from '../../src/persistence-store';

describe('quoted-msg-cache', () => {
    let tempDir = '';
    let storePath = '';

    beforeEach(() => {
        clearQuotedMsgCacheForTest();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-quoted-msg-cache-'));
        storePath = path.join(tempDir, 'session-store.json');
    });

    afterEach(() => {
        vi.useRealTimers();
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        tempDir = '';
        storePath = '';
    });

    it('基本缓存写入和读取', () => {
        cacheInboundDownloadCode(
            'default',
            'conv1',
            'msg1',
            'dl_code_1',
            'file',
            Date.now(),
            { storePath },
        );

        const entry = getCachedDownloadCode('default', 'conv1', 'msg1', storePath);
        expect(entry).not.toBeNull();
        expect(entry!.downloadCode).toBe('dl_code_1');

        expect(getCachedDownloadCode('default', 'conv1', 'msg_not_exist', storePath)).toBeNull();
        expect(getCachedDownloadCode('default', 'conv_not_exist', 'msg1', storePath)).toBeNull();
    });

    it('TTL 过期后返回 null', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);

        cacheInboundDownloadCode('default', 'conv1', 'msg1', 'dl_code_1', 'file', 0, { storePath });

        expect(getCachedDownloadCode('default', 'conv1', 'msg1', storePath)).not.toBeNull();

        vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

        expect(getCachedDownloadCode('default', 'conv1', 'msg1', storePath)).toBeNull();

        vi.useRealTimers();
    });

    it('每个会话上限淘汰', () => {
        const baseTime = Date.now();
        for (let i = 0; i <= 100; i++) {
            cacheInboundDownloadCode(
                'default',
                'conv_same',
                `msg_${i}`,
                `code_${i}`,
                'file',
                baseTime + i,
                { storePath },
            );
        }

        expect(getCachedDownloadCode('default', 'conv_same', 'msg_100', storePath)).not.toBeNull();
        expect(getCachedDownloadCode('default', 'conv_same', 'msg_100', storePath)!.downloadCode).toBe(
            'code_100',
        );

        expect(getCachedDownloadCode('default', 'conv_same', 'msg_0', storePath)).toBeNull();
    });

    it('全局会话上限淘汰', () => {
        const baseTime = Date.now();
        for (let i = 0; i <= 1000; i++) {
            cacheInboundDownloadCode(
                'default',
                `conv_${i}`,
                'msg1',
                `code_${i}`,
                'file',
                baseTime + i,
                { storePath },
            );
        }

        expect(getCachedDownloadCode('default', 'conv_1000', 'msg1', storePath)).not.toBeNull();
        expect(getCachedDownloadCode('default', 'conv_1000', 'msg1', storePath)!.downloadCode).toBe(
            'code_1000',
        );

        clearQuotedMsgCacheForTest();
        expect(getCachedDownloadCode('default', 'conv_0', 'msg1', storePath)!.downloadCode).toBe('code_0');
    });

    it('容量已满时仍可从持久化恢复新会话数据', () => {
        const baseTime = Date.now();

        cacheInboundDownloadCode('default', 'conv_persisted', 'msg_persisted', 'code_persisted', 'file', baseTime, {
            storePath,
        });

        clearQuotedMsgCacheForTest();

        for (let i = 0; i < 1000; i++) {
            cacheInboundDownloadCode('default', `conv_${i}`, 'msg1', `code_${i}`, 'file', baseTime + i + 1, {
                storePath,
            });
        }

        const restored = getCachedDownloadCode('default', 'conv_persisted', 'msg_persisted', storePath);
        expect(restored).not.toBeNull();
        expect(restored!.downloadCode).toBe('code_persisted');
    });

    it('持久化后可在重启后恢复读取', () => {
        const accountId = 'default';
        const conversationId = 'conv_persist';
        const msgId = 'msg_1';

        cacheInboundDownloadCode(
            accountId,
            conversationId,
            msgId,
            'dl_code_persist',
            'file',
            Date.now(),
            { storePath, spaceId: 'space_1', fileId: 'file_1' },
        );

        const persistedFile = resolveNamespacePath('quoted.msg-download-code', {
            storePath,
            scope: { accountId, conversationId },
            format: 'json',
        });
        expect(fs.existsSync(persistedFile)).toBe(true);

        clearQuotedMsgCacheForTest();

        const restored = getCachedDownloadCode(accountId, conversationId, msgId, storePath);
        expect(restored).not.toBeNull();
        expect(restored!.downloadCode).toBe('dl_code_persist');
        expect(restored!.spaceId).toBe('space_1');
        expect(restored!.fileId).toBe('file_1');
    });
});
