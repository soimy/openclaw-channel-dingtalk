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
import { createCardDraftController } from "./card-draft-controller";
import type { DeliverPayload, ReplyOptions, ReplyStrategy, ReplyStrategyContext } from "./reply-strategy";
import { sendBySession, sendMessage } from "./send-service";
import { getSessionState, getTaskTimeSeconds, updateSessionState, clearSessionState } from "./session-state";
import type { AICardInstance, CardBlock, CardTaskInfo } from "./types";
import { AICardStatus } from "./types";
import { formatDingTalkErrorPayloadLog } from "./utils";

const FILE_ONLY_FALLBACK_ANSWER = "附件已发送，请查收。";

export function createCardReplyStrategy(
  ctx: ReplyStrategyContext & { card: AICardInstance },
): ReplyStrategy {
  const { card, config, log } = ctx;

  const controller = createCardDraftController({ card, log });
  let finalTextForFallback: string | undefined;
  let sawFinalDelivery = false;

  const getRenderedTimeline = (options: { preferFinalAnswer?: boolean } = {}): string => {
    const fallbackAnswer = finalTextForFallback || (sawFinalDelivery ? FILE_ONLY_FALLBACK_ANSWER : undefined);
    return controller.getRenderedContent({
      fallbackAnswer,
      overrideAnswer: options.preferFinalAnswer ? finalTextForFallback : undefined,
    });
  };

  return {
    getReplyOptions(): ReplyOptions {
      return {
        // Card mode: intermediate blocks are unused — card updates go through
        // onPartialReply (real-time) or deliver(final) -> finishAICard.
        disableBlockStreaming: true,

        onAssistantMessageStart: async () => {
          await controller.notifyNewAssistantTurn();
        },

        onModelSelected: (modelCtx) => {
          updateSessionState(ctx.accountId, card.conversationId, {
            model: modelCtx.model,
            effort: modelCtx.thinkLevel,
          }, log);
        },

        onPartialReply: config.cardRealTimeStream
          ? async (payload) => {
              if (payload.text) {
                await controller.updateAnswer(payload.text);
              }
            }
          : undefined,

        onReasoningStream: async (payload) => {
          if (payload.text) {
            await controller.updateThinking(payload.text);
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
        log?.info?.(
          `[DingTalk] Tool result received, streaming to AI Card: ${(textToSend ?? "").slice(0, 100)}`,
        );
        await controller.appendTool(textToSend ?? "");
        return;
      }

      // ---- block: only handle media (text blocks are unused) ----
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

      if (card.state === AICardStatus.FINISHED) {
        log?.info?.("[DingTalk][Finalize] Skipping — card already FINISHED");
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
        clearSessionState(ctx.accountId, card.conversationId);
        return;
      }

      // Normal finalize.
      try {
        await controller.flush();
        await controller.waitForInFlight();
        controller.stop();

        // Assemble taskInfo from session state
        const sessionState = getSessionState(ctx.accountId, card.conversationId);
        const taskTime = getTaskTimeSeconds(ctx.accountId, card.conversationId);
        const taskInfo: CardTaskInfo = {
          model: sessionState?.model,
          effort: sessionState?.effort,
          taskTime,
          dap_usage: sessionState?.dapiCount,
        };
        log?.debug?.(`[DingTalk][AICard] Finalizing with taskInfo: ${JSON.stringify(taskInfo)}`);

        // Get blockList from controller and ensure answer block is present
        const blockList = controller.getBlockList();
        const hasAnswerBlock = blockList.some((b) => b.type === 0 && b.text.trim().length > 0);

        // If no answer block, add finalTextForFallback or file-only fallback
        if (!hasAnswerBlock) {
          const answerText = finalTextForFallback || (sawFinalDelivery ? FILE_ONLY_FALLBACK_ANSWER : undefined);
          if (answerText) {
            blockList.push({ text: answerText, markdown: answerText, type: 0, mediaId: "", btns: [] });
          }
        } else if (finalTextForFallback) {
          // If there's an answer block but we also have finalTextForFallback,
          // override the last answer block with the final text (for streaming case)
          const lastAnswerIndex = blockList.findLastIndex((b) => b.type === 0);
          if (lastAnswerIndex >= 0 && finalTextForFallback) {
            blockList[lastAnswerIndex] = {
              text: finalTextForFallback,
              markdown: finalTextForFallback,
              type: 0,
              mediaId: "",
              btns: [],
            };
          }
        }

        log?.info?.(
          `[DingTalk][Finalize] Calling finishAICard — blockListLen=${blockList.length} ` +
          `source=${controller.getFinalAnswerContent() ? "timeline.answer" : sawFinalDelivery ? "timeline.fileOnly" : "fallbackDone"}`,
        );
        await finishAICard(card, blockList, log, {
          quotedRef: ctx.replyQuotedRef,
        });

        // Clean up session state after successful finalize
        clearSessionState(ctx.accountId, card.conversationId);

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
          const blockList = controller.getBlockList();
          if (blockList.length > 0) {
            await finishAICard(card, blockList, log);
          } else {
            const errorBlock: CardBlock[] = [{ text: "❌ 处理失败", markdown: "❌ 处理失败", type: 0, mediaId: "", btns: [] }];
            await finishAICard(card, errorBlock, log);
          }
        } catch (cardCloseErr: unknown) {
          log?.debug?.(`[DingTalk] Failed to finalize card after dispatch error: ${(cardCloseErr as Error).message}`);
          card.state = AICardStatus.FAILED;
          card.lastUpdated = Date.now();
        }
      }
      // Clear session state after abort (success or failure)
      clearSessionState(ctx.accountId, card.conversationId);
    },

    getFinalText(): string | undefined {
      return controller.getFinalAnswerContent()
        || finalTextForFallback
        || (sawFinalDelivery ? FILE_ONLY_FALLBACK_ANSWER : undefined);
    },
  };
}
