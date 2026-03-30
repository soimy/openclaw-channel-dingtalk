/**
 * Markdown / text reply strategy.
 *
 * DingTalk cannot edit prior messages in place, so this strategy uses block
 * replies for stable reasoning-on behavior and keeps final delivery as a
 * tail-only fallback. Live reasoning streams are intentionally unsupported.
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

  const sendAnswerText = async (text: string): Promise<void> => {
    if (!text.trim()) {
      return;
    }
    activeAnswerText = text;
    finalText = text;
    await sendMarkdownSegment(text);
    lastSentAnswerText = text;
  };

  return {
    getReplyOptions(): ReplyOptions {
      return {
        disableBlockStreaming: false,
        onBlockReply: async (payload) => {
          if (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0) {
            await ctx.deliverMedia(payload.mediaUrls);
          }
          const text = typeof payload.text === "string" ? payload.text : "";
          if (!text.trim()) {
            return;
          }
          if (payload.isReasoning === true) {
            await sendMarkdownSegment(renderQuotedSegment(text));
            return;
          }
          await sendAnswerText(text);
        },
      };
    },

    async deliver(payload: DeliverPayload): Promise<void> {
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
        payload.kind === "final"
        && typeof payload.text === "string"
        && payload.text.length > 0
      ) {
        activeAnswerText = payload.text;
        finalText = payload.text;
        const suffix = computeIncrementalSuffix(lastSentAnswerText, payload.text);
        if (!suffix) {
          return;
        }
        await sendMarkdownSegment(suffix);
        lastSentAnswerText = payload.text;
      }
    },

    async finalize(): Promise<void> {
      // Markdown mode delivers through block replies and final tails.
    },

    async abort(): Promise<void> {
      // Nothing to clean up.
    },

    getFinalText(): string | undefined {
      return finalText || activeAnswerText || undefined;
    },
  };
}
