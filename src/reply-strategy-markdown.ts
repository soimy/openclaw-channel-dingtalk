/**
 * Markdown / text reply strategy.
 *
 * Consumes reasoning / tool / answer events directly and emits new markdown
 * session messages for each incremental segment. Unlike card mode, webhook
 * messages cannot be edited in place, so this strategy only sends new tails.
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
  return current.slice(prev.length).trimStart();
}

export function createMarkdownReplyStrategy(
  ctx: ReplyStrategyContext,
): ReplyStrategy {
  let finalText: string | undefined;
  let activeThinkingText = "";
  let lastSentThinkingText = "";
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

  const emitThinkingSuffix = async (text: string | undefined): Promise<void> => {
    const current = typeof text === "string" ? text : "";
    activeThinkingText = current;
    const suffix = computeIncrementalSuffix(lastSentThinkingText, current);
    if (suffix) {
      await sendMarkdownSegment(renderQuotedSegment(suffix));
      lastSentThinkingText = current;
      return;
    }
    if (current.trim() && lastSentThinkingText && !current.startsWith(lastSentThinkingText)) {
      // Markdown messages cannot be edited in place. If runtime rewrites prior
      // thinking content instead of extending it, drop this update and let the
      // next monotonic growth start from a clean cursor.
      lastSentThinkingText = "";
    }
  };

  const emitAnswerSuffix = async (text: string | undefined): Promise<void> => {
    const current = typeof text === "string" ? text : "";
    activeAnswerText = current;
    const suffix = computeIncrementalSuffix(lastSentAnswerText, current);
    if (suffix) {
      await sendMarkdownSegment(suffix);
      lastSentAnswerText = current;
      return;
    }
    if (current.trim() && lastSentAnswerText && !current.startsWith(lastSentAnswerText)) {
      lastSentAnswerText = "";
    }
  };

  return {
    getReplyOptions(): ReplyOptions {
      return {
        disableBlockStreaming: false,
        onReasoningStream: async (payload) => {
          await emitThinkingSuffix(payload.text);
        },
        onPartialReply: async (payload) => {
          await emitAnswerSuffix(payload.text);
        },
        onAssistantMessageStart: async () => {
          activeAnswerText = "";
          lastSentAnswerText = "";
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
        activeThinkingText = "";
        lastSentThinkingText = "";
        await sendMarkdownSegment(renderQuotedSegment(text));
        return;
      }

      if (payload.kind === "final" && typeof payload.text === "string") {
        finalText = payload.text;
        await emitAnswerSuffix(payload.text);
      }
    },

    async finalize(): Promise<void> {
      // Markdown mode delivers incrementally during callbacks / deliver(final).
    },

    async abort(): Promise<void> {
      // Nothing to clean up.
    },

    getFinalText(): string | undefined {
      return finalText || activeAnswerText || undefined;
    },
  };
}
