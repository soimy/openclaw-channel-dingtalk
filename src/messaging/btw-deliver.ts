import { sendBySession, sendMessage } from "../send-service";
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
  const truncated =
    stripped.length > MAX_QUESTION_LENGTH ? `${stripped.slice(0, MAX_QUESTION_LENGTH)}…` : stripped;
  if (senderName) {
    return `> ${senderName}:\n> ${truncated}\n\n`;
  }
  return `> ${truncated}\n\n`;
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

export async function deliverBtwReply(
  args: DeliverBtwReplyArgs,
): Promise<{ ok: boolean; error?: string }> {
  const blockquote = buildBtwBlockquote(args.senderName, args.rawQuestion);
  const fullText = `${blockquote}${args.replyText}`;

  try {
    if (args.sessionWebhook) {
      await sendBySession(args.config, args.sessionWebhook, fullText, {
        log: args.log,
        accountId: args.accountId,
        storePath: args.storePath,
      });
      return { ok: true };
    }
    return await sendMessage(args.config, args.to, fullText, {
      log: args.log,
      accountId: args.accountId,
      storePath: args.storePath,
      conversationId: args.conversationId,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    args.log?.warn?.(`[DingTalk] BTW reply delivery failed: ${error}`);
    return { ok: false, error };
  }
}
