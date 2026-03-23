import type { MessageRecord } from "../message-context-store";
import type { Logger, QuotedRef } from "../types";
import { resolveQuotedRecord } from "./quoted-ref";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_PER_HOP_BODY_LIMIT = 1200;
const DEFAULT_TOTAL_BODY_LIMIT = 3600;

export interface QuotedChainEntry {
  depth: number;
  direction: MessageRecord["direction"];
  messageType: string;
  sender?: string;
  body: string;
  createdAt: number;
}

export interface ResolvedQuotedRuntimeContext {
  replyToId?: string;
  replyToBody: string;
  replyToSender?: string;
  replyToIsQuote: true;
  chain: QuotedChainEntry[];
  untrustedContext?: string;
}

export interface QuotedRuntimePreview {
  text?: string;
  messageType?: string;
  senderId?: string;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function trimmedString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function deriveReplyToId(record: MessageRecord): string | undefined {
  if (record.direction === "inbound") {
    return trimmedString(record.msgId);
  }
  return (
    trimmedString(record.delivery?.processQueryKey) ||
    trimmedString(record.delivery?.messageId) ||
    trimmedString(record.delivery?.outTrackId) ||
    trimmedString(record.delivery?.cardInstanceId) ||
    trimmedString(record.msgId)
  );
}

function deriveSender(record: MessageRecord): string | undefined {
  return record.direction === "outbound" ? "assistant" : undefined;
}

function deriveMessageType(record: MessageRecord): string {
  return trimmedString(record.messageType) || "unknown";
}

function buildBodyPlaceholder(record: MessageRecord): string {
  const messageType = trimmedString(record.messageType) || "message";
  return `[Quoted ${messageType}]`;
}

function buildPreviewPlaceholder(preview: QuotedRuntimePreview | undefined): string {
  const messageType = trimmedString(preview?.messageType) || "message";
  return `[Quoted ${messageType}]`;
}

function resolveRecordBody(record: MessageRecord): string {
  return (
    trimmedString(record.attachmentText) ||
    trimmedString(record.text) ||
    buildBodyPlaceholder(record)
  );
}

function resolvePreviewBody(preview: QuotedRuntimePreview | undefined): string | undefined {
  return trimmedString(preview?.text) || (preview ? buildPreviewPlaceholder(preview) : undefined);
}

function deriveReplyToIdFromQuotedRef(quotedRef: QuotedRef | undefined): string | undefined {
  if (!quotedRef?.key || !quotedRef.value) {
    return undefined;
  }
  return trimmedString(quotedRef.value);
}

function derivePreviewSender(quotedRef?: QuotedRef): string | undefined {
  if (quotedRef?.targetDirection === "outbound") {
    return "assistant";
  }
  return undefined;
}

function truncateBody(value: string, limit: number): string {
  if (limit <= 0) {
    return "";
  }
  return value.length <= limit ? value : value.slice(0, limit);
}

function fingerprintQuotedRef(quotedRef: QuotedRef | undefined): string | undefined {
  if (!quotedRef) {
    return undefined;
  }
  const direction = quotedRef.targetDirection;
  const key = quotedRef.key || "";
  const value = quotedRef.value || "";
  const fallbackCreatedAt =
    typeof quotedRef.fallbackCreatedAt === "number" && Number.isFinite(quotedRef.fallbackCreatedAt)
      ? String(quotedRef.fallbackCreatedAt)
      : "";
  if (!direction) {
    return undefined;
  }
  return JSON.stringify([direction, key, value, fallbackCreatedAt]);
}

function buildChainEntry(params: {
  record: MessageRecord;
  depth: number;
  remainingBodyBudget: number;
  perHopBodyLimit: number;
}): QuotedChainEntry | null {
  const limit = Math.min(params.perHopBodyLimit, params.remainingBodyBudget);
  if (limit <= 0) {
    return null;
  }
  const body = truncateBody(resolveRecordBody(params.record), limit);
  return {
    depth: params.depth,
    direction: params.record.direction,
    messageType: deriveMessageType(params.record),
    sender: deriveSender(params.record),
    body,
    createdAt: params.record.createdAt,
  };
}

export function resolveQuotedRuntimeContext(params: {
  storePath?: string;
  accountId: string;
  conversationId: string | null;
  quotedRef?: QuotedRef;
  firstRecord?: MessageRecord | null;
  firstPreview?: QuotedRuntimePreview;
  log?: Logger;
  maxDepth?: number;
  perHopBodyLimit?: number;
  totalBodyLimit?: number;
}): ResolvedQuotedRuntimeContext | null {
  if (!params.quotedRef) {
    return null;
  }

  const maxDepth = normalizePositiveInteger(params.maxDepth, DEFAULT_MAX_DEPTH);
  const perHopBodyLimit = normalizePositiveInteger(
    params.perHopBodyLimit,
    DEFAULT_PER_HOP_BODY_LIMIT,
  );
  const totalBodyLimit = normalizePositiveInteger(params.totalBodyLimit, DEFAULT_TOTAL_BODY_LIMIT);

  const chain: QuotedChainEntry[] = [];
  const seenRecordIds = new Set<string>();
  const seenQuotedRefFingerprints = new Set<string>();
  let firstResolvedRecord: MessageRecord | null = null;
  let remainingBodyBudget = totalBodyLimit;
  let currentQuotedRef: QuotedRef | undefined = params.quotedRef;
  let currentRecord = params.firstRecord ?? null;

  for (let depth = 1; depth <= maxDepth && currentQuotedRef; depth += 1) {
    if (depth > 1 || !currentRecord) {
      currentRecord = resolveQuotedRecord({
        storePath: params.storePath,
        accountId: params.accountId,
        conversationId: params.conversationId,
        quotedRef: currentQuotedRef,
        log: params.log,
      });
    }
    if (!currentRecord) {
      break;
    }
    if (!firstResolvedRecord) {
      firstResolvedRecord = currentRecord;
    }

    const recordId = `${currentRecord.direction}:${currentRecord.msgId}`;
    if (seenRecordIds.has(recordId)) {
      break;
    }
    seenRecordIds.add(recordId);

    const currentFingerprint = fingerprintQuotedRef(currentQuotedRef);
    if (currentFingerprint) {
      if (seenQuotedRefFingerprints.has(currentFingerprint)) {
        break;
      }
      seenQuotedRefFingerprints.add(currentFingerprint);
    }

    const entry = buildChainEntry({
      record: currentRecord,
      depth,
      remainingBodyBudget,
      perHopBodyLimit,
    });
    if (!entry) {
      break;
    }
    chain.push(entry);
    remainingBodyBudget -= entry.body.length;

    const nextQuotedRef = currentRecord.quotedRef;
    if (!nextQuotedRef) {
      break;
    }

    const nextFingerprint = fingerprintQuotedRef(nextQuotedRef);
    if (nextFingerprint && seenQuotedRefFingerprints.has(nextFingerprint)) {
      break;
    }

    currentQuotedRef = nextQuotedRef;
    currentRecord = null;
  }

  const replyToRecord = firstResolvedRecord ?? params.firstRecord ?? null;
  const stableReplyToId = replyToRecord ? deriveReplyToId(replyToRecord) : undefined;
  if (replyToRecord && stableReplyToId) {
    return {
      replyToId: stableReplyToId,
      replyToBody: chain[0].body,
      replyToSender: chain[0].sender,
      replyToIsQuote: true,
      chain,
      untrustedContext:
        chain.length > 1
          ? JSON.stringify({
              quotedChain: chain.slice(1),
            })
          : undefined,
    };
  }

  const previewBody = resolvePreviewBody(params.firstPreview);
  const previewReplyToId = deriveReplyToIdFromQuotedRef(params.quotedRef);
  if (!previewBody) {
    return null;
  }

  return {
    replyToId: previewReplyToId,
    replyToBody: truncateBody(previewBody, perHopBodyLimit),
    replyToSender: derivePreviewSender(params.quotedRef),
    replyToIsQuote: true,
    chain: [],
    untrustedContext: undefined,
  };
}
