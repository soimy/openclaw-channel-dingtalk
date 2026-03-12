import { readNamespaceJson, withNamespaceFileLock, writeNamespaceJsonAtomic } from "./persistence-store";

const GROUP_HISTORY_NAMESPACE = "group.recent-history";
const CONVERSATION_HISTORY_INDEX_NAMESPACE = "conversation.history-index";
const MAX_HISTORY_ENTRIES = 200;
const ROLLUP_CHUNK_SIZE = 20;
// TODO: migrate to an upstream history API once OpenClaw exposes a unified
// recent-window + rollup-summary interface for channel integrations.
const MAX_SUMMARY_SEGMENTS = 90;
const MAX_SEGMENT_CHARS = 1600;

export interface GroupHistoryEntry {
  sender: string;
  senderId?: string;
  mentions?: string[];
  body: string;
  timestamp?: number;
  messageId?: string;
  quotedMessageId?: string;
  quotedPreview?: string;
}

export interface ConversationHistoryIndexEntry {
  conversationId: string;
  chatType: "direct" | "group";
  title?: string;
  updatedAt: number;
}

export interface ConversationHistoryQuery {
  storePath?: string;
  accountId: string;
  chatType?: "direct" | "group";
  conversationIds?: string[];
  senderIds?: string[];
  mentionNames?: string[];
  sinceTs?: number;
  recentLimitPerConversation?: number;
}

export interface ConversationHistorySlice {
  conversation: ConversationHistoryIndexEntry;
  recentEntries: GroupHistoryEntry[];
  summarySegments: GroupHistorySummarySegment[];
}

export interface GroupHistorySummarySegment {
  id: string;
  fromTs: number;
  toTs: number;
  createdAt: number;
  messageCount: number;
  summary: string;
}

interface PersistedGroupHistory {
  updatedAt: number;
  entries: GroupHistoryEntry[];
  summarySegments?: GroupHistorySummarySegment[];
}

interface ConversationHistoryIndexBucket {
  updatedAt: number;
  conversations: Record<string, ConversationHistoryIndexEntry>;
}

function normalizeEntry(entry: GroupHistoryEntry): GroupHistoryEntry | null {
  const sender = entry.sender.trim();
  const body = entry.body.trim();
  if (!sender || !body) {
    return null;
  }
  return {
    sender,
    senderId:
      typeof entry.senderId === "string" && entry.senderId.trim() ? entry.senderId.trim() : undefined,
    mentions: Array.isArray(entry.mentions)
      ? [...new Set(entry.mentions.map((item) => item.trim().toLowerCase()).filter(Boolean))]
      : undefined,
    body,
    timestamp: typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp) ? entry.timestamp : undefined,
    messageId: typeof entry.messageId === "string" && entry.messageId.trim() ? entry.messageId.trim() : undefined,
    quotedMessageId:
      typeof entry.quotedMessageId === "string" && entry.quotedMessageId.trim()
        ? entry.quotedMessageId.trim()
        : undefined,
    quotedPreview:
      typeof entry.quotedPreview === "string" && entry.quotedPreview.trim()
        ? entry.quotedPreview.trim()
        : undefined,
  };
}

function loadHistory(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
}): PersistedGroupHistory {
  if (!params.storePath) {
    return { updatedAt: 0, entries: [] };
  }
  const persisted = readNamespaceJson<PersistedGroupHistory>(GROUP_HISTORY_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId, conversationId: params.conversationId },
    format: "json",
    fallback: { updatedAt: 0, entries: [] },
  });
  return {
    updatedAt: typeof persisted.updatedAt === "number" ? persisted.updatedAt : 0,
    entries: Array.isArray(persisted.entries)
      ? persisted.entries
          .map((entry) => normalizeEntry(entry))
          .filter((entry): entry is GroupHistoryEntry => Boolean(entry))
      : [],
    summarySegments: Array.isArray(persisted.summarySegments)
      ? persisted.summarySegments.filter((segment) =>
          Boolean(
            segment &&
              typeof segment.id === "string" &&
              typeof segment.fromTs === "number" &&
              Number.isFinite(segment.fromTs) &&
              typeof segment.toTs === "number" &&
              Number.isFinite(segment.toTs) &&
              typeof segment.createdAt === "number" &&
              Number.isFinite(segment.createdAt) &&
              typeof segment.messageCount === "number" &&
              Number.isFinite(segment.messageCount) &&
              typeof segment.summary === "string" &&
              segment.summary.trim(),
          ),
        )
      : [],
  };
}

function writeHistory(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
  entries: GroupHistoryEntry[];
  summarySegments?: GroupHistorySummarySegment[];
}): void {
  if (!params.storePath) {
    return;
  }
  writeNamespaceJsonAtomic(GROUP_HISTORY_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId, conversationId: params.conversationId },
    format: "json",
    data: {
      updatedAt: Date.now(),
      entries: params.entries,
      summarySegments: params.summarySegments ?? [],
    } satisfies PersistedGroupHistory,
  });
}

function summarizeEntries(entries: GroupHistoryEntry[]): GroupHistorySummarySegment | null {
  if (entries.length === 0) {
    return null;
  }
  const createdAt = Date.now();
  const timestamps = entries
    .map((entry) => entry.timestamp)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const fromTs = timestamps.length > 0 ? Math.min(...timestamps) : createdAt;
  const toTs = timestamps.length > 0 ? Math.max(...timestamps) : createdAt;
  const lines: string[] = [];
  let usedChars = 0;
  for (const entry of entries) {
    const ts = entry.timestamp ? new Date(entry.timestamp).toISOString() : "unknown-time";
    const quoteSuffix = entry.quotedPreview
      ? ` [replying to: ${entry.quotedPreview}]`
      : entry.quotedMessageId
        ? ` [replying to msg:${entry.quotedMessageId}]`
        : "";
    const line = `[${ts}] ${entry.sender}: ${entry.body}${quoteSuffix}`;
    const next = line.length + (lines.length > 0 ? 1 : 0);
    if (usedChars + next > MAX_SEGMENT_CHARS) {
      lines.push("...");
      break;
    }
    lines.push(line);
    usedChars += next;
  }
  return {
    id: `segment_${createdAt}_${Math.random().toString(36).slice(2, 8)}`,
    fromTs,
    toTs,
    createdAt,
    messageCount: entries.length,
    summary: lines.join("\n"),
  };
}

function rollupEntriesToLimit(
  entries: GroupHistoryEntry[],
  segments: GroupHistorySummarySegment[],
  retainLimit: number,
): {
  entries: GroupHistoryEntry[];
  summarySegments: GroupHistorySummarySegment[];
} {
  let nextEntries = entries;
  let nextSegments = segments;
  while (nextEntries.length > retainLimit) {
    const chunk = nextEntries.slice(0, ROLLUP_CHUNK_SIZE);
    nextEntries = nextEntries.slice(ROLLUP_CHUNK_SIZE);
    const segment = summarizeEntries(chunk);
    if (segment) {
      nextSegments = [...nextSegments, segment].slice(-MAX_SUMMARY_SEGMENTS);
    }
  }
  return { entries: nextEntries, summarySegments: nextSegments };
}

export function listRecentGroupHistory(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
  limit: number;
}): GroupHistoryEntry[] {
  if (params.limit <= 0) {
    return [];
  }
  return loadHistory(params).entries.slice(-Math.min(params.limit, MAX_HISTORY_ENTRIES));
}

export function listGroupHistorySummarySegments(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
  sinceTs?: number;
}): GroupHistorySummarySegment[] {
  const persisted = loadHistory(params);
  const sinceTs =
    typeof params.sinceTs === "number" && Number.isFinite(params.sinceTs) ? params.sinceTs : undefined;
  if (sinceTs === undefined) {
    return persisted.summarySegments ?? [];
  }
  return (persisted.summarySegments ?? []).filter((segment) => segment.toTs >= sinceTs);
}

export function upsertConversationHistoryIndex(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
  chatType: "direct" | "group";
  title?: string;
}): void {
  const storePath = params.storePath;
  if (!storePath) {
    return;
  }
  withNamespaceFileLock(CONVERSATION_HISTORY_INDEX_NAMESPACE, {
    storePath,
    scope: { accountId: params.accountId },
    format: "json",
  }, () => {
    const bucket = readNamespaceJson<ConversationHistoryIndexBucket>(CONVERSATION_HISTORY_INDEX_NAMESPACE, {
      storePath,
      scope: { accountId: params.accountId },
      format: "json",
      fallback: { updatedAt: 0, conversations: {} },
    });
    bucket.conversations[params.conversationId] = {
      conversationId: params.conversationId,
      chatType: params.chatType,
      title: params.title?.trim() || undefined,
      updatedAt: Date.now(),
    };
    writeNamespaceJsonAtomic(CONVERSATION_HISTORY_INDEX_NAMESPACE, {
      storePath,
      scope: { accountId: params.accountId },
      format: "json",
      data: {
        updatedAt: Date.now(),
        conversations: bucket.conversations,
      } satisfies ConversationHistoryIndexBucket,
    });
  });
}

export function listConversationHistoryIndex(params: {
  storePath?: string;
  accountId: string;
  chatType?: "direct" | "group";
}): ConversationHistoryIndexEntry[] {
  if (!params.storePath) {
    return [];
  }
  const bucket = readNamespaceJson<ConversationHistoryIndexBucket>(CONVERSATION_HISTORY_INDEX_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId },
    format: "json",
    fallback: { updatedAt: 0, conversations: {} },
  });
  return Object.values(bucket.conversations)
    .filter((entry) => (params.chatType ? entry.chatType === params.chatType : true))
    .toSorted((left, right) => right.updatedAt - left.updatedAt);
}

export function queryConversationHistory(params: ConversationHistoryQuery): ConversationHistorySlice[] {
  const conversationIdSet =
    params.conversationIds && params.conversationIds.length > 0
      ? new Set(params.conversationIds.map((id) => id.trim()).filter(Boolean))
      : undefined;
  const senderIdSet =
    params.senderIds && params.senderIds.length > 0
      ? new Set(params.senderIds.map((id) => id.trim()).filter(Boolean))
      : undefined;
  const mentionNameSet =
    params.mentionNames && params.mentionNames.length > 0
      ? new Set(params.mentionNames.map((name) => name.trim().toLowerCase()).filter(Boolean))
      : undefined;
  const recentLimit = Math.max(1, params.recentLimitPerConversation ?? 20);
  const requirePreciseRecentFiltering =
    Boolean(senderIdSet && senderIdSet.size > 0)
    || Boolean(mentionNameSet && mentionNameSet.size > 0)
    || typeof params.sinceTs === "number";
  return listConversationHistoryIndex({
    storePath: params.storePath,
    accountId: params.accountId,
    chatType: params.chatType,
  })
    .filter((conversation) => (conversationIdSet ? conversationIdSet.has(conversation.conversationId) : true))
    .map((conversation) => {
      const candidateEntries = listRecentGroupHistory({
        storePath: params.storePath,
        accountId: params.accountId,
        conversationId: conversation.conversationId,
        limit: requirePreciseRecentFiltering ? MAX_HISTORY_ENTRIES : recentLimit,
      });
      const recentEntries = candidateEntries.filter((entry) => {
        const matchesTime =
          typeof params.sinceTs === "number" && Number.isFinite(params.sinceTs)
            ? (entry.timestamp ?? 0) >= params.sinceTs
            : true;
        const matchesSender = senderIdSet
          ? Boolean(entry.senderId && senderIdSet.has(entry.senderId))
          : true;
        const matchesMention = mentionNameSet
          ? Boolean(entry.mentions?.some((mention) => mentionNameSet.has(mention)))
          : true;
        return matchesTime && matchesSender && matchesMention;
      }).slice(-recentLimit);
      const summarySegments =
        senderIdSet || mentionNameSet
          ? []
          : listGroupHistorySummarySegments({
        storePath: params.storePath,
        accountId: params.accountId,
        conversationId: conversation.conversationId,
        sinceTs: params.sinceTs,
      });
      return {
        conversation,
        recentEntries,
        summarySegments,
      } satisfies ConversationHistorySlice;
    })
    .filter((slice) => slice.recentEntries.length > 0 || slice.summarySegments.length > 0);
}

export function appendRecentGroupHistoryEntry(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
  limit: number;
  entry: GroupHistoryEntry;
}): void {
  const storePath = params.storePath;
  if (!storePath || params.limit <= 0) {
    return;
  }
  const normalized = normalizeEntry(params.entry);
  if (!normalized) {
    return;
  }
  withNamespaceFileLock(GROUP_HISTORY_NAMESPACE, {
    storePath,
    scope: { accountId: params.accountId, conversationId: params.conversationId },
    format: "json",
  }, () => {
    const persisted = loadHistory({ ...params, storePath });
    const retainLimit = Math.max(1, Math.min(params.limit, MAX_HISTORY_ENTRIES));
    const maxBufferedEntries = Math.min(MAX_HISTORY_ENTRIES + ROLLUP_CHUNK_SIZE, retainLimit + ROLLUP_CHUNK_SIZE);
    const nextEntries = [...persisted.entries, normalized].slice(-maxBufferedEntries);
    const rolled = rollupEntriesToLimit(nextEntries, persisted.summarySegments ?? [], retainLimit);
    writeHistory({
      storePath,
      accountId: params.accountId,
      conversationId: params.conversationId,
      entries: rolled.entries,
      summarySegments: rolled.summarySegments,
    });
  });
}
