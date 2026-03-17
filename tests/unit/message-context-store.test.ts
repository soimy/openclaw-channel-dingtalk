import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    cleanupExpiredMessageContexts,
    clearMessageContextCacheForTest,
    resolveByAlias,
    resolveByCreatedAtWindow,
    resolveQuotedCardByProcessQueryKey,
    resolveQuotedMediaByMsgId,
    resolveQuotedTextByMsgId,
    upsertInboundMessageContext,
    upsertOutboundMessageContext,
} from '../../src/message-context-store';

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

        expect(resolveQuotedTextByMsgId({
            storePath,
            accountId: 'main',
            conversationId: 'cid_1',
            msgId: 'msg_in_1',
        })?.text).toBe('hello');

        expect(resolveQuotedMediaByMsgId({
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

        expect(resolveQuotedCardByProcessQueryKey({
            storePath,
            accountId: 'main',
            conversationId: 'cid_2',
            processQueryKey: 'carrier_1',
        })).toBe('card content');

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
        expect(resolveQuotedCardByProcessQueryKey({
            storePath,
            accountId: 'main',
            conversationId: 'cid_3',
            processQueryKey: 'carrier_expire',
            nowMs: 5001,
        })).toBeNull();
    });
});
