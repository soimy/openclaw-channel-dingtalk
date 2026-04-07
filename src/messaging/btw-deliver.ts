import { sendBySession, sendMessage } from "../send-service";
import type { DingTalkConfig, Logger } from "../types";

const MAX_QUESTION_LENGTH = 80;
const LEADING_MENTIONS_RE = /^(?:@\S+\s+)*/u;

export function buildBtwBlockquote(senderName: string, rawQuestion: string): string {
  const stripped = rawQuestion.replace(LEADING_MENTIONS_RE, "");
  const truncated =
    stripped.length > MAX_QUESTION_LENGTH ? `${stripped.slice(0, MAX_QUESTION_LENGTH)}…` : stripped;
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
