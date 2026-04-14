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
  updateAICardTaskInfo,
} from "./card-service";
import { splitCardReasoningAnswerText } from "./card/reasoning-answer-split";
import { createReasoningBlockAssembler } from "./card/reasoning-block-assembler";
import {
  resolveCardStreamingMode,
  shouldWarnDeprecatedCardRealTimeStreamOnce,
} from "./card/card-streaming-mode";
import {
  buildImagePlaceholderText,
  extractMarkdownImageCandidates,
} from "./card/card-markdown-image-reroute";
import { createCardDraftController } from "./card-draft-controller";
import { attachCardRunController } from "./card/card-run-registry";
import type { DeliverPayload, ReplyOptions, ReplyStrategy, ReplyStrategyContext } from "./reply-strategy";
import { resolveRelativePath } from "./config";
import { prepareMediaInput, resolveOutboundMediaType } from "./media-utils";
import { getTaskTimeSeconds, updateSessionState } from "./session-state";
import { sendBySession, sendMessage, sendProactiveMedia, uploadMedia } from "./send-service";
import type { AICardInstance } from "./types";
import { AICardStatus } from "./types";
import { formatDingTalkErrorPayloadLog } from "./utils";

const EMPTY_FINAL_REPLY = "✅ Done";
const DEFAULT_CARD_FAILED_MESSAGE = "回复生成失败，请重试";
type CardReplyLifecycleState = "open" | "final_seen" | "sealed";

/** Deferred media attachment for out-of-card delivery */
interface DeferredMedia {
  url: string;
  type: "voice" | "video" | "file";
}

export function createCardReplyStrategy(
  ctx: ReplyStrategyContext & { card: AICardInstance; isStopRequested?: () => boolean },
): ReplyStrategy {
  const { card, config, log, isStopRequested } = ctx;

  const buildTaskInfoJson = (): string | undefined => {
    if (!ctx.taskMeta) {
      return undefined;
    }
    const info: Record<string, unknown> = {};
    if (!ctx.taskMeta.model && card.taskInfo?.model) {
      ctx.taskMeta.model = card.taskInfo.model;
    }
    if (!ctx.taskMeta.effort && card.taskInfo?.effort) {
      ctx.taskMeta.effort = card.taskInfo.effort;
    }
    const resolvedUsage =
      typeof ctx.taskMeta.usage === "number"
        ? ctx.taskMeta.usage
        : card.taskInfo?.dapi_usage;

    const sessionTaskTimeSeconds = card.accountId && card.conversationId
      ? getTaskTimeSeconds(card.accountId, card.contextConversationId || card.conversationId)
      : undefined;
    const cardElapsedMs = Math.max(0, Date.now() - card.createdAt);
    const sessionElapsedMs = typeof sessionTaskTimeSeconds === "number"
      ? sessionTaskTimeSeconds * 1000
      : undefined;
    const metaElapsedMs = typeof ctx.taskMeta.elapsedMs === "number" && ctx.taskMeta.elapsedMs > 0
      ? ctx.taskMeta.elapsedMs
      : undefined;
    ctx.taskMeta.elapsedMs = Math.max(
      cardElapsedMs,
      sessionElapsedMs ?? 0,
      metaElapsedMs ?? 0,
    );

    if (ctx.taskMeta.model) { info.model = ctx.taskMeta.model; }
    if (ctx.taskMeta.effort) { info.effort = ctx.taskMeta.effort; }
    if (typeof resolvedUsage === "number") { info.dapi_usage = resolvedUsage; }
    if (typeof ctx.taskMeta.elapsedMs === "number") { info.taskTime = Math.round(ctx.taskMeta.elapsedMs / 1000); }
    if (ctx.taskMeta.agent) { info.agent = ctx.taskMeta.agent; }
    return Object.keys(info).length > 0 ? JSON.stringify(info) : undefined;
  };
  const { mode, usedDeprecatedCardRealTimeStream } = resolveCardStreamingMode(config);
  const streamAnswerLive = mode === "answer" || mode === "all";
  const renderAnswerBlocksLive = mode === "all";
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
    realTimeStreamEnabled: streamAnswerLive,
    throttleMs: config.cardStreamInterval ?? 1000,
  });
  const reasoningAssembler = createReasoningBlockAssembler();
  if (card.outTrackId) {
    attachCardRunController(card.outTrackId, controller);
  }
  let finalTextForFallback: string | undefined;
  let sawFinalDelivery = false;
  /** Tracks the latest reasoning snapshot text for non-streaming boundary flush. */
  let latestReasoningSnapshot = "";
  /** Non-image media attachments deferred for out-of-card delivery. */
  let pendingNonImageMedia: DeferredMedia[] = [];

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

  const rewriteLocalMarkdownImagesToPlaceholders = (text: string): string => {
    const candidates = extractMarkdownImageCandidates(text);
    if (candidates.length === 0) {
      return text;
    }

    let nextText = text;
    for (const candidate of candidates.toReversed()) {
      if (candidate.classification !== "local") {
        continue;
      }
      const placeholder = buildImagePlaceholderText({ alt: candidate.alt, url: candidate.url });
      nextText = `${nextText.slice(0, candidate.start)}${placeholder}${nextText.slice(candidate.end)}`;
    }
    return nextText;
  };

  const handleAnswerSnapshot = async (text: string | undefined): Promise<void> => {
    if (!shouldAcceptAnswerSnapshot() || isStopRequested?.()) {
      return;
    }
    if (!text) {
      return;
    }
    await controller.updateAnswer(rewriteLocalMarkdownImagesToPlaceholders(text), {
      stream: streamAnswerLive,
      renderBlocks: renderAnswerBlocksLive,
    });
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

  const rerouteMarkdownImagesFromAnswer = async (text: string): Promise<string> => {
    const candidates = extractMarkdownImageCandidates(text);
    if (candidates.length === 0) {
      return text;
    }

    type SuccessfulReroute = {
      start: number;
      end: number;
      placeholder: string;
      mediaId: string;
      blockText: string;
    };

    let nextText = text;
    const successfulReroutes: SuccessfulReroute[] = [];

    for (const candidate of candidates.toReversed()) {
      if (candidate.classification !== "local") {
        continue;
      }

      let prepared: Awaited<ReturnType<typeof prepareMediaInput>> | undefined;
      try {
        prepared = await prepareMediaInput(candidate.url, log, config.mediaUrlAllowlist);
        const mediaPath = prepared.cleanup
          ? prepared.path
          : resolveRelativePath(prepared.path);
        const mediaType = resolveOutboundMediaType({ mediaPath, asVoice: false });
        if (mediaType !== "image") {
          continue;
        }

        const result = await uploadMedia(config, mediaPath, "image", log);
        if (!result?.mediaId) {
          continue;
        }

        const placeholder = buildImagePlaceholderText({ alt: candidate.alt, url: candidate.url });
        const blockText = candidate.alt.trim() || placeholder.replace(/^见下图/, "").trim() || "图片";
        successfulReroutes.push({
          start: candidate.start,
          end: candidate.end,
          placeholder,
          mediaId: result.mediaId,
          blockText,
        });
        nextText = `${nextText.slice(0, candidate.start)}${placeholder}${nextText.slice(candidate.end)}`;
      } catch {
        // Failure fallback: keep the original markdown unchanged.
      } finally {
        await prepared?.cleanup?.();
      }
    }

    for (const reroute of successfulReroutes.toSorted((left, right) => left.start - right.start)) {
      await controller.appendImageBlock(reroute.mediaId, reroute.blockText);
    }

    return nextText;
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

        onModelSelected: (selected) => {
          if (!card.accountId || !card.conversationId) {
            return;
          }
          updateSessionState(card.accountId, card.contextConversationId || card.conversationId, {
            model: selected.model,
            effort: selected.thinkLevel,
          });
          card.taskInfo = {
            ...card.taskInfo,
            model: selected.model,
            effort: selected.thinkLevel,
          };
          if (ctx.taskMeta) {
            ctx.taskMeta.model = selected.model;
            ctx.taskMeta.effort = selected.thinkLevel;
          }
          const taskInfoJson = buildTaskInfoJson();
          if (taskInfoJson) {
            void updateAICardTaskInfo(card, taskInfoJson, log);
          }
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
        // Inline media upload → image blocks in card; defer non-image attachments
        if (payload.mediaUrls.length > 0) {
          for (const url of payload.mediaUrls) {
            try {
              const prepared = await prepareMediaInput(url, log, config.mediaUrlAllowlist);
              const mediaType = resolveOutboundMediaType({ mediaPath: prepared.path, asVoice: false });
              if (mediaType !== "image") {
                log?.debug?.(`[DingTalk][Card] Deferring non-image media (${mediaType}) for out-of-card delivery: ${url}`);
                // Collect non-image attachments for later delivery
                if (mediaType === "voice" || mediaType === "video" || mediaType === "file") {
                  pendingNonImageMedia.push({ url, type: mediaType });
                }
                await prepared.cleanup?.();
                continue;
              }
              const result = await uploadMedia(config, prepared.path, "image", log);
              await prepared.cleanup?.();
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
          if (payload.isReasoning === true) {
            await applyModeAwareReasoningSnapshot(rawFinalText);
            await flushPendingReasoning();
          } else {
            const rewrittenFinalText = await rerouteMarkdownImagesFromAnswer(rawFinalText);
            const normalizedFinal = await applySplitTextToTimeline(rewrittenFinalText, {
              answerHandling: "capture",
            });
            if (isFirstFinalDelivery && !normalizedFinal.answerText && !normalizedFinal.reasoningText) {
              finalTextForFallback = rewrittenFinalText;
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
            routeReasoningThroughModePolicy: false,
            answerHandling: "ignore",
          });
        } else {
          await applySplitTextToTimeline(rewriteLocalMarkdownImagesToPlaceholders(textToSend), {
            answerHandling: lifecycleState === "open" ? "update" : "capture",
          });
        }
      }

      // ---- block: only handle reasoning/media (other text blocks are unused) ----
      if (payload.mediaUrls.length > 0) {
        for (const url of payload.mediaUrls) {
          try {
            const prepared = await prepareMediaInput(url, log, config.mediaUrlAllowlist);
            const mediaType = resolveOutboundMediaType({ mediaPath: prepared.path, asVoice: false });
            if (mediaType !== "image") {
              log?.debug?.(`[DingTalk][Card] Deferring non-image media (${mediaType}) for out-of-card delivery: ${url}`);
              pendingNonImageMedia.push({ url, type: mediaType });
              await prepared.cleanup?.();
              continue;
            }
            const result = await uploadMedia(config, prepared.path, "image", log);
            await prepared.cleanup?.();
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
        lifecycleState = "sealed";
        return;
      }

      if (card.state === AICardStatus.FINISHED) {
        log?.info?.("[DingTalk][Finalize] Skipping — card already FINISHED");
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
          || DEFAULT_CARD_FAILED_MESSAGE;
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

      // Normal finalize (V2 template path: single instances API call).
      try {
        await flushPendingReasoning();

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

        const inboundQuoteText = (ctx.inboundText || "").trim().slice(0, 200);

        // Build taskInfo JSON for card template
        const taskInfoJson = buildTaskInfoJson();

        await commitAICardBlocks(card, {
          blockListJson,
          content,
          quoteContent: inboundQuoteText || undefined,
          taskInfoJson,
          quotedRef: ctx.replyQuotedRef,
        }, log);

        // Send deferred non-image attachments after card finalize
        // Use sessionWebhook for reply-session semantics; fallback to proactive if unavailable.
        if (pendingNonImageMedia.length > 0) {
          log?.debug?.(`[DingTalk][Card] Sending ${pendingNonImageMedia.length} deferred non-image attachments`);
          for (const { url, type } of pendingNonImageMedia) {
            try {
              const prepared = await prepareMediaInput(url, log, config.mediaUrlAllowlist);
              const actualMediaPath = prepared.path;

              // Prefer sessionWebhook for reply-session permission semantics
              if (ctx.sessionWebhook) {
                const sendResult = await sendMessage(config, ctx.to, "", {
                  sessionWebhook: ctx.sessionWebhook,
                  mediaPath: actualMediaPath,
                  mediaType: type,
                  log,
                  accountId: ctx.accountId,
                  storePath: ctx.storePath,
                });
                if (!sendResult.ok) {
                  log?.warn?.(`[DingTalk][Card] Deferred media session send failed: ${sendResult.error || "unknown"}`);
                }
              } else {
                // Fallback: proactive send when no reply session available
                const result = await sendProactiveMedia(config, ctx.to, actualMediaPath, type, {
                  log,
                  accountId: ctx.accountId,
                });
                if (!result.ok) {
                  log?.warn?.(`[DingTalk][Card] Deferred media proactive send failed: ${result.error || "unknown"}`);
                }
              }

              await prepared.cleanup?.();
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              log?.warn?.(`[DingTalk][Card] Failed to send deferred media: ${msg}`);
            }
          }
          pendingNonImageMedia = []; // Clear after sending
        }

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
