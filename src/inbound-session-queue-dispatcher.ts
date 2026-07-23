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
import { isAbortRequestText, isBtwRequestText } from "openclaw/plugin-sdk/reply-runtime";
import { attachNativeAckReaction } from "./ack-reaction-service";
import {
  createAICard,
  isCardInTerminalState,
  recallAICardMessage,
  streamAICard,
} from "./card-service";
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
const QUEUE_DUPLICATE_ACK = "这条相同消息已经在处理中或队列中，无需重复发送。";
const MIN_QUEUE_ACK_CARD_VISIBLE_MS = 750;

// DingTalk retries keep the same msgId and are already handled by gateway dedup.
// This set handles a user manually resending the same meaningful text with a new
// msgId while its earlier copy is still active or queued.
const activeMessageFingerprints = new Set<string>();
const queuedAckVisibleAt = new WeakMap<AICardInstance, number>();

function resolveMessageFingerprint(input: InboundQueueDispatchInput, queueKey: string): string | undefined {
  const text = extractMessageContent(input.data)?.text?.trim().replace(/\s+/g, " ");
  return text ? `${queueKey}\u0000${text}` : undefined;
}

function shouldPrepareQueueAckCard(input: InboundQueueDispatchInput): boolean {
  if (input.dingtalkConfig.messageType !== "card") {
    return false;
  }
  const text = extractMessageContent(input.data)?.text || "";
  // These paths deliberately do not consume the normal reply card.
  return !isBtwRequestText(text) && !isAbortRequestText(text);
}

async function keepQueueAckCardVisible(card: AICardInstance): Promise<void> {
  const visibleAt = queuedAckVisibleAt.get(card);
  if (!visibleAt) {
    return;
  }
  const remainingMs = MIN_QUEUE_ACK_CARD_VISIBLE_MS - (Date.now() - visibleAt);
  if (remainingMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
  }
}

async function settleUnusedQueueAckCard(
  input: InboundQueueDispatchInput,
  card: AICardInstance,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    return;
  }
  try {
    if (await recallAICardMessage(card, input.log)) {
      return;
    }
  } catch (err: unknown) {
    input.log?.warn?.(
      `[DingTalk] Failed to recall unused queue acknowledgement card: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await sendQueueTerminalAck(input, "已结束排队确认，请以本次实际回复为准。", card);
}

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
  const wasBusy = isInboundSessionQueueBusy(queueKey);
  const fingerprint = resolveMessageFingerprint(input, queueKey);
  if (wasBusy && fingerprint && activeMessageFingerprints.has(fingerprint)) {
    await sendQueueTerminalAck(input, QUEUE_DUPLICATE_ACK);
    return undefined as T;
  }
  if (getInboundSessionQueueDepth(queueKey) >= MAX_INBOUND_SESSION_QUEUE_DEPTH) {
    await sendQueueTerminalAck(input, QUEUE_FULL_ACK);
    return undefined as T;
  }
  // Detect busyness BEFORE chaining: this call is "busy" only if a PRIOR task
  // for this conversation is still running.
  if (fingerprint) {
    activeMessageFingerprints.add(fingerprint);
  }
  // Start preparing a busy ACK without awaiting it before we reserve a queue
  // slot below. Otherwise a burst of inbound messages can all observe the
  // same pre-await depth and each pass the cap check.
  let queuedAckState: "queued" | "timed-out" = "queued";
  const preCreatedCardPromise = wasBusy && shouldPrepareQueueAckCard(input)
    ? tryPrepareQueueAckCard(input, () =>
        queuedAckState === "timed-out"
          ? { content: QUEUE_WAIT_TIMEOUT_ACK, finished: true }
          : { content: pickQueueBusyAckPhrase(), finished: false },
      )
    : undefined;
  // Chain onto the prior task for this conversation and AWAIT. Awaiting (rather
  // than fire-and-forget) preserves the gateway's per-message dedup:
  // `markMessageProcessed` runs only after this message truly completes, so a
  // still-queued message is never marked processed.
  try {
    return await chainInboundSessionTask(
      queueKey,
      async () => {
        const preCreatedCard = preCreatedCardPromise
          ? await preCreatedCardPromise
          : undefined;
        if (!preCreatedCard) {
          return handler(undefined);
        }
        await keepQueueAckCardVisible(preCreatedCard);
        try {
          return await handler(preCreatedCard);
        } finally {
          await settleUnusedQueueAckCard(input, preCreatedCard);
        }
      },
      {
        maxQueueWaitMs: wasBusy ? MAX_INBOUND_SESSION_QUEUE_WAIT_MS : undefined,
      },
    );
  } catch (err: unknown) {
    if (err instanceof InboundSessionQueueWaitTimeoutError) {
      queuedAckState = "timed-out";
      await sendQueueTerminalAck(
        input,
        QUEUE_WAIT_TIMEOUT_ACK,
        preCreatedCardPromise ? await preCreatedCardPromise : undefined,
      );
      return undefined as T;
    }
    throw err;
  } finally {
    if (fingerprint) {
      activeMessageFingerprints.delete(fingerprint);
    }
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
  ack: () => { content: string; finished: boolean },
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
    const { content, finished } = ack();
    await streamAICard(card, content, finished, log);
    if (!finished) {
      queuedAckVisibleAt.set(card, Date.now());
    }
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
    const card = await tryPrepareQueueAckCard(input, () => ({ content, finished: true }));
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
