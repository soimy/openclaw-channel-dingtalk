/**
 * Markdown / text reply strategy.
 *
 * DingTalk cannot edit prior messages in place, so markdown mode emits
 * incremental answer tails from dispatcher-delivered block/final payloads.
 * Reasoning display is intentionally unsupported on DingTalk markdown.
 */

import path from "node:path";
import { resolveRelativePath } from "./config";
import { prepareMediaInput, resolveOutboundMediaType } from "./media-utils";
import type {
  DeliverPayload,
  ReplyOptions,
  ReplyStrategy,
  ReplyStrategyContext,
} from "./reply-strategy-types";
import { sendMessage } from "./send-service";

const EMPTY_FINAL_FALLBACK_TEXT = "✅ Done";

function renderQuotedSegment(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

function computeIncrementalSuffix(previous: string, next: string): string {
  const prev = previous || "";
  const current = next || "";
  if (!current.trim()) {
    return "";
  }
  if (!prev) {
    return current;
  }
  if (!current.startsWith(prev)) {
    return "";
  }
  const suffix = current.slice(prev.length);
  return suffix.trim() ? suffix : "";
}

function computeSharedPrefixTail(previous: string, next: string): string {
  const prev = previous || "";
  const current = next || "";
  if (!prev || !current.trim()) {
    return "";
  }
  const limit = Math.min(prev.length, current.length);
  let sharedPrefixLength = 0;
  while (sharedPrefixLength < limit && prev[sharedPrefixLength] === current[sharedPrefixLength]) {
    sharedPrefixLength += 1;
  }
  if (sharedPrefixLength === 0) {
    return "";
  }
  const suffix = current.slice(sharedPrefixLength);
  return suffix.trim() ? suffix : "";
}

function renderMarkdownImage(mediaPath: string): string {
  const filename = path.basename(mediaPath) || "image";
  return `![${filename}](${mediaPath})`;
}

export function createMarkdownReplyStrategy(ctx: ReplyStrategyContext): ReplyStrategy {
  let finalText: string | undefined;
  let activeAnswerText = "";
  let lastSentAnswerText = "";
  let sentVisibleContent = false;

  const sendMarkdownSegment = async (text: string): Promise<void> => {
    if (!text.trim()) {
      return;
    }
    const sendResult = await sendMessage(ctx.config, ctx.to, text, {
      sessionWebhook: ctx.sessionWebhook,
      atUserId: !ctx.isDirect ? ctx.senderId : null,
      log: ctx.log,
      accountId: ctx.accountId,
      storePath: ctx.storePath,
      conversationId: ctx.groupId,
      quotedRef: ctx.replyQuotedRef,
    });
    if (!sendResult.ok) {
      throw new Error(sendResult.error || "Reply send failed");
    }
    sentVisibleContent = true;
  };

  const takeAnswerSuffix = (text: string | undefined): string => {
    const current = typeof text === "string" ? text : "";
    if (current.length > 0) {
      activeAnswerText = current;
      finalText = current;
    }

    const suffix = computeIncrementalSuffix(lastSentAnswerText, current);
    if (suffix) {
      lastSentAnswerText = current;
      return suffix;
    }

    if (current.trim() && lastSentAnswerText && !current.startsWith(lastSentAnswerText)) {
      const suffix = computeSharedPrefixTail(lastSentAnswerText, current);
      ctx.log?.warn?.(
        `[DingTalk][Markdown] answer prefix drift detected; falling back to shared-prefix tail ` +
          `prevLen=${lastSentAnswerText.length} currentLen=${current.length}`,
      );
      lastSentAnswerText = "";
      if (suffix) {
        lastSentAnswerText = current;
        return suffix;
      }
      lastSentAnswerText = current;
      return current;
    }

    return "";
  };

  const emitAnswerSuffix = async (text: string | undefined): Promise<void> => {
    const suffix = takeAnswerSuffix(text);
    if (suffix) {
      await sendMarkdownSegment(suffix);
    }
  };

  const prepareMarkdownImageAttachments = async (
    mediaUrls: string[],
  ): Promise<{
    imageMarkdown: string[];
    passthroughMediaUrls: string[];
    cleanups: Array<() => Promise<void>>;
  }> => {
    const imageMarkdown: string[] = [];
    const passthroughMediaUrls: string[] = [];
    const cleanups: Array<() => Promise<void>> = [];

    for (const rawMediaUrl of mediaUrls) {
      const preparedMedia = await prepareMediaInput(
        rawMediaUrl,
        ctx.log,
        ctx.config.mediaUrlAllowlist,
      );
      const actualMediaPath = preparedMedia.cleanup
        ? preparedMedia.path
        : resolveRelativePath(preparedMedia.path);
      const mediaType = resolveOutboundMediaType({
        mediaPath: actualMediaPath,
        asVoice: false,
      });

      if (mediaType === "image") {
        imageMarkdown.push(renderMarkdownImage(actualMediaPath));
        if (preparedMedia.cleanup) {
          cleanups.push(preparedMedia.cleanup);
        }
      } else {
        await preparedMedia.cleanup?.();
        passthroughMediaUrls.push(rawMediaUrl);
      }
    }

    return { imageMarkdown, passthroughMediaUrls, cleanups };
  };

  return {
    getReplyOptions(): ReplyOptions {
      return {
        disableBlockStreaming: ctx.disableBlockStreaming === true,
        // DingTalk markdown/sessionWebhook mode owns the visible reply surface.
        // Keep runtime final replies on this strategy even when group chats
        // default source replies to message-tool-only.
        sourceReplyDeliveryMode: "automatic",
      };
    },

    async deliver(payload: DeliverPayload): Promise<void> {
      let answerTextSentWithImages = false;
      let toolTextSentWithImages = false;

      if (payload.mediaUrls.length > 0) {
        const prepared =
          payload.audioAsVoice === true
            ? {
                imageMarkdown: [],
                passthroughMediaUrls: payload.mediaUrls,
                cleanups: [],
              }
            : await prepareMarkdownImageAttachments(payload.mediaUrls);
        try {
          if (prepared.passthroughMediaUrls.length > 0) {
            await ctx.deliverMedia(prepared.passthroughMediaUrls, {
              audioAsVoice: payload.audioAsVoice,
            });
            sentVisibleContent = true;
          }

          if (prepared.imageMarkdown.length > 0) {
            const answerSuffix =
              payload.kind === "block" || payload.kind === "final"
                ? takeAnswerSuffix(payload.text)
                : typeof payload.text === "string"
                  ? renderQuotedSegment(payload.text)
                  : "";
            const markdownParts = [answerSuffix, ...prepared.imageMarkdown].filter(
              (part) => part.trim().length > 0,
            );
            if (markdownParts.length > 0) {
              await sendMarkdownSegment(markdownParts.join("\n\n"));
            }
            answerTextSentWithImages = payload.kind === "block" || payload.kind === "final";
            toolTextSentWithImages = payload.kind === "tool";
          }
        } finally {
          for (const cleanup of prepared.cleanups) {
            await cleanup();
          }
        }
      }

      if (payload.kind === "tool") {
        if (toolTextSentWithImages) {
          return;
        }
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!text.trim()) {
          return;
        }
        await sendMarkdownSegment(renderQuotedSegment(text));
        return;
      }

      if (
        (payload.kind === "block" || payload.kind === "final") &&
        typeof payload.text === "string" &&
        !answerTextSentWithImages
      ) {
        await emitAnswerSuffix(payload.text);
      }
    },

    async finalize(): Promise<void> {
      if (sentVisibleContent) {
        return;
      }
      finalText = EMPTY_FINAL_FALLBACK_TEXT;
      activeAnswerText = EMPTY_FINAL_FALLBACK_TEXT;
      await sendMarkdownSegment(EMPTY_FINAL_FALLBACK_TEXT);
    },

    async abort(): Promise<void> {
      // Nothing to clean up.
    },

    getFinalText(): string | undefined {
      return finalText || activeAnswerText || undefined;
    },
  };
}
