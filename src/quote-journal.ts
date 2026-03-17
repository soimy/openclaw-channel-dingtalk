import {
  cleanupMessageContextsByCreatedAt,
  DEFAULT_MESSAGE_CONTEXT_TTL_DAYS,
  type MessageDeliveryKind,
  upsertInboundMessageContext,
  upsertOutboundMessageContext,
  resolveQuotedTextByMsgId,
} from "./message-context-store";

export const DEFAULT_JOURNAL_TTL_DAYS = DEFAULT_MESSAGE_CONTEXT_TTL_DAYS;

function ttlDaysToMs(ttlDays: number | undefined): number | undefined {
  if (typeof ttlDays !== "number" || !Number.isFinite(ttlDays) || ttlDays <= 0) {
    return undefined;
  }
  return ttlDays * 24 * 60 * 60 * 1000;
}

export function appendQuoteJournalEntry(params: {
  storePath: string;
  accountId: string;
  conversationId: string | null;
  msgId: string;
  messageType: string;
  text?: string;
  createdAt: number;
  ttlDays?: number;
  nowMs?: number;
}): void {
  const ttlDays = params.ttlDays ?? DEFAULT_JOURNAL_TTL_DAYS;
  cleanupMessageContextsByCreatedAt({
    storePath: params.storePath,
    accountId: params.accountId,
    conversationId: params.conversationId,
    ttlDays,
    nowMs: params.nowMs,
  });
  upsertInboundMessageContext({
    storePath: params.storePath,
    accountId: params.accountId,
    conversationId: params.conversationId,
    msgId: params.msgId,
    messageType: params.messageType,
    text: params.text,
    createdAt: params.createdAt,
    updatedAt: params.nowMs,
    ttlMs: ttlDaysToMs(ttlDays),
    ttlReferenceMs: params.createdAt,
    topic: null,
  });
}

export function cleanupExpiredQuoteJournalEntries(params: {
  storePath: string;
  accountId: string;
  conversationId: string | null;
  ttlDays: number;
  nowMs?: number;
}): number {
  return cleanupMessageContextsByCreatedAt({
    storePath: params.storePath,
    accountId: params.accountId,
    conversationId: params.conversationId,
    ttlDays: params.ttlDays,
    nowMs: params.nowMs,
  });
}

export function resolveQuotedMessageById(params: {
  storePath: string;
  accountId: string;
  conversationId: string | null;
  originalMsgId: string;
  ttlDays?: number;
  nowMs?: number;
}): { msgId: string; text?: string; createdAt: number } | null {
  return resolveQuotedTextByMsgId({
    storePath: params.storePath,
    accountId: params.accountId,
    conversationId: params.conversationId,
    msgId: params.originalMsgId,
    ttlDays: params.ttlDays ?? DEFAULT_JOURNAL_TTL_DAYS,
    nowMs: params.nowMs,
  });
}

type OutboundAppendParams = {
  storePath: string;
  accountId: string;
  conversationId: string | null;
  messageId?: string;
  text?: string;
  messageType?: string;
  log?: unknown;
  createdAt?: number;
  delivery?: {
    messageId?: string;
    processQueryKey?: string;
    outTrackId?: string;
    cardInstanceId?: string;
    kind?: MessageDeliveryKind;
  };
};

function appendOutboundRecord(params: OutboundAppendParams): void {
  const delivery = {
    ...params.delivery,
    messageId: params.delivery?.messageId || params.messageId,
  };
  upsertOutboundMessageContext({
    storePath: params.storePath,
    accountId: params.accountId,
    conversationId: params.conversationId || null,
    createdAt: params.createdAt ?? Date.now(),
    text: params.text,
    messageType: params.messageType,
    ttlMs: ttlDaysToMs(DEFAULT_JOURNAL_TTL_DAYS),
    topic: null,
    delivery,
  });
}

export async function appendOutboundToQuoteJournal(params: OutboundAppendParams): Promise<void> {
  try {
    if (!params.messageId && !params.delivery?.processQueryKey && !params.delivery?.outTrackId) {
      return;
    }
    appendOutboundRecord(params);
  } catch (err) {
    (params.log as { debug?: (message: string) => void } | undefined)?.debug?.(
      `[quote-journal] appendOutbound failed: ${String(err)}`,
    );
  }
}

export async function appendProactiveOutboundJournal(params: OutboundAppendParams): Promise<void> {
  return appendOutboundToQuoteJournal(params);
}
