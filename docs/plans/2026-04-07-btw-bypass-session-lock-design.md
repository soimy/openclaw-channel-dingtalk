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

2. **`isBtwRequestText` is already exported** from `openclaw/src/plugin-sdk/reply-runtime.ts:32`. No openclaw PR required. **No `peerDependencies` bump either** — we treat this as a soft feature: `import { isBtwRequestText } from "openclaw/plugin-sdk/reply-runtime"` and guard usage with `typeof isBtwRequestText === "function"`. If linked against an older openclaw without the export, the symbol is `undefined`, the bypass branch is skipped, and the message falls through to the normal session-lock path. Old openclaw will treat `/btw` as a regular chat message (degraded UX, no crash). Upgrading openclaw automatically activates BTW with zero config.

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

### BTW card isolation

There is **no global "one active card per conversation" registry** on the channel side:

- The "main run's active card" is a per-request closure variable `currentAICard` in `inbound-handler.ts:785` — scoped to a single inbound handler invocation, not shared state.
- The only `accountId:conversationId`-keyed structure in `card-service.ts` is `inMemoryCardContentStore` (lines 82-108), which is a **content history bucket** capped at N recent text snapshots per conversation, used for recovery hints. Multiple cards in the same conversation legitimately append to it; it is not a single-active-card lock.

Therefore the BTW bypass branch creates its own card entirely within its own scope and naturally cannot touch the main run's `currentAICard`. The BTW card is fire-and-forget:

- Generated `cardInstanceId` uses a distinct prefix (e.g., `btw-<uuid>`)
- Streamed to FINISHED inline within the BTW deliver callback
- Never tracked by recovery, createdAt fallback caches, or stop handler bookkeeping
- Main run's card state machine is untouched

The only unknown is **whether the dingtalk server allows two concurrent active AI cards in the same conversation**. We cannot answer this from code — it requires real-device validation. If the second `createAndDeliverCard` call fails, the BTW deliver callback automatically falls back to the markdown path (mirroring the existing card→markdown fallback in `send-service.ts`), so this is a soft failure.

### Interaction with `/stop`

BTW abort behavior is **entirely owned by openclaw**; the channel does nothing special.

- `runBtwSideQuestion` (`openclaw/src/agents/btw.ts:309`) wires `params.opts?.abortSignal` into the model call, so BTW is interruptible.
- openclaw's abort routing (`auto-reply/reply/abort.ts`) targets in-flight runs by `sessionKey`. BTW runs against the same `sessionKey` as the main run, so a `/stop` from the user is expected to cancel both (subject to openclaw's internal abort scoping; channel does not depend on the exact policy).
- The channel does **not** register the BTW card with the `/stop` bypass branch's tracking. There is no channel-side "in-flight BTW handle" to abort.
- The BTW deliver callback must tolerate three abort outcomes returned by openclaw: empty payload (no message sent), text payload like `"aborted"` (delivered with blockquote prefix as usual), or error payload (markdown error path). The existing dispatch error handling already covers these cases.

### Reply format (echo template)

```
> <senderName>: /btw <original question, leading @mentions stripped, truncated to 80 chars + …>

<openclaw BTW answer>
```

- Blockquote uses the literal `/btw` prefix per user preference (more recognizable than a generic "BTW:" label)
- `senderName` is read from the existing `senderName` closure variable in `inbound-handler.ts:448` (`data.senderNick || "Unknown"`), zero extra lookup. Especially useful in groups where multiple people may BTW concurrently.
- The original question is taken from the in-memory `inboundText` closure variable — no caching, no store lookup
- **Truncation**: if the question (after `@mention` stripping) exceeds **80 characters**, truncate to 80 + `…`. The blockquote is meant to be a single-line *label* identifying which message is being answered, not a verbatim reproduction. Users can always see the full original message in their own message history. 80 ≈ one dingtalk row for English / ~40 Chinese characters.
- No markdown escaping of `senderName` — dingtalk nicknames rarely contain markdown special chars, and even if they render as italics it does not impair recognition.

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

1. **Concurrent card creation API limits** — until we test on a real device, we don't know whether dingtalk's card API accepts a second active card in the same conversation. The fallback-to-markdown path makes this a soft failure, not a blocker.
2. **BTW reply might still be long** — even with think/reasoning off, the BTW answer is unbounded. Existing chunking (`DINGTALK_TEXT_CHUNK_LIMIT = 3800`) applies in markdown mode; card mode handles streaming natively.

## Out of Scope

- Persisting BTW Q&A pairs (intentionally ephemeral per BTW design)
- BTW from button/interactive card (only text command for now)
- Multi-turn BTW threads
