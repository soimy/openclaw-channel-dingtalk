/**
 * AI Card reply strategy (placeholder — full implementation in commit 2).
 *
 * For now, re-exports a stub that throws so the factory never
 * accidentally uses it before implementation is ready.
 */

import type { ReplyStrategy, ReplyStrategyContext } from "./reply-strategy";
import type { AICardInstance } from "./types";

export function createCardReplyStrategy(
  _ctx: ReplyStrategyContext & { card: AICardInstance },
): ReplyStrategy {
  throw new Error(
    "CardReplyStrategy is not yet implemented — " +
    "card mode should still use the inline path in inbound-handler until commit 2.",
  );
}
