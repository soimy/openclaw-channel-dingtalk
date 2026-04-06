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

type InternalReplyStrategyConfig = DingTalkConfig & {
  /** @deprecated Internal compatibility only. Removed from public config surface. */
  cardStreamReasoning?: boolean;
};

/** Agent run metadata for card taskInfo display. */
export interface TaskMeta {
  model?: string;
  effort?: string;
  usage?: number;
  elapsedMs?: number;
}

export interface DeliverPayload {
  text?: string;
  mediaUrls: string[];
  kind: "block" | "final" | "tool";
  isReasoning?: boolean;
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
  config: InternalReplyStrategyConfig;
  to: string;
  sessionWebhook: string;
  senderId: string;
  isDirect: boolean;
  accountId: string;
  storePath: string;
  disableBlockStreaming?: boolean;
  sessionKey?: string;
  sessionAgentId?: string;
  groupId?: string;
  log?: Logger;
  replyQuotedRef?: QuotedRef;
  deliverMedia: (urls: string[]) => Promise<void>;
  isStopRequested?: () => boolean;
  /** Inbound message text for quoteContent in card template. */
  inboundText?: string;
  /** Agent run metadata for taskInfo in card template. */
  taskMeta?: TaskMeta;
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
