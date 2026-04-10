/**
 * AI Card reply strategy.
 *
 * Encapsulates the card draft controller lifecycle, deliver routing
 * (final / tool / block), finalization, and failure fallback so that
 * inbound-handler only coordinates — it no longer owns card state.
 */

import {
  finishAICard,
  isCardInTerminalState,
  recallAICardMessage,
} from "./card-service";
import { splitCardReasoningAnswerText } from "./card/reasoning-answer-split";
import { createReasoningBlockAssembler } from "./card/reasoning-block-assembler";
import {
  resolveCardStreamingMode,
  shouldWarnDeprecatedCardRealTimeStreamOnce,
} from "./card/card-streaming-mode";
import { createCardDraftController } from "./card-draft-controller";
import { attachCardRunController } from "./card/card-run-registry";
import type { DeliverPayload, ReplyOptions, ReplyStrategy, ReplyStrategyContext } from "./reply-strategy";
import { sendBySession, sendMessage } from "./send-service";
import type { AICardInstance } from "./types";
import { AICardStatus } from "./types";
import { formatDingTalkErrorPayloadLog } from "./utils";

const EMPTY_FINAL_REPLY = "✅ Done";
type CardReplyLifecycleState = "open" | "final_seen" | "sealed";

export function createCardReplyStrategy(
  ctx: ReplyStrategyContext & { card: AICardInstance; isStopRequested?: () => boolean },
): ReplyStrategy {
  const { card, config, log, isStopRequested } = ctx;
  const { mode, usedDeprecatedCardRealTimeStream } = resolveCardStreamingMode(config);
  const streamAnswerLive = mode === "answer" || mode === "all";
  const streamThinkingLive = mode === "all";
  let lifecycleState: CardReplyLifecycleState = "open";
  const shouldAcceptAnswerSnapshot = () => lifecycleState === "open";
  const isLifecycleSealed = () => lifecycleState === "sealed";

  if (usedDeprecatedCardRealTimeStream) {
    const warningKey = `dingtalk-card-streaming:${ctx.accountId || config.clientId || "default"}`;
    if (shouldWarnDeprecatedCardRealTimeStreamOnce(warningKey)) {
      log?.warn?.(
        "[DingTalk][Config] `cardRealTimeStream` is deprecated. Use `cardStreamingMode` with `off` | `answer` | `all`.",
      );
    }
  }

  const controller = createCardDraftController({
    card,
    log,
    throttleMs: config.cardStreamInterval ?? 1000,
  });
  const reasoningAssembler = createReasoningBlockAssembler();
  if (card.outTrackId) {
    attachCardRunController(card.outTrackId, controller);
  }
  let finalTextForFallback: string | undefined;
  let sawFinalDelivery = false;
  let successfulMediaDeliveries = 0;
  let failedMediaDeliveries = 0;
  /** Tracks the latest reasoning snapshot text for non-streaming boundary flush. */
  let latestReasoningSnapshot = "";

  const getRenderedTimeline = (options: { preferFinalAnswer?: boolean } = {}): string => {
    const fallbackAnswer = finalTextForFallback || (sawFinalDelivery ? EMPTY_FINAL_REPLY : undefined);
    return controller.getRenderedContent({
      fallbackAnswer,
      overrideAnswer: options.preferFinalAnswer ? finalTextForFallback : undefined,
    });
  };

  const getRawRenderedTimeline = (): string =>
    controller.getRenderedContent({
      fallbackAnswer: undefined,
      overrideAnswer: undefined,
    });

  const appendAssembledThinkingBlocks = async (blocks: string[]): Promise<void> => {
    for (const block of blocks) {
      if (!block.trim() || isStopRequested?.()) {
        continue;
      }
      await controller.appendThinkingBlock(block);
    }
  };

  const applyModeAwareDeliveredReasoning = async (text: string | undefined): Promise<void> => {
    if (typeof text !== "string" || !text.trim() || isStopRequested?.()) {
      return;
    }
    if (streamThinkingLive) {
      await controller.appendThinkingBlock(text);
      return;
    }
    await applyModeAwareReasoningSnapshot(text);
  };

  const applyModeAwareReasoningSnapshot = async (text: string | undefined): Promise<void> => {
    if (typeof text !== "string" || !text.trim() || isStopRequested?.()) {
      return;
    }
    if (streamThinkingLive) {
      latestReasoningSnapshot = text;
      await controller.updateReasoning(text);
      return;
    }
    const blocks = reasoningAssembler.ingestSnapshot(text);
    const trimmed = text.trimStart();
    if (
      blocks.length === 0
      && !trimmed.startsWith("Reasoning:")
    ) {
      if (trimmed.startsWith("Reason:")) {
        latestReasoningSnapshot = "";
        return;
      }
      latestReasoningSnapshot = text.trim();
      return;
    }
    latestReasoningSnapshot = "";
    await appendAssembledThinkingBlocks(blocks);
  };

  const flushPendingReasoning = async (): Promise<void> => {
    if (streamThinkingLive) {
      await controller.sealActiveThinking();
      latestReasoningSnapshot = "";
      return;
    }
    const blocks = reasoningAssembler.flushPendingAtBoundary();
    if (latestReasoningSnapshot) {
      blocks.push(latestReasoningSnapshot);
      latestReasoningSnapshot = "";
    }
    await appendAssembledThinkingBlocks(blocks);
  };

  const handleAssistantBoundary = async (): Promise<void> => {
    if (streamThinkingLive) {
      await controller.sealActiveThinking();
      latestReasoningSnapshot = "";
      reasoningAssembler.reset();
      await controller.notifyNewAssistantTurn();
      return;
    }
    const pendingReasoningBlocks = reasoningAssembler.flushPendingAtBoundary();
    if (latestReasoningSnapshot) {
      pendingReasoningBlocks.push(latestReasoningSnapshot);
      latestReasoningSnapshot = "";
    }
    reasoningAssembler.reset();
    const turnBoundary = controller.notifyNewAssistantTurn();
    if (pendingReasoningBlocks.length > 0) {
      await turnBoundary;
      await appendAssembledThinkingBlocks(pendingReasoningBlocks);
      return;
    }
    await turnBoundary;
  };

  const normalizeDeliveredText = (
    text: string,
    options: { isReasoning: boolean },
  ): { reasoningText?: string; answerText?: string } => {
    if (options.isReasoning) {
      const split = splitCardReasoningAnswerText(text);
      return { reasoningText: split.reasoningText || text };
    }
    const split = splitCardReasoningAnswerText(text);
    return {
      reasoningText: split.reasoningText,
      answerText: split.answerText,
    };
  };

  const applyDeliveredContent = async (
    normalized: { reasoningText?: string; answerText?: string },
    options: {
      routeReasoningThroughModePolicy: boolean;
      answerHandling?: "update" | "capture" | "ignore";
    },
  ): Promise<void> => {
    if (normalized.reasoningText) {
      if (options.routeReasoningThroughModePolicy) {
        await applyModeAwareDeliveredReasoning(normalized.reasoningText);
      } else {
        // Conservative local split fallback: keep existing behavior for mixed payloads.
        await controller.appendThinkingBlock(normalized.reasoningText);
      }
    }
    if (normalized.answerText && options.answerHandling !== "ignore") {
      if (options.answerHandling === "capture") {
        finalTextForFallback = normalized.answerText;
        return;
      }
      await controller.updateAnswer(normalized.answerText);
    }
  };

  const handleAnswerSnapshot = async (text: string | undefined): Promise<void> => {
    if (!shouldAcceptAnswerSnapshot() || isStopRequested?.()) {
      return;
    }
    if (!text) {
      return;
    }
    await controller.updateAnswer(text, { stream: streamAnswerLive });
  };

  const applySplitTextToTimeline = async (
    text: string,
    options: { answerHandling?: "update" | "capture" | "ignore" } = {},
  ) => {
    const normalized = normalizeDeliveredText(text, { isReasoning: false });
    await applyDeliveredContent(normalized, {
      routeReasoningThroughModePolicy: true,
      answerHandling: options.answerHandling ?? "update",
    });
    return normalized;
  };

  const deliverMediaWithTracking = async (
    mediaUrls: string[],
    options: { audioAsVoice?: boolean },
  ): Promise<void> => {
    if (mediaUrls.length === 0) {
      return;
    }
    try {
      await ctx.deliverMedia(mediaUrls, options);
      successfulMediaDeliveries += mediaUrls.length;
    } catch (err) {
      failedMediaDeliveries += mediaUrls.length;
      throw err;
    }
  };

  return {
    getReplyOptions(): ReplyOptions {
      return {
        // Card mode keeps runtime block streaming disabled, but still consumes
        // reasoning blocks through explicit callbacks and delivery metadata.
        disableBlockStreaming: ctx.disableBlockStreaming ?? true,

        onAssistantMessageStart: async () => {
          if (isLifecycleSealed() || isStopRequested?.()) {
            return;
          }
          await handleAssistantBoundary();
        },

        onPartialReply: async (payload) => {
          await handleAnswerSnapshot(payload.text);
        },

        onReasoningStream: async (payload) => {
          if (isLifecycleSealed() || isStopRequested?.()) {
            return;
          }
          await applyModeAwareReasoningSnapshot(payload.text);
        },
      };
    },

    async deliver(payload: DeliverPayload): Promise<void> {
      if (isLifecycleSealed()) {
        return;
      }
      const textToSend = payload.text;

      // Empty-payload guard — card final is an exception (e.g. file-only response).
      if ((typeof textToSend !== "string" || textToSend.length === 0) && payload.mediaUrls.length === 0) {
        if (payload.kind !== "final") {
          return;
        }
      }

      // ---- final: defer to finalize, just save text ----
      if (payload.kind === "final") {
        const isFirstFinalDelivery = !sawFinalDelivery;
        lifecycleState = "final_seen";
        await flushPendingReasoning();
        if (isFirstFinalDelivery) {
          sawFinalDelivery = true;
        }
        log?.info?.(
          `[DingTalk][Finalize] deliver(final) received — cardState=${card.state} ` +
          `textLen=${typeof textToSend === "string" ? textToSend.length : "null"} ` +
          `mediaUrls=${payload.mediaUrls.length} ` +
          `lastAnswer="${(controller.getLastAnswerContent() ?? "").slice(0, 80)}" ` +
          `lastContent="${(controller.getLastContent() ?? "").slice(0, 80)}"`,
        );
        if (payload.mediaUrls.length > 0) {
          await deliverMediaWithTracking(payload.mediaUrls, { audioAsVoice: payload.audioAsVoice });
        }
        const rawFinalText = typeof textToSend === "string" ? textToSend : "";
        if (rawFinalText) {
          if (payload.isReasoning === true) {
            await applyModeAwareReasoningSnapshot(rawFinalText);
            await flushPendingReasoning();
          } else {
            const normalizedFinal = await applySplitTextToTimeline(rawFinalText, {
              answerHandling: "capture",
            });
            if (isFirstFinalDelivery && !normalizedFinal.answerText && !normalizedFinal.reasoningText) {
              finalTextForFallback = rawFinalText;
            }
            await flushPendingReasoning();
          }
        }
        return;
      }

      // ---- tool: append to card ----
      if (payload.kind === "tool") {
        if (controller.isFailed() || isCardInTerminalState(card.state)) {
          log?.debug?.("[DingTalk] Card failed, skipping tool result (will send full reply on final)");
          return;
        }
        await flushPendingReasoning();
        log?.info?.(
          `[DingTalk] Tool result received, streaming to AI Card: ${(textToSend ?? "").slice(0, 100)}`,
        );
        if (lifecycleState === "final_seen") {
          await controller.appendToolBeforeCurrentAnswer(textToSend ?? "");
        } else {
          await controller.appendTool(textToSend ?? "");
        }
        return;
      }

      const isReasoningBlock = payload.isReasoning === true;
      if (typeof textToSend === "string" && textToSend.trim()) {
        if (isReasoningBlock) {
          const normalized = normalizeDeliveredText(textToSend, { isReasoning: true });
          await applyDeliveredContent(normalized, {
            routeReasoningThroughModePolicy: true,
            answerHandling: "ignore",
          });
        } else {
          await applySplitTextToTimeline(textToSend, {
            answerHandling: lifecycleState === "open" ? "update" : "capture",
          });
        }
      }

      // ---- block: only handle reasoning/media (other text blocks are unused) ----
      if (payload.mediaUrls.length > 0) {
        await deliverMediaWithTracking(payload.mediaUrls, { audioAsVoice: payload.audioAsVoice });
      }
    },

    async finalize(): Promise<void> {
      log?.info?.(
        `[DingTalk][Finalize] Step 5 entry — ` +
        `cardState=${card.state ?? "N/A"} ` +
        `controllerFailed=${controller.isFailed()} ` +
        `finalTextForFallback="${(finalTextForFallback ?? "").slice(0, 80)}" ` +
        `lastAnswer="${(controller.getLastAnswerContent() ?? "").slice(0, 80)}" ` +
        `lastContent="${(controller.getLastContent() ?? "").slice(0, 80)}"`,
      );

      if (isStopRequested?.()) {
        log?.info?.("[DingTalk][Finalize] Skipping — card stop was requested");
        lifecycleState = "sealed";
        return;
      }

      if (card.state === AICardStatus.FINISHED) {
        // Card was already finalized (e.g. first embedded run timed out).
        // If session-recovery triggered a second run that produced new content,
        // deliver it as a markdown fallback so the user sees the final result.
        const recoveryText = finalTextForFallback
          || controller.getLastAnswerContent()
          || controller.getLastContent();
        if (recoveryText) {
          log?.info?.(
            `[DingTalk][Finalize] Card already FINISHED — sending markdown fallback for session-recovery content ` +
            `len=${recoveryText.length} preview="${recoveryText.slice(0, 80)}"`,
          );
          const sendResult = await sendMessage(ctx.config, ctx.to, recoveryText, {
            sessionWebhook: ctx.sessionWebhook,
            atUserId: !ctx.isDirect ? ctx.senderId : null,
            log,
            accountId: ctx.accountId,
            storePath: ctx.storePath,
            conversationId: ctx.groupId,
            quotedRef: ctx.replyQuotedRef,
            forceMarkdown: true,
          });
          if (!sendResult.ok) {
            log?.warn?.(
              `[DingTalk][Finalize] Markdown fallback after FINISHED card failed: ${sendResult.error}`,
            );
          }
        } else {
          log?.info?.("[DingTalk][Finalize] Skipping — card already FINISHED and no new content");
        }
        lifecycleState = "sealed";
        return;
      }

      if (card.state === AICardStatus.STOPPED) {
        log?.info?.("[DingTalk][Finalize] Skipping — card already STOPPED");
        lifecycleState = "sealed";
        return;
      }

      // Card failed -> markdown fallback (bypass sendMessage to avoid duplicate card).
      if (card.state === AICardStatus.FAILED || controller.isFailed()) {
        const fallbackText = getRenderedTimeline({ preferFinalAnswer: true })
          || controller.getLastAnswerContent()
          || controller.getLastContent()
          || card.lastStreamedContent;
        if (fallbackText) {
          log?.debug?.("[DingTalk] Card failed during streaming, sending markdown fallback");
          const sendResult = await sendMessage(ctx.config, ctx.to, fallbackText, {
            sessionWebhook: ctx.sessionWebhook,
            atUserId: !ctx.isDirect ? ctx.senderId : null,
            log,
            accountId: ctx.accountId,
            storePath: ctx.storePath,
            conversationId: ctx.groupId,
            quotedRef: ctx.replyQuotedRef,
            forceMarkdown: true,
          });
          if (!sendResult.ok) {
            throw new Error(sendResult.error || "Markdown fallback send failed after card failure");
          }
        } else {
          log?.debug?.("[DingTalk] Card failed but no content to fallback with");
        }
        lifecycleState = "sealed";
        return;
      }

      // Normal finalize.
      try {
        await flushPendingReasoning();
        await controller.flush();
        await controller.waitForInFlight();
        const renderedTimeline = getRenderedTimeline({ preferFinalAnswer: true });
        const rawRenderedTimeline = getRawRenderedTimeline();
        const hasRenderedCardContent = Boolean(rawRenderedTimeline.trim());
        const hasMeaningfulCardContent = hasRenderedCardContent
          || Boolean((finalTextForFallback || "").trim())
          || Boolean((controller.getFinalAnswerContent() || "").trim())
          || Boolean((controller.getLastAnswerContent() || "").trim())
          || Boolean((controller.getLastContent() || "").trim());
        const shouldRecallEmptyCard =
          successfulMediaDeliveries > 0
          && failedMediaDeliveries === 0
          && !hasMeaningfulCardContent;
        if (shouldRecallEmptyCard) {
          controller.stop();
          log?.info?.(
            `[DingTalk][Finalize] Attempting to recall empty card after successful media delivery ` +
            `mediaCount=${successfulMediaDeliveries} conversationId=${card.conversationId}`,
          );
          if (await recallAICardMessage(card, log)) {
            lifecycleState = "sealed";
            return;
          }
        }
        const finalText = renderedTimeline || EMPTY_FINAL_REPLY;
        controller.stop();
        log?.info?.(
          `[DingTalk][Finalize] Calling finishAICard — finalTextLen=${finalText.length} ` +
          `source=${finalTextForFallback ? "final.payload" : controller.getFinalAnswerContent() ? "timeline.answer" : sawFinalDelivery ? "timeline.fileOnly" : "fallbackDone"} ` +
          `preview="${finalText.slice(0, 120)}"`,
        );
        await finishAICard(card, finalText, log, {
          quotedRef: ctx.replyQuotedRef,
        });
        lifecycleState = "sealed";

        // In group chats, send a lightweight @mention via session webhook
        // so the sender gets a notification — card API doesn't support @mention.
        const cardAtSenderText = (ctx.config.cardAtSender || "").trim();
        if (!ctx.isDirect && ctx.senderId && ctx.sessionWebhook && cardAtSenderText) {
          try {
            await sendBySession(ctx.config, ctx.sessionWebhook, cardAtSenderText, {
              atUserId: ctx.senderId,
              log,
            });
          } catch (atErr: unknown) {
            const msg = atErr instanceof Error ? atErr.message : String(atErr);
            log?.debug?.(`[DingTalk] Post-card @mention send failed: ${msg}`);
          }
        }
      } catch (err: unknown) {
        log?.debug?.(`[DingTalk] AI Card finalization failed: ${(err as Error).message}`);
        const errObj = err as { response?: { data?: unknown } };
        if (errObj?.response?.data !== undefined) {
          log?.debug?.(formatDingTalkErrorPayloadLog("inbound.cardFinalize", errObj.response.data));
        }
        if ((card.state as string) !== AICardStatus.FINISHED) {
          card.state = AICardStatus.FAILED;
          card.lastUpdated = Date.now();
        }
      } finally {
        lifecycleState = "sealed";
      }
    },

    async abort(_error: Error): Promise<void> {
      lifecycleState = "sealed";
      if (!isCardInTerminalState(card.state)) {
        controller.stop();
        await controller.waitForInFlight();
        try {
          await finishAICard(card, "❌ 处理失败", log);
        } catch (cardCloseErr: unknown) {
          log?.debug?.(`[DingTalk] Failed to finalize card after dispatch error: ${(cardCloseErr as Error).message}`);
          card.state = AICardStatus.FAILED;
          card.lastUpdated = Date.now();
        }
      }
    },

    getFinalText(): string | undefined {
      return finalTextForFallback
        || controller.getFinalAnswerContent()
        || (sawFinalDelivery ? EMPTY_FINAL_REPLY : undefined);
    },
  };
}
