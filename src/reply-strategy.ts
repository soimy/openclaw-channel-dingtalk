/**
 * Reply strategy factory for DingTalk message delivery.
 *
 * Delegates the "how to deliver a reply" concern to card or markdown
 * strategy implementations. Type definitions live in reply-strategy-types.ts.
 */

import type { AICardInstance } from "./types";
import type { ReplyStrategy, ReplyStrategyContext } from "./reply-strategy-types";
import { createCardReplyStrategy } from "./reply-strategy-card";
import { createMarkdownReplyStrategy } from "./reply-strategy-markdown";

// Re-export all types so existing consumers that import from "./reply-strategy"
// continue to work without changes beyond the ones we explicitly migrate.
export type {
  DeliverPayload,
  ReplyOptions,
  ReplyStrategy,
  ReplyStrategyContext,
  TaskMeta,
} from "./reply-strategy-types";

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
