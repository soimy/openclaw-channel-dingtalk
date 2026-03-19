/**
 * Markdown / text reply strategy.
 *
 * Buffers all blocks (disableBlockStreaming=true) and delivers the
 * final text as a single message via sendMessage.
 */

import type { DeliverPayload, ReplyOptions, ReplyStrategy, ReplyStrategyContext } from "./reply-strategy";
import { sendMessage } from "./send-service";

export function createMarkdownReplyStrategy(
  ctx: ReplyStrategyContext,
): ReplyStrategy {
  let finalText: string | undefined;

  return {
    getReplyOptions(): ReplyOptions {
      return { disableBlockStreaming: true };
    },

    async deliver(payload: DeliverPayload): Promise<void> {
      if (payload.mediaUrls.length > 0) {
        await ctx.deliverMedia(payload.mediaUrls);
      }

      if (payload.kind === "final" && typeof payload.text === "string" && payload.text.length > 0) {
        finalText = payload.text;
        const sendResult = await sendMessage(ctx.config, ctx.to, payload.text, {
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
      }
    },

    async finalize(): Promise<void> {
      // Markdown mode: delivery already happened in deliver(final).
    },

    async abort(): Promise<void> {
      // Nothing to clean up.
    },

    getFinalText(): string | undefined {
      return finalText;
    },
  };
}
