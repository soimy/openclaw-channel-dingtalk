import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendQuoteJournalEntry,
  cleanupExpiredQuoteJournalEntries,
  resolveQuotedMessageById,
} from '../../src/quote-journal';
import { resolveNamespacePath } from '../../src/persistence-store';

describe('quote-journal', () => {
  let tmpDir: string;
  const storePathInTemp = () => path.join(tmpDir, 'sessions.json');

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'dingtalk-quote-journal-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
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

  it('ignores legacy JSONL data and only reads persistence-backed journal state', async () => {
    const storePath = storePathInTemp();
    const legacyDir = path.join(path.dirname(storePath), 'dingtalk-quote-journal', 'main');
    const legacyPath = path.join(legacyDir, 'cid_1.jsonl');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      legacyPath,
      `${JSON.stringify({ msgId: 'legacy_1', messageType: 'text', text: 'legacy text', createdAt: 12345 })}\n`,
      'utf8',
    );

    const hit = await resolveQuotedMessageById({
      storePath,
      accountId: 'main',
      conversationId: 'cid_1',
      originalMsgId: 'legacy_1',
      ttlDays: 7,
      nowMs: 12345,
    });

    expect(hit).toBeNull();

    const persistedFile = resolveNamespacePath('quoted.msg-journal', {
      storePath,
      scope: { accountId: 'main', conversationId: 'cid_1' },
      format: 'json',
    });
    expect(fs.existsSync(persistedFile)).toBe(false);
  });

  it('caps journal records per scope and evicts oldest entries', async () => {
    const storePath = storePathInTemp();
    const baseNow = 2_000_000;

    for (let i = 0; i < 1005; i++) {
      await appendQuoteJournalEntry({
        storePath,
        accountId: 'main',
        conversationId: 'cid_1',
        msgId: `msg_${i}`,
        messageType: 'text',
        text: `text_${i}`,
        createdAt: baseNow + i,
        nowMs: baseNow + i,
      });
    }

    const oldest = await resolveQuotedMessageById({
      storePath,
      accountId: 'main',
      conversationId: 'cid_1',
      originalMsgId: 'msg_0',
      ttlDays: 7,
      nowMs: baseNow + 1005,
    });

    const newest = await resolveQuotedMessageById({
      storePath,
      accountId: 'main',
      conversationId: 'cid_1',
      originalMsgId: 'msg_1004',
      ttlDays: 7,
      nowMs: baseNow + 1005,
    });

    expect(oldest).toBeNull();
    expect(newest?.text).toBe('text_1004');
  });
});
