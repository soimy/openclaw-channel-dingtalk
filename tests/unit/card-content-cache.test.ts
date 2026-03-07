import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    cacheCardContent,
    clearCardContentCacheForTest,
    findCardContent,
} from '../../src/card-service';
import { resolveNamespacePath } from '../../src/persistence-store';

describe('card-content-cache', () => {
    let tempDir = '';
    let storePath = '';

    beforeEach(() => {
        clearCardContentCacheForTest();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-card-content-cache-'));
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

    it('基本读写（±2秒时间匹配）', () => {
        cacheCardContent('default', 'conv1', '机器人回复内容', 1000000);

        expect(findCardContent('default', 'conv1', 1000100)).toBe('机器人回复内容');

        expect(findCardContent('default', 'conv1', 1005000)).toBeNull();

        expect(findCardContent('default', 'conv_other', 1000100)).toBeNull();
    });

    it('TTL 过期后返回 null', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000000);

        cacheCardContent('default', 'conv1', '内容', 1000000);
        expect(findCardContent('default', 'conv1', 1000000)).toBe('内容');

        vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

        expect(findCardContent('default', 'conv1', 1000000)).toBeNull();
    });

    it('每个会话上限（20 条）淘汰最早的', () => {
        const conversationId = 'conv_limit';
        for (let i = 1; i <= 21; i++) {
            cacheCardContent('default', conversationId, `content_${i}`, i * 4000);
        }

        expect(findCardContent('default', conversationId, 84000)).toBe('content_21');
        expect(findCardContent('default', conversationId, 4000)).toBeNull();
    });

    it('全局会话上限（500 个）淘汰最久未活跃的', () => {
        for (let i = 0; i <= 500; i++) {
            cacheCardContent('default', `conv_${i}`, `content_${i}`, 1000000 + i);
        }

        expect(findCardContent('default', 'conv_500', 1000500)).toBe('content_500');
        expect(findCardContent('default', 'conv_0', 1000000)).toBeNull();
    });

    it('容量已满时仍可从持久化恢复新会话内容', () => {
        cacheCardContent('default', 'conv_persisted', '持久化内容', 1000000, storePath);

        clearCardContentCacheForTest();

        for (let i = 0; i < 500; i++) {
            cacheCardContent('default', `conv_${i}`, `content_${i}`, 2000000 + i);
        }

        expect(findCardContent('default', 'conv_persisted', 1000500, storePath)).toBe('持久化内容');
    });

    it('单聊和群聊独立缓存', () => {
        cacheCardContent('default', 'dm_conv', '单聊内容', 1000000);
        cacheCardContent('default', 'group_conv', '群聊内容', 2000000);

        expect(findCardContent('default', 'dm_conv', 1000100)).toBe('单聊内容');
        expect(findCardContent('default', 'group_conv', 2000100)).toBe('群聊内容');
    });

    it('持久化后可在重启后恢复匹配', () => {
        const accountId = 'default';
        const conversationId = 'conv_persist';
        const createdAt = 1234567;

        cacheCardContent(accountId, conversationId, '持久化内容', createdAt, storePath);

        const persistedFile = resolveNamespacePath('cards.content.quote-lookup', {
            storePath,
            scope: { accountId, conversationId },
            format: 'json',
        });
        expect(fs.existsSync(persistedFile)).toBe(true);

        clearCardContentCacheForTest();

        const restored = findCardContent(accountId, conversationId, createdAt + 500, storePath);
        expect(restored).toBe('持久化内容');
    });
});
