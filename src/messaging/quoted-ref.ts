import {
  resolveByQuotedRef,
  type MessageRecord,
} from "../message-context-store";
import type { DingTalkInboundMessage, MessageContent, QuotedRef } from "../types";

function firstTrimmedString(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function firstFiniteNumber(...candidates: Array<number | undefined>): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function buildInboundQuotedRef(
  data: DingTalkInboundMessage,
  content: MessageContent,
): QuotedRef | undefined {
  const repliedMsg = data.text?.repliedMsg;
  const repliedMsgId = firstTrimmedString(repliedMsg?.msgId, data.originalMsgId, content.quoted?.msgId);
  const fallbackCreatedAt = firstFiniteNumber(
    repliedMsg?.createdAt,
    content.quoted?.cardCreatedAt,
    content.quoted?.fileCreatedAt,
  );
  const isOutboundQuoted =
    firstTrimmedString(data.originalProcessQueryKey) !== undefined ||
    repliedMsg?.senderId === data.chatbotUserId ||
    content.quoted?.isQuotedCard === true;
  if (isOutboundQuoted) {
    const processQueryKey = firstTrimmedString(data.originalProcessQueryKey, content.quoted?.processQueryKey);
    if (processQueryKey) {
      return {
        targetDirection: "outbound",
        key: "processQueryKey",
        value: processQueryKey,
        fallbackCreatedAt,
        fallbackMsgId: repliedMsgId,
      };
    }
    if (!fallbackCreatedAt && !repliedMsgId) {
      return undefined;
    }
    return {
      targetDirection: "outbound",
      fallbackCreatedAt,
      fallbackMsgId: repliedMsgId,
    };
  }
  if (!repliedMsgId) {
    return undefined;
  }
  return {
    targetDirection: "inbound",
    key: "msgId",
    value: repliedMsgId,
  };
}

export function createReplyQuotedRef(msgId: string | undefined): QuotedRef | undefined {
  const value = firstTrimmedString(msgId);
  if (!value) {
    return undefined;
  }
  return {
    targetDirection: "inbound",
    key: "msgId",
    value,
  };
}

export function resolveQuotedRecord(params: {
  storePath?: string;
  accountId: string;
  conversationId: string | null;
  quotedRef?: QuotedRef;
}): MessageRecord | null {
  if (!params.quotedRef) {
    return null;
  }
  return resolveByQuotedRef({
    storePath: params.storePath,
    accountId: params.accountId,
    conversationId: params.conversationId,
    quotedRef: params.quotedRef,
  });
}
