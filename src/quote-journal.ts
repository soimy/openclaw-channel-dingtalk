import fs from "node:fs/promises";
import path from "node:path";

export interface QuoteJournalEntry {
  ts: number;
  accountId: string;
  conversationId: string;
  msgId: string;
  messageType: string;
  text: string;
  mediaPath?: string;
  mediaType?: string;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function journalFilePath(storePath: string, accountId: string, conversationId: string): string {
  const sessionsDir = path.dirname(storePath);
  return path.join(
    sessionsDir,
    "dingtalk-quote-journal",
    accountId,
    `${sanitizeFileName(conversationId)}.jsonl`,
  );
}

function parseLine(line: string): QuoteJournalEntry | null {
  try {
    const parsed = JSON.parse(line) as QuoteJournalEntry;
    if (
      typeof parsed.ts !== "number" ||
      typeof parsed.accountId !== "string" ||
      typeof parsed.conversationId !== "string" ||
      typeof parsed.msgId !== "string" ||
      typeof parsed.messageType !== "string" ||
      typeof parsed.text !== "string"
    ) {
      return null;
    }
    if (parsed.mediaPath !== undefined && typeof parsed.mediaPath !== "string") {
      return null;
    }
    if (parsed.mediaType !== undefined && typeof parsed.mediaType !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function appendQuoteJournalEntry(params: {
  storePath: string;
  accountId: string;
  conversationId: string;
  msgId: string;
  messageType: string;
  text: string;
  mediaPath?: string;
  mediaType?: string;
  createdAt?: number;
}): Promise<void> {
  const file = journalFilePath(params.storePath, params.accountId, params.conversationId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const entry: QuoteJournalEntry = {
    ts: params.createdAt ?? Date.now(),
    accountId: params.accountId,
    conversationId: params.conversationId,
    msgId: params.msgId,
    messageType: params.messageType,
    text: params.text,
    mediaPath: params.mediaPath,
    mediaType: params.mediaType,
  };
  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

export async function findQuoteJournalEntryByMsgId(params: {
  storePath: string;
  accountId: string;
  conversationId: string;
  msgId: string;
}): Promise<QuoteJournalEntry | null> {
  const file = journalFilePath(params.storePath, params.accountId, params.conversationId);
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter(Boolean).reverse();
  for (const line of lines) {
    const entry = parseLine(line);
    if (entry && entry.msgId === params.msgId) {
      return entry;
    }
  }
  return null;
}
