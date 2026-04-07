/**
 * Markdown / text reply strategy.
 *
 * DingTalk cannot edit prior messages in place, so markdown mode emits
 * incremental answer tails from dispatcher-delivered block/final payloads.
 * Reasoning display is intentionally unsupported on DingTalk markdown.
 */

import type { DeliverPayload, ReplyOptions, ReplyStrategy, ReplyStrategyContext } from "./reply-strategy";
import { sendMessage } from "./send-service";

const EMPTY_FINAL_FALLBACK_TEXT = "✅ Done";

function renderQuotedSegment(text: string): string {
  return text
    .split("\n")
    .map((line) => line.length > 0 ? `> ${line}` : ">")
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

export function createMarkdownReplyStrategy(
  ctx: ReplyStrategyContext,
): ReplyStrategy {
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

  const emitAnswerSuffix = async (text: string | undefined): Promise<void> => {
    const current = typeof text === "string" ? text : "";
    if (current.length > 0) {
      activeAnswerText = current;
      finalText = current;
    }

    const suffix = computeIncrementalSuffix(lastSentAnswerText, current);
    if (suffix) {
      await sendMarkdownSegment(suffix);
      lastSentAnswerText = current;
      return;
    }

    if (current.trim() && lastSentAnswerText && !current.startsWith(lastSentAnswerText)) {
      const suffix = computeSharedPrefixTail(lastSentAnswerText, current);
      ctx.log?.warn?.(
        `[DingTalk][Markdown] answer prefix drift detected; falling back to shared-prefix tail ` +
        `prevLen=${lastSentAnswerText.length} currentLen=${current.length}`,
      );
      lastSentAnswerText = "";
      if (suffix) {
        await sendMarkdownSegment(suffix);
        lastSentAnswerText = current;
        return;
      }
      await sendMarkdownSegment(current);
      lastSentAnswerText = current;
    }
  };

  return {
    getReplyOptions(): ReplyOptions {
      return {
        disableBlockStreaming: ctx.disableBlockStreaming === true,
      };
    },

    async deliver(payload: DeliverPayload): Promise<void> {
      if (payload.mediaUrls.length > 0) {
        await ctx.deliverMedia(payload.mediaUrls);
        sentVisibleContent = true;
      }

      if (payload.kind === "tool") {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!text.trim()) {
          return;
        }
        await sendMarkdownSegment(renderQuotedSegment(text));
        return;
      }

      if (
        (payload.kind === "block" || payload.kind === "final")
        && typeof payload.text === "string"
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
