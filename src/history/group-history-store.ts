import {
  listKnownMessageContextScopes,
  listMessageContexts,
  type MessageRecord,
} from "../message-context-store";
import {
  listKnownGroupTargets,
  listKnownUserTargets,
  resolveKnownConversationChatType,
} from "../targeting/target-directory-store";

const MAX_HISTORY_ENTRIES = 200;
const ROLLUP_CHUNK_SIZE = 20;
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
  historyRetainLimit?: number;
  recentLimitPerConversation?: number;
}

export interface GroupHistorySummarySegment {
  id: string;
  fromTs: number;
  toTs: number;
  createdAt: number;
  messageCount: number;
  summary: string;
}

export interface ConversationHistorySlice {
  conversation: ConversationHistoryIndexEntry;
  recentEntries: GroupHistoryEntry[];
  summarySegments: GroupHistorySummarySegment[];
}

function normalizeEntry(entry: GroupHistoryEntry): GroupHistoryEntry | null {
  const sender = entry.sender.trim();
  const body = entry.body.trim();
  if (!sender || !body) {
    return null;
  }
  return {
    sender,
    senderId: entry.senderId?.trim() || undefined,
    mentions: entry.mentions?.map((item) => item.trim().toLowerCase()).filter(Boolean),
    body,
    timestamp: entry.timestamp,
    messageId: entry.messageId?.trim() || undefined,
    quotedMessageId: entry.quotedMessageId?.trim() || undefined,
  };
}

function formatSender(record: MessageRecord): string {
  if (record.senderName && record.senderId) {
    return `${record.senderName} (${record.senderId})`;
  }
  if (record.senderName) {
    return record.senderName;
  }
  if (record.senderId) {
    return record.senderId;
  }
  return record.direction === "outbound" ? "OpenClaw (bot)" : "unknown-sender";
}

function toGroupHistoryEntry(record: MessageRecord): GroupHistoryEntry | null {
  return normalizeEntry({
    sender: formatSender(record),
    senderId: record.senderId,
    mentions: record.mentions,
    body: record.text || "",
    timestamp: record.createdAt,
    messageId: record.msgId,
    quotedMessageId: record.quotedMessageId,
  });
}

function listConversationSourceEntries(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
}): GroupHistoryEntry[] {
  return listMessageContexts(params)
    .map((record) => toGroupHistoryEntry(record))
    .filter((entry): entry is GroupHistoryEntry => Boolean(entry));
}

function listConversationCandidates(params: {
  storePath?: string;
  accountId: string;
  chatType?: "direct" | "group";
}): ConversationHistoryIndexEntry[] {
  const results: ConversationHistoryIndexEntry[] = [];
  if (!params.chatType || params.chatType === "group") {
    results.push(
      ...listKnownGroupTargets({
        storePath: params.storePath,
        accountId: params.accountId,
      }).map((entry) => ({
        conversationId: entry.conversationId,
        chatType: "group" as const,
        title: entry.currentTitle,
        updatedAt: entry.lastSeenAt,
      })),
    );
  }
  if (!params.chatType || params.chatType === "direct") {
    for (const entry of listKnownUserTargets({
      storePath: params.storePath,
      accountId: params.accountId,
    })) {
      for (const conversationId of entry.lastSeenInConversationIds) {
        results.push({
          conversationId,
          chatType: "direct",
          title: entry.currentDisplayName,
          updatedAt: entry.lastSeenAt,
        });
      }
    }
  }
  for (const scope of listKnownMessageContextScopes({
    storePath: params.storePath,
    accountId: params.accountId,
  })) {
    if (params.chatType && scope.chatType && params.chatType !== scope.chatType) {
      continue;
    }
    results.push({
      conversationId: scope.conversationId,
      chatType: scope.chatType || "direct",
      title: scope.conversationId,
      updatedAt: scope.updatedAt,
    });
  }
  return Object.values(
    results.reduce<Record<string, ConversationHistoryIndexEntry>>((acc, entry) => {
      const existing = acc[entry.conversationId];
      if (!existing || existing.updatedAt < entry.updatedAt) {
        acc[entry.conversationId] = entry;
      } else if (!existing.title && entry.title) {
        acc[entry.conversationId] = {
          ...existing,
          title: entry.title,
        };
      }
      return acc;
    }, {}),
  ).toSorted((left, right) => right.updatedAt - left.updatedAt);
}

function formatEntriesAsSegment(entries: GroupHistoryEntry[]): GroupHistorySummarySegment | null {
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
    const quoteSuffix = entry.quotedMessageId ? ` [replying to msg:${entry.quotedMessageId}]` : "";
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
    id: `${fromTs}:${toTs}:${entries.length}`,
    fromTs,
    toTs,
    createdAt,
    messageCount: entries.length,
    summary: lines.join("\n"),
  };
}

function rollupEntriesToLimit(entries: GroupHistoryEntry[], retainLimit: number): GroupHistorySummarySegment[] {
  // TODO: This is still a full in-memory rollup pass. If summary/history usage
  // grows on high-traffic conversations, switch to incremental rollup so append
  // paths do not repeatedly rescan the whole retained conversation slice.
  let remainingEntries = entries.slice();
  const nextSegments: GroupHistorySummarySegment[] = [];
  while (remainingEntries.length > retainLimit) {
    const chunk = remainingEntries.slice(0, ROLLUP_CHUNK_SIZE);
    remainingEntries = remainingEntries.slice(ROLLUP_CHUNK_SIZE);
    const segment = formatEntriesAsSegment(chunk);
    if (segment) {
      nextSegments.push(segment);
    }
  }
  return nextSegments.slice(-MAX_SUMMARY_SEGMENTS);
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
  const candidates = listConversationCandidates({
    storePath: params.storePath,
    accountId: params.accountId,
    chatType: params.chatType,
  });

  const fallbackCandidates = conversationIdSet
    ? [...conversationIdSet]
        .filter((conversationId) => !candidates.some((entry) => entry.conversationId === conversationId))
        .map((conversationId) => {
          const sourceEntries = listMessageContexts({
            storePath: params.storePath,
            accountId: params.accountId,
            conversationId,
          });
          const recordBackedChatType = sourceEntries
            .map((record) => record.chatType)
            .find((value): value is "direct" | "group" => value === "direct" || value === "group");
          return {
            conversationId,
            chatType:
              recordBackedChatType
              || resolveKnownConversationChatType({
                storePath: params.storePath,
                accountId: params.accountId,
                conversationId,
              })
              || params.chatType
              || "direct" as const,
            title: conversationId,
            updatedAt: sourceEntries.at(-1)?.updatedAt ?? 0,
          };
        })
    : [];

  return [...candidates, ...fallbackCandidates]
    .filter((conversation) => (conversationIdSet ? conversationIdSet.has(conversation.conversationId) : true))
    .map((conversation) => {
      const sourceEntries = listConversationSourceEntries({
        storePath: params.storePath,
        accountId: params.accountId,
        conversationId: conversation.conversationId,
      });
      const filteredEntries = sourceEntries.filter((entry) => {
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
      });
      const retainLimit = Math.max(1, Math.min(params.historyRetainLimit ?? MAX_HISTORY_ENTRIES, MAX_HISTORY_ENTRIES));
      const summarySegments =
        senderIdSet || mentionNameSet
          ? []
          : rollupEntriesToLimit(filteredEntries, retainLimit);
      return {
        conversation,
        recentEntries: filteredEntries.slice(-recentLimit),
        summarySegments,
      };
    })
    .filter((slice) => slice.recentEntries.length > 0 || slice.summarySegments.length > 0);
}
