/**
 * AI Card reply strategy.
 *
 * Encapsulates the card draft controller lifecycle, deliver routing
 * (final / tool / block), finalization, and failure fallback so that
 * inbound-handler only coordinates — it no longer owns card state.
 */

import {
  commitAICardBlocks,
  isCardInTerminalState,
} from "./card-service";
import { createReasoningBlockAssembler } from "./card/reasoning-block-assembler";
import { createCardDraftController } from "./card-draft-controller";
import { attachCardRunController } from "./card/card-run-registry";
import type { DeliverPayload, ReplyOptions, ReplyStrategy, ReplyStrategyContext } from "./reply-strategy";
import { sendBySession, sendMessage, uploadMedia } from "./send-service";
import type { AICardInstance } from "./types";
import { AICardStatus } from "./types";
import { formatDingTalkErrorPayloadLog } from "./utils";

const EMPTY_FINAL_REPLY = "✅ Done";

export function createCardReplyStrategy(
  ctx: ReplyStrategyContext & { card: AICardInstance; isStopRequested?: () => boolean },
): ReplyStrategy {
  const { card, config, log, isStopRequested } = ctx;

  const controller = createCardDraftController({
    card,
    log,
    realTimeStreamEnabled: config.cardRealTimeStream ?? false,
  });
  const reasoningAssembler = createReasoningBlockAssembler();
  if (card.outTrackId) {
    attachCardRunController(card.outTrackId, controller);
  }
  let finalTextForFallback: string | undefined;
  let sawFinalDelivery = false;
  let currentTurnSawExplicitReasoning = false;
  let currentTurnSawPartialAnswer = false;
  let currentTurnSawStableAnswer = false;

  const resetCurrentTurnAnswerTracking = () => {
    currentTurnSawExplicitReasoning = false;
    currentTurnSawPartialAnswer = false;
    currentTurnSawStableAnswer = false;
  };

  const notePartialAnswerDraft = (text: string | undefined) => {
    if (typeof text === "string" && text.trim()) {
      currentTurnSawPartialAnswer = true;
    }
  };

  const noteStableAnswer = (text: string | undefined) => {
    if (typeof text === "string" && text.trim()) {
      currentTurnSawStableAnswer = true;
    }
  };

  const shouldDiscardCurrentAnswerDraft = (): boolean =>
    currentTurnSawExplicitReasoning
    && currentTurnSawPartialAnswer
    && !currentTurnSawStableAnswer;

  const discardCurrentAnswerDraft = (scope: string) => {
    if (!shouldDiscardCurrentAnswerDraft()) {
      return false;
    }
    controller.discardCurrentAnswer();
    currentTurnSawPartialAnswer = false;
    log?.debug?.(`[DingTalk][Card] Dropped partial-only answer draft after explicit reasoning in ${scope}`);
    return true;
  };

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
    if (typeof text === "string" && text.trim()) {
      currentTurnSawExplicitReasoning = true;
    }
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
        // Card mode follows the runtime block-streaming contract passed from
        // inbound-handler while still consuming explicit reasoning callbacks.
        disableBlockStreaming: ctx.disableBlockStreaming ?? true,

        onAssistantMessageStart: async () => {
          if (isStopRequested?.()) {
            return;
          }
          const pendingReasoningBlocks = reasoningAssembler.flushPendingAtBoundary();
          reasoningAssembler.reset();
          const discardActiveAnswer = shouldDiscardCurrentAnswerDraft();
          if (discardActiveAnswer) {
            log?.debug?.("[DingTalk][Card] Dropping partial-only answer draft before starting a new assistant turn");
          }
          const turnBoundary = controller.notifyNewAssistantTurn({ discardActiveAnswer });
          resetCurrentTurnAnswerTracking();
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
                notePartialAnswerDraft(payload.text);
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
          for (const url of payload.mediaUrls) {
            try {
              const result = await uploadMedia(config, url, "image", log);
              if (result?.mediaId) {
                await controller.appendImageBlock(result.mediaId);
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              log?.debug?.(`[DingTalk][Card] Failed to upload media as image block: ${msg}`);
            }
          }
        }
        const rawFinalText = typeof textToSend === "string" ? textToSend : "";
        if (rawFinalText) {
          noteStableAnswer(rawFinalText);
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
        discardCurrentAnswerDraft("tool.boundary");
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
          noteStableAnswer(textToSend);
          await controller.updateAnswer(textToSend);
        }
      }

      // ---- block: only handle reasoning/media (other text blocks are unused) ----
      if (payload.mediaUrls.length > 0) {
        for (const url of payload.mediaUrls) {
          try {
            const result = await uploadMedia(config, url, "image", log);
            if (result?.mediaId) {
              await controller.appendImageBlock(result.mediaId);
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log?.debug?.(`[DingTalk][Card] Failed to upload media as image block: ${msg}`);
          }
        }
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
        discardCurrentAnswerDraft("card.failure");
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

      // Normal finalize (V2 template path: single instances API call).
      try {
        discardCurrentAnswerDraft("card.finalize");
        await flushPendingReasoning();

        // Clear any remaining streaming content before final commit
        if (controller.isRealTimeStreamEnabled() && controller.clearStreamingContent) {
          await controller.clearStreamingContent();
        }

        await controller.flush();
        await controller.waitForInFlight();

        // Prepare finalize options for single instances API call
        const fallbackAnswer = finalTextForFallback || (sawFinalDelivery ? EMPTY_FINAL_REPLY : undefined);
        const blockListJson = controller.getRenderedBlocks({
          fallbackAnswer,
          overrideAnswer: finalTextForFallback,
        });
        const content = controller.getRenderedContent({
          fallbackAnswer,
          overrideAnswer: finalTextForFallback,
        }) || fallbackAnswer || EMPTY_FINAL_REPLY;

        controller.stop();
        log?.info?.(
          `[DingTalk][Finalize] Calling commitAICardBlocks — ` +
          `blockListLen=${blockListJson.length} contentLen=${content.length} ` +
          `source=${finalTextForFallback ? "final.payload" : controller.getFinalAnswerContent() ? "timeline.answer" : sawFinalDelivery ? "timeline.fileOnly" : "fallbackDone"} ` +
          `preview="${content.slice(0, 120)}"`,
        );

        await commitAICardBlocks(card, {
          blockListJson,
          content,
          // quoteContent is set during card creation, not needed in finalize
          quotedRef: ctx.replyQuotedRef,
        }, log);

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
          // For V2 template, finalize via instances API
          const errorBlockListJson = JSON.stringify([{ type: 0, markdown: "❌ 处理失败" }]);
          await commitAICardBlocks(card, {
            blockListJson: errorBlockListJson,
            content: "❌ 处理失败",
          }, log);
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
