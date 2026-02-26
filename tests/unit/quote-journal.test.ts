import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    appendQuoteJournalEntry,
    cleanupExpiredQuoteJournalEntries,
    resolveQuotedMessageById,
} from '../../src/quote-journal';

describe('quote-journal', () => {
    let tmpDir: string;
    const storePathInTemp = () => path.join(tmpDir, 'sessions.json');

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dingtalk-quote-journal-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('resolves quoted message content by originalMsgId in same account and conversation', async () => {
        await appendQuoteJournalEntry({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            msgId: 'msg_1',
            messageType: 'text',
            text: 'hello original',
            createdAt: Date.now(),
        });

        const hit = await resolveQuotedMessageById({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            originalMsgId: 'msg_1',
        });

        expect(hit).toBeTruthy();
        expect(hit?.msgId).toBe('msg_1');
        expect(hit?.text).toBe('hello original');
    });

    it('does not return expired records when ttlDays is exceeded', async () => {
        const oldTs = Date.now() - 3 * 24 * 60 * 60 * 1000;
        await appendQuoteJournalEntry({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            msgId: 'msg_old',
            messageType: 'text',
            text: 'too old',
            createdAt: oldTs,
        });

        const hit = await resolveQuotedMessageById({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            originalMsgId: 'msg_old',
            ttlDays: 1,
            nowMs: Date.now(),
        });

        expect(hit).toBeNull();
    });

    it('cleanupExpiredQuoteJournalEntries removes only expired entries', async () => {
        const nowMs = Date.now();
        await appendQuoteJournalEntry({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            msgId: 'msg_old',
            messageType: 'text',
            text: 'old entry',
            createdAt: nowMs - 4 * 24 * 60 * 60 * 1000,
        });
        await appendQuoteJournalEntry({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            msgId: 'msg_new',
            messageType: 'text',
            text: 'new entry',
            createdAt: nowMs - 2 * 60 * 1000,
        });

        const removed = await cleanupExpiredQuoteJournalEntries({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            ttlDays: 1,
            nowMs,
        });

        expect(removed).toBe(1);
        const oldHit = await resolveQuotedMessageById({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            originalMsgId: 'msg_old',
            ttlDays: 7,
            nowMs,
        });
        const newHit = await resolveQuotedMessageById({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            originalMsgId: 'msg_new',
            ttlDays: 7,
            nowMs,
        });
        expect(oldHit).toBeNull();
        expect(newHit?.text).toBe('new entry');
    });

    it('appendQuoteJournalEntry performs cleanup when ttlDays is provided', async () => {
        const nowMs = Date.now();
        await appendQuoteJournalEntry({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            msgId: 'msg_old',
            messageType: 'text',
            text: 'old entry',
            createdAt: nowMs - 3 * 24 * 60 * 60 * 1000,
        });

        await appendQuoteJournalEntry({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            msgId: 'msg_new',
            messageType: 'text',
            text: 'new entry',
            createdAt: nowMs,
            ttlDays: 1,
            nowMs,
        });

        const oldHit = await resolveQuotedMessageById({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            originalMsgId: 'msg_old',
            ttlDays: 7,
            nowMs,
        });
        const newHit = await resolveQuotedMessageById({
            storePath: storePathInTemp(),
            accountId: 'main',
            conversationId: 'cid_1',
            originalMsgId: 'msg_new',
            ttlDays: 7,
            nowMs,
        });

        expect(oldHit).toBeNull();
        expect(newHit?.text).toBe('new entry');
    });
});
