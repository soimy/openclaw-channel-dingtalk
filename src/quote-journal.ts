import * as fs from "node:fs/promises";
import * as path from "node:path";

type JournalEntry = {
  msgId: string;
  messageType: string;
  text?: string;
  createdAt: number;
};

function getJournalFilePath(params: { storePath: string; accountId: string; conversationId?: string | null }) {
  const baseDir = path.dirname(params.storePath);
  const acc = (params.accountId || "default").trim() || "default";
  const file = `${(params.conversationId || "unknown").trim() || "unknown"}.jsonl`;
  const dir = path.join(baseDir, "dingtalk-quote-journal", acc);
  return { dir, filePath: path.join(dir, file) };
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function readAllEntries(filePath: string): Promise<JournalEntry[]> {
  try {
    const buf = await fs.readFile(filePath, "utf8");
    const lines = buf.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const out: JournalEntry[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.msgId === "string" && typeof obj.createdAt === "number") {
          out.push({
            msgId: obj.msgId,
            messageType: obj.messageType || "text",
            text: typeof obj.text === "string" ? obj.text : undefined,
            createdAt: obj.createdAt,
          });
        }
      } catch {
        // skip bad line
      }
    }
    return out;
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function writeAllEntries(filePath: string, entries: JournalEntry[]): Promise<void> {
  const tmp = `${filePath}.tmp`;
  const data = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, filePath);
}

export async function appendQuoteJournalEntry(params: {
  storePath: string;
  accountId: string;
  conversationId: string | null;
  msgId: string;
  messageType: string;
  text?: string;
  createdAt: number;
  ttlDays?: number;
  nowMs?: number;
}): Promise<void> {
  const { dir, filePath } = getJournalFilePath(params);
  await ensureDir(dir);
  let entries = await readAllEntries(filePath);
  const now = params.nowMs ?? Date.now();
  if (params.ttlDays && params.ttlDays > 0) {
    const cutoff = now - params.ttlDays * 24 * 60 * 60 * 1000;
    entries = entries.filter((e) => e.createdAt >= cutoff);
  }
  entries.push({
    msgId: params.msgId,
    messageType: params.messageType,
    text: params.text,
    createdAt: params.createdAt,
  });
  await writeAllEntries(filePath, entries);
}

export async function cleanupExpiredQuoteJournalEntries(params: {
  storePath: string;
  accountId: string;
  conversationId: string | null;
  ttlDays: number;
  nowMs?: number;
}): Promise<number> {
  const { dir, filePath } = getJournalFilePath(params);
  await ensureDir(dir);
  const entries = await readAllEntries(filePath);
  const now = params.nowMs ?? Date.now();
  const cutoff = now - params.ttlDays * 24 * 60 * 60 * 1000;
  const kept = entries.filter((e) => e.createdAt >= cutoff);
  const removed = entries.length - kept.length;
  if (removed > 0) {
    await writeAllEntries(filePath, kept);
  }
  return removed;
}

export async function resolveQuotedMessageById(params: {
  storePath: string;
  accountId: string;
  conversationId: string | null;
  originalMsgId: string;
  ttlDays?: number;
  nowMs?: number;
}): Promise<{ msgId: string; text?: string; createdAt: number } | null> {
  const { filePath } = getJournalFilePath(params);
  const entries = await readAllEntries(filePath);
  const now = params.nowMs ?? Date.now();
  const cutoff = params.ttlDays && params.ttlDays > 0 ? now - params.ttlDays * 24 * 60 * 60 * 1000 : -Infinity;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.createdAt < cutoff) {
      continue;
    }
    if (e.msgId === params.originalMsgId) {
      return { msgId: e.msgId, text: e.text, createdAt: e.createdAt };
    }
  }
  return null;
}

// Outbound journaling helpers (not used in J1 tests, provided for future steps)
export async function appendOutboundToQuoteJournal(params: {
  storePath: string;
  accountId: string;
  conversationId: string | null;
  messageId?: string;
  text?: string;
  messageType?: string;
  log?: any;
}): Promise<void> {
  try {
    if (!params.messageId) {
      return;
    }
    await appendQuoteJournalEntry({
      storePath: params.storePath,
      accountId: params.accountId,
      conversationId: params.conversationId || null,
      msgId: params.messageId,
      messageType: params.messageType || "outbound",
      text: params.text,
      createdAt: Date.now(),
    });
  } catch (err) {
    params.log?.debug?.(`[quote-journal] appendOutbound failed: ${String(err)}`);
  }
}

export async function appendProactiveOutboundJournal(params: {
  storePath: string;
  accountId: string;
  conversationId: string | null;
  messageId?: string;
  text?: string;
  messageType?: string;
  log?: any;
}): Promise<void> {
  return appendOutboundToQuoteJournal(params);
}
