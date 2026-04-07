# `/btw` Bypass Session Lock — Design

**Date:** 2026-04-07
**Branch:** `feat/btw-bypass-session-lock`
**Related upstream:** openclaw `/btw` command (`auto-reply/reply/commands-btw.ts`), docs at https://docs.openclaw.ai/tools/btw

## Background

openclaw recently introduced `/btw <question>` — a "side question" command that runs an isolated, tool-less model call against the current session context, without polluting transcript history. It's modeled on Claude Code's BTW.

On the dingtalk channel, `/btw` does not work as designed because every inbound message must acquire `acquireSessionLock(route.sessionKey)` before reaching the openclaw reply pipeline. While a main run is in flight, the lock blocks new messages — defeating BTW's "ask a side question without interrupting the main task" semantics.

There is already a precedent for bypassing this lock: `/stop` (abort) is detected before the lock is acquired and dispatched directly via `dispatchReplyWithBufferedBlockDispatcher` (see `inbound-handler.ts:1366-1414`).

## Goals

- `/btw <question>` works in dingtalk while a main run is in flight
- BTW reply visually distinct from the main task, with the original `/btw <question>` echoed as a blockquote
- BTW reply respects the user's configured message format (card / markdown / text)
- Zero risk of corrupting the main task's AI Card state machine
- No new persistence; no changes to dedup, recovery, or session-lock semantics

## Non-Goals

- Native dingtalk-protocol "reply to message" / quote (dingtalk bot API does not support this — see Investigation)
- Cross-process persistence of BTW state
- Recovery of unfinished BTW cards on restart (BTW is fire-and-forget by design)
- Changes to openclaw — `isBtwRequestText` is already exported via `plugin-sdk/reply-runtime`

## Investigation Findings

1. **`/btw` is fully implemented inside openclaw's auto-reply pipeline.** The channel does not need to dispatch any "side query event"; it just needs to deliver the inbound message to `dispatchReplyWithBufferedBlockDispatcher`. openclaw recognizes `/btw` via the `handleBtwCommand` `CommandHandler` registered in `commands-handlers.runtime.ts` and runs `runBtwSideQuestion` with `resolvedThinkLevel: "off"`.

2. **`isBtwRequestText` is already exported** from `openclaw/src/plugin-sdk/reply-runtime.ts:32`. No openclaw PR required. (Need to confirm the current `peerDependencies` version `>=2026.3.28` includes this export; bump if not.)

3. **Dingtalk bot send APIs do not support protocol-level reply/quote.** The `quotedRef` field in `send-service.ts` is an internal-only persistence link used by `message-context-store` to recover quoted context for *inbound* messages — it never reaches dingtalk's wire protocol. Therefore, the only way to "show" what a BTW reply is responding to is to echo the original `/btw` message inside the reply body.

## Architecture

### High-level flow

```
inbound /btw message
        │
        ▼
inbound-handler.ts (existing prelude: dedup, content extract, auth, route)
        │
        ▼
isAbortRequestText? ──yes──▶ existing abort bypass branch
        │ no
        ▼
isBtwRequestText? ──yes──▶ NEW: BTW bypass branch
        │ no                       │
        ▼                          │
acquireSessionLock                 │
(normal main-run path)             │
                                   ▼
                       dispatchReplyWithBufferedBlockDispatcher
                       (NO session lock acquired)
                                   │
                                   ▼
                       deliver(payload):
                         prepend `> /btw <originalQuestion>\n\n`
                         to payload.text, then route to:
                           • independent BTW card  (config = card)
                           • independent markdown  (config = markdown/text)
                           • markdown fallback     (card path failed)
```

### New code locations

- `src/inbound-handler.ts` — add a new bypass branch immediately after the existing abort branch (~line 1414). Follows the same shape: detect via `isBtwRequestText`, log, call `dispatchReplyWithBufferedBlockDispatcher` without acquiring `acquireSessionLock`, with a custom `deliver` callback.

- `src/messaging/btw-deliver.ts` (new) — small module exposing `deliverBtwReply(payload, ctx)` that:
  1. Strips leading `@mention` from the original inbound text to recover the clean `/btw <question>` form
  2. Prepends `> /btw <question>\n\n` blockquote to `payload.text`
  3. Picks the delivery strategy based on config (`messageType` resolved as the existing reply-strategy does):
     - **card mode** → call into a new lightweight BTW card path (see "BTW card isolation" below)
     - **markdown / text mode** → independent `sendMessage` / `sendBySession` call, never touches `currentAICard`

- `src/card/btw-card.ts` (new, only if needed for option B2) — minimal helper that creates a one-shot dingtalk AI Card outside `card-service`'s active cache. See "BTW card isolation" below.

### BTW card isolation (option B2)

`card-service.ts`'s active card cache is keyed by `accountId:conversationId`. The main run's card occupies that key. The BTW card MUST NOT collide with it.

**Decision:** BTW cards completely bypass `card-service`'s active cache. The BTW card is fire-and-forget:

- Generated `cardInstanceId` uses a distinct prefix (e.g., `btw-<uuid>`) so it cannot collide with the main card's id namespace
- Created via direct dingtalk `createAndDeliverCard` API call (or whatever the lower-level primitive is)
- Streamed to FINISHED inline within the BTW deliver callback
- NEVER registered in `card-service`'s active cache, recovery list, createdAt fallback cache, or stop handler tracking
- Therefore: `/stop` does not affect BTW cards, restart recovery does not see them, and the main card's state machine is untouched

**If creating a second card concurrently turns out to be impossible** (e.g., dingtalk rejects two active cards in the same conversation), the BTW card path returns `{ ok: false }` and the deliver callback automatically falls back to the markdown path. This mirrors the existing card→markdown fallback in `send-service.ts`.

### Reply format (echo template)

```
> /btw <original question, with leading @mentions stripped>

<openclaw BTW answer>
```

- Blockquote uses the literal `/btw` prefix per user preference (more recognizable than a generic "BTW:" label)
- The original question is taken from the in-memory `inboundText` closure variable already present in `inbound-handler.ts` — no caching, no store lookup

## Data Flow

1. User sends `/btw <question>` while a main run is processing in the same conversation
2. dingtalk inbound webhook → `inbound-handler.ts` runs prelude (dedup, content parsing, routing) — same as today
3. After `isAbortRequestText` check fails, new `isBtwRequestText` check matches
4. Log: `[DingTalk] BTW request detected, bypassing session lock for session=<key>`
5. Channel calls `dispatchReplyWithBufferedBlockDispatcher` with a custom `deliver`. **No `acquireSessionLock` call.**
6. openclaw's auto-reply pipeline sees the message, `handleBtwCommand` matches, `runBtwSideQuestion` runs (think/reasoning forced off)
7. openclaw streams reply chunks back into `deliver(payload)`
8. `deliverBtwReply` prepends the `> /btw <question>` blockquote, picks card vs markdown by config, delivers
9. BTW card (if used) finishes; main task's card is untouched throughout

## Error Handling

| Failure mode | Behavior |
|---|---|
| openclaw rejects /btw (no active session) | openclaw returns `"⚠️ /btw requires an active session..."` text — channel delivers it as plain markdown |
| openclaw `runBtwSideQuestion` throws | openclaw returns `"⚠️ /btw failed: ..."` text — channel delivers as plain markdown |
| BTW card creation fails | `deliverBtwReply` falls back to markdown, prepended blockquote preserved |
| Inbound dedup hits a duplicate /btw | Same as today: dedup short-circuits before reaching BTW branch |
| Empty `/btw` (no question) | openclaw handler returns `BTW_USAGE` text — channel delivers as plain markdown |

## Testing

### Unit tests (`tests/unit/`)
- `inbound-handler.btw-bypass.test.ts`:
  - `/btw` matched → session lock NOT acquired, `dispatchReplyWithBufferedBlockDispatcher` called with custom deliver
  - `/btw` matched even when session lock is currently held by main run (verify by spying that `acquireSessionLock` is never called on the bypass path)
  - `@Bot /btw foo` (with leading mention) matches BTW
  - Non-BTW message → falls through to existing main-run path
  - `/stop` still wins over `/btw` when both could match (it can't, but assert ordering)

- `btw-deliver.test.ts`:
  - Card mode → BTW card path invoked, `currentAICard` cache untouched
  - Markdown mode → independent `sendMessage`/`sendBySession`, blockquote prepended
  - Card path failure → fallback to markdown, blockquote preserved
  - Original question echoed verbatim (with `@mention` stripped)

### Integration tests
- `inbound-btw.integration.test.ts`: full pipeline — simulate inbound /btw while a fake main-run lock is held; assert delivery happens without waiting for the lock and assert the main card state is unchanged.

### Real-device validation
Per `skills/dingtalk-real-device-testing/SKILL.md`, add a 验证 TODO entry for the PR covering:
- DM `/btw` while idle
- DM `/btw` while main run in PROCESSING
- Group `@Bot /btw` while main run in PROCESSING
- `/btw` (no question) → usage error rendering
- card mode and markdown mode covered separately

## Open Questions / Risks

1. **`peerDependencies` version** — confirm `openclaw >= 2026.3.28` exports `isBtwRequestText` from `plugin-sdk/reply-runtime`. If not, bump the peer range.
2. **Concurrent card creation API limits** — until we test on a real device, we don't know whether dingtalk's card API accepts a second active card in the same conversation. The fallback-to-markdown path makes this a soft failure, not a blocker.
3. **BTW reply might still be long** — even with think/reasoning off, the BTW answer is unbounded. Existing chunking (`DINGTALK_TEXT_CHUNK_LIMIT = 3800`) applies in markdown mode; card mode handles streaming natively.

## Out of Scope

- Persisting BTW Q&A pairs (intentionally ephemeral per BTW design)
- BTW from button/interactive card (only text command for now)
- Multi-turn BTW threads
