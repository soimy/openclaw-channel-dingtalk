/**
 * Markdown / text reply strategy.
 *
 * DingTalk cannot edit prior messages in place, so markdown mode emits
 * incremental answer tails from dispatcher-delivered block/final payloads.
 * Reasoning display is intentionally unsupported on DingTalk markdown.
 */

import type { DeliverPayload, ReplyOptions, ReplyStrategy, ReplyStrategyContext } from "./reply-strategy";
import { sendMessage } from "./send-service";

function renderQuotedSegment(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim() ? `> ${line.trim()}` : ">")
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

export function createMarkdownReplyStrategy(
  ctx: ReplyStrategyContext,
): ReplyStrategy {
  let finalText: string | undefined;
  let activeAnswerText = "";
  let lastSentAnswerText = "";

  const sendMarkdownSegment = async (text: string): Promise<void> => {
    if (!text.trim()) {
      return;
    }
    ctx.log?.debug?.(
      `[DingTalk][Markdown] send segment len=${text.length} preview=${JSON.stringify(text.slice(0, 160))}`,
    );
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
      lastSentAnswerText = "";
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
      ctx.log?.debug?.(
        `[DingTalk][Markdown] deliver kind=${payload.kind} media=${payload.mediaUrls.length} ` +
        `textLen=${typeof payload.text === "string" ? payload.text.length : 0} ` +
        `preview=${typeof payload.text === "string" ? JSON.stringify(payload.text.slice(0, 160)) : "\"\""}`,
      );
      if (payload.mediaUrls.length > 0) {
        await ctx.deliverMedia(payload.mediaUrls);
      }

      if (payload.kind === "tool") {
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        if (!text) {
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
      // Markdown mode delivers incrementally during block/final delivery.
    },

    async abort(): Promise<void> {
      // Nothing to clean up.
    },

    getFinalText(): string | undefined {
      return finalText || activeAnswerText || undefined;
    },
  };
}
