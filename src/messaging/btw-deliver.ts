import { sendMessage } from "../send-service";
import type { DingTalkConfig, Logger } from "../types";

const MAX_QUESTION_LENGTH = 80;
const LEADING_MENTIONS_RE = /^(?:@\S+\s+)*/u;

/**
 * Strip leading `@mention` tokens from inbound text. Used by both the abort and
 * BTW bypass branches in `inbound-handler.ts` so that command detection works
 * uniformly in DM and group chats.
 */
export function stripLeadingMentions(text: string): string {
  return text.replace(LEADING_MENTIONS_RE, "");
}

export function buildBtwBlockquote(senderName: string, rawQuestion: string): string {
  const stripped = stripLeadingMentions(rawQuestion);
  // Iterate by Unicode code points (not UTF-16 code units) so emoji /
  // surrogate pairs aren't sliced in half at the truncation boundary.
  const codePoints = Array.from(stripped);
  const truncated =
    codePoints.length > MAX_QUESTION_LENGTH
      ? `${codePoints.slice(0, MAX_QUESTION_LENGTH).join("")}…`
      : stripped;
  const senderPrefix = senderName ? `${senderName}: ` : "";
  return `> ${senderPrefix}${truncated}\n\n`;
}

export interface DeliverBtwReplyArgs {
  config: DingTalkConfig;
  sessionWebhook: string | undefined;
  conversationId: string;
  to: string;
  senderName: string;
  rawQuestion: string;
  replyText: string;
  log: Logger | undefined;
  accountId?: string;
  storePath?: string;
}

/**
 * Deliver a BTW reply through the unified `sendMessage` entry point.
 *
 * BTW is a special inbound trigger, but the *outbound* reply is still a regular
 * markdown/text message and must inherit the standard send-service semantics:
 * persistence into the message context store, delivery metadata tracking, and
 * the single `{ ok, error, ... }` contract. We pass `forceMarkdown: true` so
 * that `sendMessage` skips the card branch even when the channel is configured
 * for card mode — BTW must never create or touch an AI Card (see CLAUDE.md
 * anti-pattern: "Do not create multiple active AI Cards for the same
 * `accountId:conversationId`").
 *
 * When `sessionWebhook` is present `sendMessage` internally dispatches via
 * `sendBySession`; otherwise it falls back to the proactive text/markdown API.
 * Either way the caller sees the same return shape, and failures propagate as
 * `{ ok: false }` instead of being silently swallowed.
 */
export async function deliverBtwReply(
  args: DeliverBtwReplyArgs,
): Promise<{ ok: boolean; error?: string }> {
  const blockquote = buildBtwBlockquote(args.senderName, args.rawQuestion);
  const fullText = `${blockquote}${args.replyText}`;

  try {
    const result = await sendMessage(args.config, args.to, fullText, {
      log: args.log,
      accountId: args.accountId,
      storePath: args.storePath,
      conversationId: args.conversationId,
      sessionWebhook: args.sessionWebhook,
      forceMarkdown: true,
    });
    if (!result.ok) {
      args.log?.warn?.(
        `[DingTalk] BTW reply delivery returned not-ok: ${result.error ?? "unknown"}`,
      );
    }
    return { ok: result.ok, error: result.error };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    args.log?.warn?.(`[DingTalk] BTW reply delivery threw: ${error}`);
    return { ok: false, error };
  }
}
