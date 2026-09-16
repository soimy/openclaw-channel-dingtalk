/**
 * Shared type definitions for reply strategy implementations.
 *
 * Extracted into a leaf module so that the factory (reply-strategy.ts) and
 * concrete strategies (reply-strategy-card.ts, reply-strategy-markdown.ts)
 * can share these interfaces without circular imports.
 */

import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEventsSurface } from "../platform/runtime-events";
import type { DingTalkConfig, Logger, QuotedRef } from "../platform/types";

// ---- Internal helper type ----

export type InternalReplyStrategyConfig = DingTalkConfig & {
  /** @deprecated Internal compatibility only. Removed from public config surface. */
  cardStreamReasoning?: boolean;
};

export type SourceReplyDeliveryMode = "automatic" | "message_tool_only";

// ---- Public interfaces ----

export interface DeliverPayload {
  text?: string;
  mediaUrls: string[];
  /**
   * Shared reply-runtime voice hint. Strategies forward this unchanged into the
   * channel media delivery helper; inbound-handler is responsible for bridging
   * legacy aliases (for example `asVoice`) into this single field.
   */
  audioAsVoice?: boolean;
  kind: "block" | "final" | "tool";
  isError?: boolean;
  isReasoning?: boolean;
}

export interface ReplyOptions {
  disableBlockStreaming: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  onPartialReply?: (payload: { text?: string }) => void | Promise<void>;
  onReasoningStream?: (payload: { text?: string }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onAgentRunStart?: GetReplyOptions["onAgentRunStart"];
  onModelSelected?: GetReplyOptions["onModelSelected"];
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

  /**
   * Release strategy-owned resources (timers, event subscriptions) without
   * touching the delivery surface. Idempotent, and safe to call after
   * `finalize()`/`abort()`. Callers must invoke this even on early-return
   * paths so a strategy that never finalized cannot leak.
   */
  dispose(): Promise<void>;

  /** Last known final text (for external consumers such as logging). */
  getFinalText(): string | undefined;
}

/** Shared context passed to every strategy implementation. */
export interface TaskMeta {
  model?: string;
  effort?: string;
  usage?: number;
  elapsedMs?: number;
  agent?: string;
  runIds?: Set<string>;
}

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
  /**
   * Host-authorized local media roots for this agent/session. Reply media that
   * resolves to a host path must carry these: the runtime media bridge rejects
   * `workspace-<agentId>` paths unless the caller passes the scoped roots, and
   * the plugin must never derive a boundary from a model-produced path.
   */
  mediaLocalRoots?: string[];
  /**
   * Channel-level media delivery hook. The `audioAsVoice` option is the same
   * shared voice semantic carried on DeliverPayload, not a second independent
   * config knob.
   */
  deliverMedia: (urls: string[], options?: { audioAsVoice?: boolean }) => Promise<void>;
  isStopRequested?: () => boolean;
  inboundText?: string;
  taskMeta?: TaskMeta;
  runtimeEvents?: RuntimeEventsSurface;
}
