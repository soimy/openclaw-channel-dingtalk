/**
 * Reply strategy interface for DingTalk message delivery.
 *
 * Abstracts the "how to deliver a reply" concern away from
 * handleDingTalkMessage, so card and markdown modes each manage
 * their own state and lifecycle independently.
 */

import type { AICardInstance, DingTalkConfig, Logger, QuotedRef } from "./types";
import { createCardReplyStrategy } from "./reply-strategy-card";
import { createMarkdownReplyStrategy } from "./reply-strategy-markdown";

// ---- Public types ------------------------------------------------

export interface DeliverPayload {
  text?: string;
  mediaUrls: string[];
  kind: "block" | "final" | "tool";
}

export interface ReplyOptions {
  disableBlockStreaming: boolean;
  onPartialReply?: (payload: { text?: string }) => void | Promise<void>;
  onReasoningStream?: (payload: { text?: string }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
}

export interface ReplyStrategy {
  /** Options forwarded to the runtime dispatcher. */
  getReplyOptions(): ReplyOptions;

  /** Called by the deliver callback for each payload chunk. */
  deliver(payload: DeliverPayload): Promise<void>;

  /** Called after dispatch completes successfully. */
  finalize(): Promise<void>;

  /** Called when dispatch throws an error. */
  abort(error: Error): Promise<void>;

  /** Last known final text (for external consumers such as logging). */
  getFinalText(): string | undefined;
}

/** Shared context passed to every strategy implementation. */
export interface ReplyStrategyContext {
  config: DingTalkConfig;
  to: string;
  sessionWebhook: string;
  senderId: string;
  isDirect: boolean;
  accountId: string;
  storePath: string;
  groupId?: string;
  log?: Logger;
  replyQuotedRef?: QuotedRef;
  deliverMedia: (urls: string[]) => Promise<void>;
}

// ---- Factory -----------------------------------------------------

export function createReplyStrategy(
  params: ReplyStrategyContext & {
    card: AICardInstance | undefined;
    useCardMode: boolean;
  },
): ReplyStrategy {
  if (params.useCardMode && params.card) {
    return createCardReplyStrategy({ ...params, card: params.card });
  }
  return createMarkdownReplyStrategy(params);
}
