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
- BTW reply visually distinct from the main task, with the original `/btw <question>` echoed as a blockquote header
- BTW reply delivered as an independent markdown/text message, regardless of the user's configured `messageType`
- Zero risk of corrupting the main task's AI Card state machine
- No new persistence; no changes to dedup, recovery, or session-lock semantics

## Non-Goals

- Native dingtalk-protocol "reply to message" / quote (dingtalk bot API does not support this — see Investigation)
- Cross-process persistence of BTW state
- BTW rendered as an AI Card (see "Why markdown only" below)
- Changes to openclaw — `isBtwRequestText` is already exported via `plugin-sdk/reply-runtime`

## Investigation Findings

1. **`/btw` is fully implemented inside openclaw's auto-reply pipeline.** The channel does not need to dispatch any "side query event"; it just needs to deliver the inbound message to `dispatchReplyWithBufferedBlockDispatcher`. openclaw recognizes `/btw` via the `handleBtwCommand` `CommandHandler` registered in `commands-handlers.runtime.ts` and runs `runBtwSideQuestion` with `resolvedThinkLevel: "off"`.

2. **`isBtwRequestText` is already exported** from `openclaw/src/plugin-sdk/reply-runtime.ts:32`. No openclaw PR required. **No `peerDependencies` bump either** — we treat this as a soft feature: `import { isBtwRequestText } from "openclaw/plugin-sdk/reply-runtime"` and guard usage with `typeof isBtwRequestText === "function"`. If linked against an older openclaw without the export, the symbol is `undefined`, the bypass branch is skipped, and the message falls through to the normal session-lock path. Old openclaw will treat `/btw` as a regular chat message (degraded UX, no crash). Upgrading openclaw automatically activates BTW with zero config.

3. **Dingtalk bot send APIs do not support protocol-level reply/quote.** The `quotedRef` field in `send-service.ts` is an internal-only persistence link used by `message-context-store` to recover quoted context for *inbound* messages — it never reaches dingtalk's wire protocol. Therefore, the only way to "show" what a BTW reply is responding to is to echo the original `/btw` message inside the reply body.

## Why markdown only (not card)

`CLAUDE.md` (project-level) lists this anti-pattern:

> Do not create multiple active AI Cards for the same `accountId:conversationId`

A BTW reply rendered as a card while the main run also has an active card would violate this rule. Rather than try to negotiate around it (collision-free `cardInstanceId`, server-side concurrency assumptions, etc.), BTW always delivers as an independent markdown/text message.

This actually fits BTW's semantics:
- BTW is defined by openclaw as a *lightweight, ephemeral* side question (think/reasoning forced off, no tools)
- Visual distinction from the main task is a *feature*, not a regression: the user can immediately tell "this is the side answer, the main task is still running"
- One delivery path = simpler implementation, fewer failure modes, smaller test surface

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
isBtwRequestText available && matches? ──yes──▶ NEW: BTW bypass branch
        │ no                                       │
        ▼                                          │
acquireSessionLock                                 │
(normal main-run path)                             │
                                                   ▼
                                  dispatchReplyWithBufferedBlockDispatcher
                                  (NO session lock acquired)
                                                   │
                                                   ▼
                                  deliver(payload):
                                    prepend `> [<sender>: ]/btw <truncated question>\n\n`
                                    deliver as independent markdown via
                                    sendBySession (preferred) or sendMessage
                                    NEVER touches `currentAICard`
```

### New code locations

- **`src/inbound-handler.ts`** — add a new bypass branch immediately after the existing abort branch (~line 1437). Follows the same shape as the abort branch: detect via `isBtwRequestText` (with `typeof === "function"` guard), log, call `dispatchReplyWithBufferedBlockDispatcher` without acquiring `acquireSessionLock`, with a custom `deliver` callback. Returns immediately after dispatch, never falls through to the main-run path.

- **`src/messaging/btw-deliver.ts`** (new) — small, self-contained module exposing two pure helpers + one delivery function:
  - `buildBtwBlockquote(senderName: string, rawQuestion: string): string` — strips leading `@mention` tokens from `rawQuestion`, truncates to 80 chars + `…` if needed, formats as `> [<senderName>: ]/btw <question>\n\n` (sender prefix omitted when empty)
  - `deliverBtwReply(args)` — given the dispatch payload, prepends the blockquote and sends via `sendBySession` (when `sessionWebhook` is available) or `sendMessage` (proactive). Returns `{ ok, error? }` matching channel send conventions. Never touches card APIs.

### Interaction with `currentAICard`

The BTW bypass branch returns **before** the main-run code path runs, so `currentAICard` (declared at `inbound-handler.ts:785`) is never assigned for BTW messages. There is no card to finalize, no card state machine to corrupt. The main run, if any, continues operating on its own `currentAICard` from a previous in-flight inbound handler invocation — the BTW handler does not touch it.

### Interaction with `/stop`

BTW abort behavior is **entirely owned by openclaw**; the channel does nothing special.

- `runBtwSideQuestion` (`openclaw/src/agents/btw.ts:309`) wires `params.opts?.abortSignal` into the model call, so BTW is interruptible.
- openclaw's abort routing (`auto-reply/reply/abort.ts`) targets in-flight runs by `sessionKey`. BTW runs against the same `sessionKey` as the main run, so a `/stop` from the user is expected to cancel both (subject to openclaw's internal abort scoping; channel does not depend on the exact policy).
- The channel does **not** maintain any "in-flight BTW handle"; there is nothing for the abort branch to clean up on the channel side.
- The BTW deliver callback must tolerate three abort outcomes from openclaw: empty payload (no message sent), text payload like `"aborted"` (delivered with blockquote prefix as usual), or thrown error (logged and swallowed). The existing dispatch error handling already covers these cases.

### Reply format (echo template)

```
> 王滨: /btw 这个函数为什么慢

<openclaw BTW answer>
```

When sender nickname is unavailable:

```
> /btw 这个函数为什么慢

<openclaw BTW answer>
```

When the question is too long:

```
> 王滨: /btw 帮我看看 src/inbound-handler.ts 里 dispatchReply 函数为什么会偶尔…

<openclaw BTW answer>
```

Rules:
- Blockquote uses the literal `/btw` prefix per user preference (more recognizable than a generic "BTW:" label)
- **Sender prefix**: read from `data.senderNick || ""` (empty fallback, NOT `"Unknown"`). When empty, the `<senderName>: ` prefix is omitted entirely — no `> Unknown:` or `> : /btw …` artifacts. This is read with a dedicated local; the existing `senderName` variable at `inbound-handler.ts:448` (which uses `|| "Unknown"`) is not modified.
- The original question is taken from the in-memory `inboundText` closure variable already present in `inbound-handler.ts` — no caching, no store lookup
- **`@mention` stripping**: leading `@\S+` tokens are removed (same regex used in the abort branch: `/^(?:@\S+\s+)*/u`)
- **Truncation**: if the cleaned question exceeds **80 characters**, truncate to 80 + `…`. The blockquote is meant to be a single-line *label* identifying which message is being answered, not a verbatim reproduction. 80 ≈ one dingtalk row for English / ~40 Chinese characters.
- No markdown escaping of `senderName` — dingtalk nicknames rarely contain markdown special chars, and even if they render as italics it does not impair recognition.

## Data Flow

1. User sends `/btw <question>` while a main run is processing in the same conversation
2. dingtalk inbound webhook → `inbound-handler.ts` runs prelude (dedup, content parsing, routing) — same as today
3. `isAbortRequestText` check fails
4. `isBtwRequestText` is available (function defined) and matches → enter BTW bypass branch
5. Log: `[DingTalk] BTW request detected, bypassing session lock for session=<key>`
6. Channel calls `dispatchReplyWithBufferedBlockDispatcher` with a custom `deliver`. **No `acquireSessionLock` call.**
7. openclaw's auto-reply pipeline sees the message, `handleBtwCommand` matches, `runBtwSideQuestion` runs (think/reasoning forced off)
8. openclaw streams reply chunks back into `deliver(payload)`
9. `deliverBtwReply` prepends the blockquote and sends as independent markdown
10. Main task's `currentAICard` (if any) is never touched throughout

## Error Handling

| Failure mode | Behavior |
|---|---|
| `isBtwRequestText` not exported by linked openclaw | `typeof === "function"` guard fails, BTW branch skipped, message goes through normal session-lock path; old openclaw handles it as regular chat |
| openclaw rejects /btw (no active session) | openclaw returns `"⚠️ /btw requires an active session..."` text — channel delivers it with blockquote prefix |
| openclaw `runBtwSideQuestion` throws | openclaw returns `"⚠️ /btw failed: ..."` text — channel delivers with blockquote prefix |
| `sendBySession` / `sendMessage` fails | Logged at `warn` level with `[DingTalk] BTW reply delivery failed: ...`; no retry, no fallback (BTW is best-effort) |
| Inbound dedup hits a duplicate /btw | Same as today: dedup short-circuits before reaching BTW branch |
| Empty `/btw` (no question) | openclaw handler returns `BTW_USAGE` text — channel delivers with blockquote prefix |
| `dispatchReplyWithBufferedBlockDispatcher` throws | Caught at the BTW branch level, logged at `warn`, BTW branch returns (no fall-through to main path) |

## Testing

### Unit tests (`tests/unit/`)

- **`btw-deliver.test.ts`** (new):
  - `buildBtwBlockquote("王滨", "/btw 这个函数为什么慢")` → `"> 王滨: /btw 这个函数为什么慢\n\n"`
  - `buildBtwBlockquote("", "/btw foo")` → `"> /btw foo\n\n"` (no sender prefix)
  - `buildBtwBlockquote("王滨", "@Bot /btw foo")` → `"> 王滨: /btw foo\n\n"` (mention stripped)
  - `buildBtwBlockquote("王滨", "@Bot @Other /btw foo")` → `"> 王滨: /btw foo\n\n"` (multiple mentions stripped)
  - Truncation: question > 80 chars → truncated to 80 + `…`
  - Truncation boundary: question = exactly 80 chars → no truncation
  - `deliverBtwReply` with `sessionWebhook` set → calls `sendBySession` with prepended blockquote
  - `deliverBtwReply` without `sessionWebhook` → calls `sendMessage` with prepended blockquote
  - Send failure → returns `{ ok: false, error: ... }`, does not throw

- **`inbound-handler.btw-bypass.test.ts`** (new):
  - `/btw foo` matched → `acquireSessionLock` is NEVER called, `dispatchReplyWithBufferedBlockDispatcher` is called once
  - `@Bot /btw foo` (group with leading mention) → still matches BTW
  - `isBtwRequestText` mocked to `undefined` (simulating old openclaw) → BTW branch skipped, falls through to normal path (acquireSessionLock IS called)
  - Non-BTW message → BTW branch skipped, normal path runs
  - `/stop` and `/btw` cannot collide (one matches abort, one matches BTW), but verify abort branch runs first by sending `/stop` and asserting BTW path is not entered
  - BTW bypass returns early — assert that no main-run code (e.g., `attachNativeAckReaction`) runs after BTW dispatch
  - `dispatchReplyWithBufferedBlockDispatcher` throws → caught, logged, function returns without re-throwing

### Integration tests

- **`tests/integration/inbound-btw.test.ts`** (new): full pipeline — simulate inbound `/btw` arriving while a fake main-run lock is held by another `acquireSessionLock` caller; assert that BTW delivery proceeds immediately (no waiting on lock) and the held lock is never touched.

### Real-device validation

Per `skills/dingtalk-real-device-testing/SKILL.md`, add a 验证 TODO entry for the PR covering:
- DM `/btw <question>` while idle
- DM `/btw <question>` while main run in PROCESSING
- Group `@Bot /btw <question>` while main run in PROCESSING
- `/btw` with no question → usage error rendering with blockquote prefix
- Long question (> 80 chars) → blockquote truncated with `…`
- Sender nickname missing edge case (if reproducible)

## Open Questions / Risks

1. **BTW reply might still be long** — even with think/reasoning off, the BTW answer is unbounded. Existing chunking (`DINGTALK_TEXT_CHUNK_LIMIT = 3800` in `send-service.ts`) handles this in markdown mode by splitting into multiple messages. The blockquote prefix lives in the first chunk only; subsequent chunks have no prefix, which is acceptable since they are continuations of the same answer.
2. **Old openclaw silent degradation** — when `isBtwRequestText` is undefined, users get no signal that BTW is unsupported; their `/btw` message just gets answered as a normal chat. We accept this in exchange for not requiring a peer-dep bump. If complaints arise, we can add a CHANGELOG note recommending an openclaw version.

## Out of Scope

- Persisting BTW Q&A pairs (intentionally ephemeral per BTW design)
- BTW from button/interactive card (only text command for now)
- Multi-turn BTW threads
- Native dingtalk reply/quote (protocol does not support)
- BTW rendered as AI Card (see "Why markdown only")
