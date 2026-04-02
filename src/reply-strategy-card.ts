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
} from "./card-service";
import { createReasoningBlockAssembler } from "./card/reasoning-block-assembler";
import { createCardDraftController } from "./card-draft-controller";
import { attachCardRunController } from "./card/card-run-registry";
import type { DeliverPayload, ReplyOptions, ReplyStrategy, ReplyStrategyContext } from "./reply-strategy";
import { sendBySession, sendMessage } from "./send-service";
import type { AICardInstance } from "./types";
import { AICardStatus } from "./types";
import { formatDingTalkErrorPayloadLog } from "./utils";

const EMPTY_FINAL_REPLY = "✅ Done";

export function createCardReplyStrategy(
  ctx: ReplyStrategyContext & { card: AICardInstance; isStopRequested?: () => boolean },
): ReplyStrategy {
  const { card, config, log, isStopRequested } = ctx;

  const controller = createCardDraftController({ card, log });
  const reasoningAssembler = createReasoningBlockAssembler();
  if (card.outTrackId) {
    attachCardRunController(card.outTrackId, controller);
  }
  let finalTextForFallback: string | undefined;
  let sawFinalDelivery = false;

  const getRenderedTimeline = (options: { preferFinalAnswer?: boolean } = {}): string => {
    const fallbackAnswer = finalTextForFallback || (sawFinalDelivery ? EMPTY_FINAL_REPLY : undefined);
    return controller.getRenderedContent({
      fallbackAnswer,
      overrideAnswer: options.preferFinalAnswer ? finalTextForFallback : undefined,
    });
  };

  const appendAssembledThinkingBlocks = async (blocks: string[]): Promise<void> => {
    for (const block of blocks) {
      if (!block.trim() || isStopRequested?.()) {
        continue;
      }
      await controller.appendThinkingBlock(block);
    }
  };

  const ingestReasoningSnapshot = async (text: string | undefined): Promise<void> => {
    const blocks = reasoningAssembler.ingestSnapshot(text);
    if (
      blocks.length === 0
      && typeof text === "string"
      && text.trim()
      && !text.trimStart().startsWith("Reasoning:")
    ) {
      await appendAssembledThinkingBlocks([text.trim()]);
      return;
    }
    await appendAssembledThinkingBlocks(blocks);
  };

  const flushPendingReasoning = async (): Promise<void> => {
    const blocks = reasoningAssembler.flushPendingAtBoundary();
    await appendAssembledThinkingBlocks(blocks);
  };

  return {
    getReplyOptions(): ReplyOptions {
      return {
        // Card mode keeps runtime block streaming disabled, but still consumes
        // reasoning blocks through explicit callbacks and delivery metadata.
        disableBlockStreaming: ctx.disableBlockStreaming ?? true,

        onAssistantMessageStart: async () => {
          if (isStopRequested?.()) {
            return;
          }
          const pendingReasoningBlocks = reasoningAssembler.flushPendingAtBoundary();
          reasoningAssembler.reset();
          const turnBoundary = controller.notifyNewAssistantTurn();
          if (pendingReasoningBlocks.length > 0) {
            await turnBoundary;
            await appendAssembledThinkingBlocks(pendingReasoningBlocks);
            return;
          }
          await turnBoundary;
        },

        onPartialReply: config.cardRealTimeStream
          ? async (payload) => {
              if (payload.text && !isStopRequested?.()) {
                await controller.updateAnswer(payload.text);
              }
            }
          : undefined,

        onReasoningStream: async (payload) => {
          if (payload.text && !isStopRequested?.()) {
            await ingestReasoningSnapshot(payload.text);
          }
        },
      };
    },

    async deliver(payload: DeliverPayload): Promise<void> {
      const textToSend = payload.text;

      // Empty-payload guard — card final is an exception (e.g. file-only response).
      if ((typeof textToSend !== "string" || textToSend.length === 0) && payload.mediaUrls.length === 0) {
        if (payload.kind !== "final") {
          return;
        }
      }

      // ---- final: defer to finalize, just save text ----
      if (payload.kind === "final") {
        await flushPendingReasoning();
        sawFinalDelivery = true;
        log?.info?.(
          `[DingTalk][Finalize] deliver(final) received — cardState=${card.state} ` +
          `textLen=${typeof textToSend === "string" ? textToSend.length : "null"} ` +
          `mediaUrls=${payload.mediaUrls.length} ` +
          `lastAnswer="${(controller.getLastAnswerContent() ?? "").slice(0, 80)}" ` +
          `lastContent="${(controller.getLastContent() ?? "").slice(0, 80)}"`,
        );
        if (payload.mediaUrls.length > 0) {
          await ctx.deliverMedia(payload.mediaUrls);
        }
        const rawFinalText = typeof textToSend === "string" ? textToSend : "";
        if (rawFinalText) {
          finalTextForFallback = rawFinalText;
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
        await controller.appendTool(textToSend ?? "");
        return;
      }

      const isReasoningBlock = payload.isReasoning === true;
      if (typeof textToSend === "string" && textToSend.trim()) {
        if (isReasoningBlock) {
          await ingestReasoningSnapshot(textToSend);
        } else {
          await controller.updateAnswer(textToSend);
        }
      }

      // ---- block: only handle reasoning/media (other text blocks are unused) ----
      if (payload.mediaUrls.length > 0) {
        await ctx.deliverMedia(payload.mediaUrls);
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
        return;
      }

      if (card.state === AICardStatus.FINISHED) {
        log?.info?.("[DingTalk][Finalize] Skipping — card already FINISHED");
        return;
      }

      if (card.state === AICardStatus.STOPPED) {
        log?.info?.("[DingTalk][Finalize] Skipping — card already STOPPED");
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
        return;
      }

      // Normal finalize.
      try {
        await flushPendingReasoning();
        await controller.flush();
        await controller.waitForInFlight();
        const renderedTimeline = getRenderedTimeline({ preferFinalAnswer: true });
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
      }
    },

    async abort(_error: Error): Promise<void> {
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
