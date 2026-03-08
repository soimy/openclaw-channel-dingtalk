import { readNamespaceJson, writeNamespaceJsonAtomic } from "./persistence-store";

const QUOTE_JOURNAL_NAMESPACE = "quoted.msg-journal";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES_PER_CONVERSATION = 100;

export interface QuoteJournalEntry {
  msgId: string;
  text: string;
  messageType: string;
  createdAt: number;
  expiresAt: number;
  mediaPath?: string;
  mediaType?: string;
}

interface PersistedQuoteJournal {
  updatedAt: number;
  entries: Record<string, QuoteJournalEntry>;
}

function isValidEntry(value: unknown): value is QuoteJournalEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<QuoteJournalEntry>;
  return (
    typeof entry.msgId === "string" &&
    entry.msgId.length > 0 &&
    typeof entry.text === "string" &&
    typeof entry.messageType === "string" &&
    entry.messageType.length > 0 &&
    typeof entry.createdAt === "number" &&
    Number.isFinite(entry.createdAt) &&
    typeof entry.expiresAt === "number" &&
    Number.isFinite(entry.expiresAt) &&
    (entry.mediaPath === undefined || typeof entry.mediaPath === "string") &&
    (entry.mediaType === undefined || typeof entry.mediaType === "string")
  );
}

function loadEntries(
  accountId: string,
  conversationId: string,
  storePath?: string,
): Record<string, QuoteJournalEntry> {
  if (!storePath) {
    return {};
  }
  const persisted = readNamespaceJson<PersistedQuoteJournal>(QUOTE_JOURNAL_NAMESPACE, {
    storePath,
    scope: { accountId, conversationId },
    format: "json",
    fallback: { updatedAt: 0, entries: {} },
  });

  const entries: Record<string, QuoteJournalEntry> = {};
  for (const [msgId, entry] of Object.entries(persisted.entries || {})) {
    if (isValidEntry(entry)) {
      entries[msgId] = entry;
    }
  }
  return entries;
}

function purgeExpiredEntries(entries: Record<string, QuoteJournalEntry>, nowMs: number): void {
  for (const [msgId, entry] of Object.entries(entries)) {
    if (nowMs >= entry.expiresAt) {
      delete entries[msgId];
    }
  }
}

function trimEntries(entries: Record<string, QuoteJournalEntry>): void {
  const sorted = Object.values(entries).sort((left, right) => right.createdAt - left.createdAt);
  for (const stale of sorted.slice(MAX_ENTRIES_PER_CONVERSATION)) {
    delete entries[stale.msgId];
  }
}

export function appendQuoteJournalEntry(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
  msgId: string;
  text: string;
  messageType: string;
  createdAt?: number;
  mediaPath?: string;
  mediaType?: string;
}): void {
  if (!params.storePath || !params.msgId.trim()) {
    return;
  }

  const nowMs = Date.now();
  const createdAt = params.createdAt && Number.isFinite(params.createdAt) ? params.createdAt : nowMs;
  const entries = loadEntries(params.accountId, params.conversationId, params.storePath);
  purgeExpiredEntries(entries, nowMs);
  entries[params.msgId] = {
    msgId: params.msgId,
    text: params.text,
    messageType: params.messageType,
    createdAt,
    expiresAt: nowMs + DEFAULT_TTL_MS,
    mediaPath: params.mediaPath,
    mediaType: params.mediaType,
  };
  trimEntries(entries);
  writeNamespaceJsonAtomic(QUOTE_JOURNAL_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId, conversationId: params.conversationId },
    format: "json",
    data: {
      updatedAt: nowMs,
      entries,
    } satisfies PersistedQuoteJournal,
  });
}

export function findQuoteJournalEntryByMsgId(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
  msgId?: string;
}): QuoteJournalEntry | null {
  if (!params.storePath || !params.msgId?.trim()) {
    return null;
  }

  const nowMs = Date.now();
  const entries = loadEntries(params.accountId, params.conversationId, params.storePath);
  purgeExpiredEntries(entries, nowMs);
  const entry = entries[params.msgId];
  if (!entry) {
    return null;
  }
  if (nowMs >= entry.expiresAt) {
    delete entries[params.msgId];
    writeNamespaceJsonAtomic(QUOTE_JOURNAL_NAMESPACE, {
      storePath: params.storePath,
      scope: { accountId: params.accountId, conversationId: params.conversationId },
      format: "json",
      data: {
        updatedAt: nowMs,
        entries,
      } satisfies PersistedQuoteJournal,
    });
    return null;
  }
  return entry;
}
