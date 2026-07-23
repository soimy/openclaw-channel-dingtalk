// Gateway-level inbound serializer: wraps the gateway's call to
// `handleDingTalkMessage` with the per-conversation promise-chain queue from
// `inbound-session-queue.ts`.
//
// Why this lives in the gateway (not in handleDingTalkMessage): the queue
// serializes same-conversation inbound so a message that arrives while another
// is still being processed is QUEUED and auto-reprocessed once the active run
// finishes — instead of racing into the core's
//   "reply session initialization conflicted for <sessionKey>"
// and being dropped silently at the gateway catch block (the
// "钉钉'确认'消息无响应" regression). Direct callers of handleDingTalkMessage
// (ask-user reinjections, unit tests) bypass this queue on purpose: ask-user
// happens inside an already-active run, and tests drive the handler directly.
//
// While a message is queued, a pre-created AI Card shows an immediate
// "已排队" acknowledgement; the handler later reuses that same card
// (`params.preCreatedCard`) to stream the real reply in place.
//
// Ported from DingTalk-Real-AI/dingtalk-openclaw-connector's session-queue
// orchestrator, adapted to soimy's blocking gateway contract (we await each
// task so the gateway's per-message dedup stays correct).

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { attachNativeAckReaction } from "./ack-reaction-service";
import { createAICard, streamAICard } from "./card-service";
import {
  chainInboundSessionTask,
  deriveInboundQueueKey,
  getInboundSessionQueueDepth,
  InboundSessionQueueWaitTimeoutError,
  isInboundSessionQueueBusy,
  MAX_INBOUND_SESSION_QUEUE_DEPTH,
  MAX_INBOUND_SESSION_QUEUE_WAIT_MS,
  pickQueueBusyAckPhrase,
} from "./inbound-session-queue";
import { extractMessageContent } from "./message-utils";
import { getDingTalkRuntime } from "./runtime";
import { sendMessage } from "./send-service";
import type { AICardInstance, DingTalkConfig, DingTalkInboundMessage, Logger } from "./types";

export interface InboundQueueDispatchInput {
  cfg: OpenClawConfig;
  accountId: string;
  data: DingTalkInboundMessage;
  dingtalkConfig: DingTalkConfig;
  log?: Logger;
}

const QUEUE_FULL_ACK = "当前消息较多，已达到本会话排队上限；请等待上一轮完成后再发送。";
const QUEUE_WAIT_TIMEOUT_ACK = "上一轮处理时间较长，这条消息未执行；请稍后重新发送。";

/**
 * Serialize an inbound message per conversation, then invoke `handler` (which
 * should call `handleDingTalkMessage` with the provided `preCreatedCard`).
 *
 * The returned promise settles with the handler's own outcome, so the caller
 * (gateway) can await it and keep its per-message dedup correct
 * (`markMessageProcessed` only runs once the message truly completes).
 */
export async function dispatchInboundViaSessionQueue<T>(
  input: InboundQueueDispatchInput,
  handler: (preCreatedCard?: AICardInstance) => Promise<T>,
): Promise<T> {
  const queueKey = deriveInboundQueueKey({
    accountId: input.accountId,
    conversationId: input.data?.conversationId,
  });
  if (!queueKey) {
    // No stable conversation identity → cannot queue; run directly.
    return handler(undefined);
  }
  if (getInboundSessionQueueDepth(queueKey) >= MAX_INBOUND_SESSION_QUEUE_DEPTH) {
    await sendQueueTerminalAck(input, QUEUE_FULL_ACK);
    return undefined as T;
  }
  // Detect busyness BEFORE chaining: this call is "busy" only if a PRIOR task
  // for this conversation is still running.
  const wasBusy = isInboundSessionQueueBusy(queueKey);
  const preCreatedCard = wasBusy
    ? await tryPrepareQueueAckCard(input, pickQueueBusyAckPhrase(), false)
    : undefined;
  // Chain onto the prior task for this conversation and AWAIT. Awaiting (rather
  // than fire-and-forget) preserves the gateway's per-message dedup:
  // `markMessageProcessed` runs only after this message truly completes, so a
  // still-queued message is never marked processed.
  try {
    return await chainInboundSessionTask(queueKey, () => handler(preCreatedCard), {
      maxQueueWaitMs: wasBusy ? MAX_INBOUND_SESSION_QUEUE_WAIT_MS : undefined,
    });
  } catch (err: unknown) {
    if (err instanceof InboundSessionQueueWaitTimeoutError) {
      await sendQueueTerminalAck(input, QUEUE_WAIT_TIMEOUT_ACK, preCreatedCard);
      return undefined as T;
    }
    throw err;
  }
}

/**
 * Pre-create an AI Card showing a "已排队" acknowledgement for a message that
 * arrived while its conversation was busy. The handler later reuses this card
 * to stream the real reply in place. Best-effort: any failure returns
 * undefined and the handler falls back to creating a fresh card (or markdown).
 */
async function tryPrepareQueueAckCard(
  input: InboundQueueDispatchInput,
  content: string,
  finished: boolean,
): Promise<AICardInstance | undefined> {
  const { dingtalkConfig, data, log } = input;
  if (!data) {
    return undefined;
  }
  const isDirect = data.conversationType === "1";
  const to = isDirect
    ? (data.senderStaffId || data.senderId || "").trim()
    : (data.conversationId || "").trim();
  if (!to) {
    return undefined;
  }
  try {
    let storePath: string | undefined;
    try {
      const rt = getDingTalkRuntime();
      storePath = rt.channel.session.resolveStorePath(input.cfg?.session?.store, {
        agentId: input.accountId,
      });
    } catch {
      // resolveStorePath is best-effort for ACK card persistence.
    }
    const quoteText = (extractMessageContent(data)?.text || "").slice(0, 200);
    const card = await createAICard(dingtalkConfig, to, log, {
      accountId: input.accountId,
      storePath,
      quoteContent: quoteText,
    });
    if (!card) {
      return undefined;
    }
    await streamAICard(card, content, finished, log);
    if (finished) {
      return card;
    }
    // Best-effort thinking reaction; failures must not block the queue.
    void attachNativeAckReaction(
      dingtalkConfig,
      { msgId: data.msgId, conversationId: data.conversationId },
      log,
    ).catch((err: unknown) => {
      log?.debug?.(
        `[DingTalk] Queue-busy ack reaction attach failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    log?.info?.(
      `[DingTalk] Inbound message queued behind active run for conversation=${data.conversationId}; pre-created ACK card outTrackId=${card.cardInstanceId}.`,
    );
    return card;
  } catch (err: unknown) {
    log?.warn?.(
      `[DingTalk] Queue-busy ACK card prepare failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function sendQueueTerminalAck(
  input: InboundQueueDispatchInput,
  content: string,
  preCreatedCard?: AICardInstance,
): Promise<void> {
  const { dingtalkConfig, data, log } = input;
  try {
    if (preCreatedCard) {
      await streamAICard(preCreatedCard, content, true, log);
      return;
    }
    const card = await tryPrepareQueueAckCard(input, content, true);
    if (card) {
      return;
    }
    const isDirect = data.conversationType === "1";
    const to = isDirect
      ? (data.senderStaffId || data.senderId || "").trim()
      : (data.conversationId || "").trim();
    if (!to) {
      return;
    }
    const result = await sendMessage(dingtalkConfig, to, content, {
      sessionWebhook: data.sessionWebhook,
      log,
      accountId: input.accountId,
      conversationId: data.conversationId,
    });
    if (!result.ok) {
      log?.warn?.(`[DingTalk] Queue terminal acknowledgement failed: ${result.error || "unknown"}`);
    }
  } catch (err: unknown) {
    log?.warn?.(
      `[DingTalk] Queue terminal acknowledgement delivery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
