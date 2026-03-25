/**
 * AI Card reply strategy.
 *
 * Encapsulates the card draft controller lifecycle, deliver routing
 * (final / tool / block), finalization, and failure fallback so that
 * inbound-handler only coordinates — it no longer owns card state.
 */

import {
  finishAICard,
  formatContentForCard,
  isCardInTerminalState,
} from "./card-service";
import { createCardDraftController } from "./card-draft-controller";
import type { DeliverPayload, DispatchCounts, ReplyOptions, ReplyStrategy, ReplyStrategyContext } from "./reply-strategy";
import { sendBySession, sendMessage } from "./send-service";
import type { AICardInstance } from "./types";
import { AICardStatus } from "./types";
import { formatDingTalkErrorPayloadLog } from "./utils";

export function createCardReplyStrategy(
  ctx: ReplyStrategyContext & { card: AICardInstance },
): ReplyStrategy {
  const { card, config, log } = ctx;

  const controller = createCardDraftController({ card, log });
  let finalTextForFallback: string | undefined;

  return {
    getReplyOptions(): ReplyOptions {
      return {
        // Card mode: intermediate blocks are unused — card updates go through
        // onPartialReply (real-time) or deliver(final) -> finishAICard.
        disableBlockStreaming: true,

        onAssistantMessageStart: () => {
          controller.notifyNewAssistantTurn();
        },

        onPartialReply: config.cardRealTimeStream
          ? (payload) => {
              if (payload.text) {
                controller.updateAnswer(payload.text);
              }
            }
          : undefined,

        onReasoningStream: (payload) => {
          if (payload.text) {
            controller.updateReasoning(payload.text);
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
        await controller.flush();
        await controller.waitForInFlight();
        log?.info?.(
          `[DingTalk] Tool result received, streaming to AI Card: ${(textToSend ?? "").slice(0, 100)}`,
        );
        const toolText = typeof textToSend === "string" ? formatContentForCard(textToSend, "tool") : "";
        if (toolText) {
          const sendResult = await sendMessage(ctx.config, ctx.to, toolText, {
            sessionWebhook: ctx.sessionWebhook,
            atUserId: !ctx.isDirect ? ctx.senderId : null,
            log,
            card,
            accountId: ctx.accountId,
            storePath: ctx.storePath,
            conversationId: ctx.groupId,
            cardUpdateMode: "append",
          });
          if (!sendResult.ok) {
            throw new Error(sendResult.error || "Tool stream send failed");
          }
        }
        return;
      }

      // ---- block: only handle media (text blocks are unused) ----
      if (payload.mediaUrls.length > 0) {
        await ctx.deliverMedia(payload.mediaUrls);
      }
    },

    async finalize(counts?: DispatchCounts): Promise<void> {
      const finalCount = counts?.final ?? 0;
      log?.info?.(
        `[DingTalk][Finalize] Step 5 entry — ` +
        `cardState=${card.state ?? "N/A"} ` +
        `controllerFailed=${controller.isFailed()} ` +
        `counts=${JSON.stringify(counts ?? {})} ` +
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
        const fallbackText = finalTextForFallback
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
        await controller.flush();
        await controller.waitForInFlight();
        controller.stop();

        const toolCount = counts?.tool ?? 0;
        const lastAnswer = controller.getLastAnswerContent();
        const lastContent = controller.getLastContent();

        const finalText = lastAnswer
          || finalTextForFallback
          || (toolCount > 0 ? card.lastStreamedContent : undefined)
          || lastContent
          || undefined;

        if (!finalText) {
          const noDispatchActivity = finalCount === 0 && toolCount === 0
            && !lastAnswer && !lastContent && !finalTextForFallback;
          if (noDispatchActivity) {
            log?.warn?.(
              "[DingTalk][Finalize] Agent produced no content — closing card silently",
            );
          } else {
            log?.warn?.(
              "[DingTalk][Finalize] Dispatch completed but no final text available — closing card with interruption notice",
            );
          }
          const closeText = noDispatchActivity
            ? ""
            : "⚠️ 未收到最终回复，请重新发送。";
          try {
            await finishAICard(card, closeText, log);
          } catch {
            // Best-effort close; card will expire naturally if this fails.
          }
          return;
        }

        const source = lastAnswer
          ? "lastAnswerContent"
          : finalTextForFallback
            ? "finalTextForFallback"
            : toolCount > 0 && card.lastStreamedContent
              ? "toolStreamContent"
              : lastContent
                ? "lastContent"
                : "unknown";
        log?.info?.(
          `[DingTalk][Finalize] Calling finishAICard — finalTextLen=${finalText.length} ` +
          `source=${source} ` +
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
      return controller.getLastAnswerContent() || finalTextForFallback;
    },
  };
}
