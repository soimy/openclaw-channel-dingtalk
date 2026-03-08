import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findQuoteJournalEntryByMsgId, appendQuoteJournalEntry } from "../../src/quote-journal";

const tempDirs: string[] = [];

function createStorePath(): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-quote-journal-"));
  tempDirs.push(rootDir);
  return path.join(rootDir, "session", "store.json");
}

describe("quote-journal", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const rootDir = tempDirs.pop();
      if (rootDir) {
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
    }
  });

  it("persists and restores journal entries by msgId", () => {
    const storePath = createStorePath();

    appendQuoteJournalEntry({
      storePath,
      accountId: "main",
      conversationId: "cidA1B2C3",
      msgId: "msg_quoted_1",
      text: "原始消息正文",
      messageType: "text",
      createdAt: 1000,
    });

    const restored = findQuoteJournalEntryByMsgId({
      storePath,
      accountId: "main",
      conversationId: "cidA1B2C3",
      msgId: "msg_quoted_1",
    });

    expect(restored).toMatchObject({
      msgId: "msg_quoted_1",
      text: "原始消息正文",
      messageType: "text",
      createdAt: 1000,
    });
  });
});
