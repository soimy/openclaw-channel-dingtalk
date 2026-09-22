/**
 * Conversation-scoped outbound send throttle.
 *
 * DingTalk cannot edit an already-sent message, so streaming replies are
 * appended as separate messages (markdown incremental tails) and oversized
 * payloads are split into several messages. When several of those land within
 * the same second, the DingTalk client can display them out of order
 * (issue #626: 6 streamed chunks came back as 1,2,3,5,4,6).
 *
 * Consecutive sends to one conversation are therefore spaced by
 * `outboundSendIntervalMs` (default 1000ms), and — because spacing *start*
 * times alone still lets a slow send overlap the next one and finish after it —
 * the sends themselves run through a per-conversation chain, so a send is only
 * admitted once the previous one has settled. Ordering is what the client sees,
 * and that is completion order.
 *
 * `0` disables both, and sends to different conversations never wait on each
 * other.
 */

import type { Logger } from "../platform/types";

/**
 * Default spacing between consecutive outbound messages to one conversation.
 *
 * 1000ms is the value verified on a real device: 6 streamed chunks that all
 * landed in the same second came back as `1,2,3,5,4,6`, and spreading them over
 * 6 distinct seconds restored the order (issue #626). It is deliberately
 * conservative — the minimum effective interval was never measured.
 *
 * Single source of truth: `config-schema.ts` declares it as the schema default
 * and `tests/unit/plugin-manifest.test.ts` binds the manifest declaration to it.
 */
export const DEFAULT_OUTBOUND_SEND_INTERVAL_MS = 1000;

/** Drop idle scopes once the map grows past this size, to bound memory. */
const SCOPE_PRUNE_THRESHOLD = 256;

/** A scope idle for longer than this cannot delay any future send. */
const SCOPE_IDLE_TTL_MS = 10 * 60 * 1000;

type ScopeState = {
  /** Tail of the per-scope send chain. Always settles, never rejects. */
  chain: Promise<void>;
  /** When the last admitted send started, in epoch milliseconds. */
  lastStartAt: number;
};

/** In-flight/cooldown state per conversation scope. */
const scopeStates = new Map<string, ScopeState>();

/** Test seam: forget every scope so the next send starts from a clean slate. */
export function resetOutboundSendThrottle(): void {
  scopeStates.clear();
}

function pruneIdleScopes(now: number): void {
  if (scopeStates.size <= SCOPE_PRUNE_THRESHOLD) {
    return;
  }
  for (const [scope, state] of scopeStates) {
    // The TTL is far longer than any send, so an idle scope has no in-flight
    // operation left to serialize against.
    if (state.lastStartAt + SCOPE_IDLE_TTL_MS < now) {
      scopeStates.delete(scope);
    }
  }
}

/**
 * Build the throttle key for an outbound message. Returns `undefined` when the
 * caller cannot identify the conversation, in which case throttling is skipped
 * rather than serializing unrelated conversations behind one global slot.
 *
 * The account is part of the key: distinct accounts may legitimately reuse a
 * conversation id, and their delivery streams are unrelated.
 */
export function resolveOutboundThrottleScope(params: {
  accountId?: string;
  conversationId?: string;
}): string | undefined {
  const conversationId = params.conversationId?.trim();
  if (!conversationId) {
    return undefined;
  }
  return `${params.accountId ?? "default"}:${conversationId}`;
}

/**
 * Run one outbound send under the conversation's ordering guarantee.
 *
 * The operation is admitted only after the previous send to the same scope has
 * settled, and no sooner than `intervalMs` after that send started. Because the
 * spacing is measured from the previous *start*, a fast send still yields the
 * real-device-verified ~1s cadence, while a slow one delays the next instead of
 * overlapping it.
 *
 * A failing operation rejects to its own caller without breaking the chain, so
 * one failed send cannot wedge every later send to that conversation.
 */
export async function runThrottledOutboundSend<T>(
  scopeKey: string | undefined,
  intervalMs: number,
  operation: () => Promise<T>,
  log?: Logger,
): Promise<T> {
  if (!scopeKey || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return operation();
  }

  pruneIdleScopes(Date.now());
  const previous = scopeStates.get(scopeKey);

  // Seeded with "now" rather than 0 so a send queued behind a slow predecessor
  // is not mistaken for an idle scope and pruned before it is admitted; the real
  // start time overwrites this as soon as the send is admitted.
  const state: ScopeState = { chain: Promise.resolve(), lastStartAt: Date.now() };

  const pending = (async () => {
    if (previous) {
      await previous.chain;
      // Read the predecessor's start time only *after* it settled. A caller
      // queued in the same tick as its predecessor would otherwise capture the
      // placeholder value from before that send was admitted, compute a
      // negative wait, and start immediately — losing the spacing entirely.
      const waitMs = previous.lastStartAt + intervalMs - Date.now();
      if (waitMs > 0) {
        // Logged so a real-device run can prove the throttle engaged (issue #626)
        // instead of inferring it from wall-clock timing.
        log?.debug?.(
          `[DingTalk] Outbound send throttled scope=${scopeKey} waitMs=${waitMs} intervalMs=${intervalMs}`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    state.lastStartAt = Date.now();
    return operation();
  })();

  // Assigned synchronously right after the IIFE suspends on its first await, so
  // a concurrent caller always chains onto this send instead of racing it.
  state.chain = pending.then(
    () => undefined,
    () => undefined,
  );
  scopeStates.set(scopeKey, state);

  return pending;
}
