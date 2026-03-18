import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    cleanupExpiredMessageContexts,
    clearMessageContextCacheForTest,
    createSyntheticOutboundMsgId,
    resolveByAlias,
    resolveByCreatedAtWindow,
    resolveByMsgId,
    upsertInboundMessageContext,
    upsertOutboundMessageContext,
} from '../../src/message-context-store';
import { resolveNamespacePath } from '../../src/persistence-store';

describe('message-context-store', () => {
    let tempDir = '';
    let storePath = '';

    beforeEach(() => {
        clearMessageContextCacheForTest();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-message-context-'));
        storePath = path.join(tempDir, 'session-store.json');
    });

    afterEach(() => {
        clearMessageContextCacheForTest();
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        tempDir = '';
        storePath = '';
    });

    it('stores inbound text and media on the same record', () => {
        const now = Date.now();

        upsertInboundMessageContext({
            storePath,
            accountId: 'main',
            conversationId: 'cid_1',
            msgId: 'msg_in_1',
            createdAt: now,
            messageType: 'text',
            text: 'hello',
            ttlMs: 60_000,
            topic: null,
        });

        upsertInboundMessageContext({
            storePath,
            accountId: 'main',
            conversationId: 'cid_1',
            msgId: 'msg_in_1',
            createdAt: now,
            messageType: 'file',
            media: { downloadCode: 'dl_1', spaceId: 'space_1', fileId: 'file_1' },
            ttlMs: 60_000,
            topic: null,
        });

        expect(resolveByMsgId({
            storePath,
            accountId: 'main',
            conversationId: 'cid_1',
            msgId: 'msg_in_1',
        })?.text).toBe('hello');

        expect(resolveByMsgId({
            storePath,
            accountId: 'main',
            conversationId: 'cid_1',
            msgId: 'msg_in_1',
        })?.media).toEqual({
            downloadCode: 'dl_1',
            spaceId: 'space_1',
            fileId: 'file_1',
        });
    });

    it('resolves outbound card content by processQueryKey alias and createdAt fallback', () => {
        upsertOutboundMessageContext({
            storePath,
            accountId: 'main',
            conversationId: 'cid_2',
            createdAt: 2000,
            messageType: 'card',
            text: 'card content',
            ttlMs: 60_000,
            topic: null,
            delivery: {
                processQueryKey: 'carrier_1',
                outTrackId: 'track_1',
                kind: 'proactive-card',
            },
        });

        expect(resolveByAlias({
            storePath,
            accountId: 'main',
            conversationId: 'cid_2',
            kind: 'processQueryKey',
            value: 'carrier_1',
        })?.text).toBe('card content');

        expect(resolveByAlias({
            storePath,
            accountId: 'main',
            conversationId: 'cid_2',
            kind: 'outTrackId',
            value: 'track_1',
        })?.text).toBe('card content');

        expect(resolveByCreatedAtWindow({
            storePath,
            accountId: 'main',
            conversationId: 'cid_2',
            createdAt: 2500,
            direction: 'outbound',
            windowMs: 1000,
        })?.text).toBe('card content');
    });

    it('cleans expired records and alias index together', () => {
        upsertOutboundMessageContext({
            storePath,
            accountId: 'main',
            conversationId: 'cid_3',
            createdAt: 3000,
            updatedAt: 3000,
            messageType: 'card',
            text: 'expire me',
            ttlMs: 1000,
            topic: null,
            delivery: {
                processQueryKey: 'carrier_expire',
                kind: 'proactive-card',
            },
        });

        const removed = cleanupExpiredMessageContexts({
            storePath,
            accountId: 'main',
            conversationId: 'cid_3',
            nowMs: 5001,
        });

        expect(removed).toBe(1);
        expect(resolveByAlias({
            storePath,
            accountId: 'main',
            conversationId: 'cid_3',
            kind: 'processQueryKey',
            value: 'carrier_expire',
            nowMs: 5001,
        })).toBeNull();
    });

    it('prunes by createdAt during inbound upsert in a single write path', () => {
        const nowMs = 2 * 24 * 60 * 60 * 1000;

        upsertInboundMessageContext({
            storePath,
            accountId: 'main',
            conversationId: 'cid_4',
            msgId: 'msg_clock_bound',
            createdAt: 1000,
            updatedAt: 1000,
            messageType: 'text',
            text: 'clock-safe',
            ttlMs: 10_000,
            topic: null,
        });
        upsertInboundMessageContext({
            storePath,
            accountId: 'main',
            conversationId: 'cid_4',
            msgId: 'msg_new',
            createdAt: nowMs,
            updatedAt: nowMs,
            messageType: 'text',
            text: 'fresh',
            ttlMs: 10_000,
            cleanupCreatedAtTtlDays: 1,
            topic: null,
        });

        expect(resolveByMsgId({
            storePath,
            accountId: 'main',
            conversationId: 'cid_4',
            msgId: 'msg_clock_bound',
            nowMs,
        })).toBeNull();
        expect(resolveByMsgId({
            storePath,
            accountId: 'main',
            conversationId: 'cid_4',
            msgId: 'msg_new',
            nowMs,
        })?.text).toBe('fresh');
    });

    it('creates collision-resistant synthetic ids for createdAt fallback records', () => {
        upsertOutboundMessageContext({
            storePath,
            accountId: 'main',
            conversationId: 'cid_5',
            msgId: createSyntheticOutboundMsgId(4000),
            createdAt: 4000,
            text: 'first',
            messageType: 'card',
            ttlMs: 60_000,
            topic: null,
        });

        clearMessageContextCacheForTest();

        upsertOutboundMessageContext({
            storePath,
            accountId: 'main',
            conversationId: 'cid_5',
            msgId: createSyntheticOutboundMsgId(4000),
            createdAt: 4000,
            text: 'second',
            messageType: 'card',
            ttlMs: 60_000,
            topic: null,
        });

        const persistedFile = resolveNamespacePath('messages.context', {
            storePath,
            scope: { accountId: 'main', conversationId: 'cid_5' },
            format: 'json',
        });
        const persisted = JSON.parse(fs.readFileSync(persistedFile, 'utf8'));

        expect(Object.keys(persisted.records)).toHaveLength(2);
        expect(Object.values(persisted.records).map((record: any) => record.text).sort()).toEqual([
            'first',
            'second',
        ]);
    });

    it('keeps no-storePath reads and writes in the unified in-memory state', () => {
        upsertInboundMessageContext({
            accountId: 'main',
            conversationId: 'cid_mem',
            msgId: 'msg_mem_1',
            createdAt: Date.now(),
            messageType: 'file',
            media: { downloadCode: 'dl_mem_1' },
            ttlMs: 60_000,
            topic: null,
        });

        expect(resolveByMsgId({
            accountId: 'main',
            conversationId: 'cid_mem',
            msgId: 'msg_mem_1',
        })?.media?.downloadCode).toBe('dl_mem_1');
    });
});
