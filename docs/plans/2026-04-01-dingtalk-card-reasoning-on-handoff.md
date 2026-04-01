# DingTalk Card Reasoning On Handoff

## Current Scope

This handoff note captures the current status of worktree `card-resoning-block-assembly` for the DingTalk card-mode reasoning chain investigation.

Main focus:

- verify real-device behavior for PR-scoped card reasoning changes
- fix plugin-side card timeline issues for think/tool/answer rendering
- isolate the remaining `/reasoning on` failure
- preserve enough evidence for the next session to continue without re-tracing the whole investigation

## Worktree And Environment

- Repo root: `/Users/sym/Repo/openclaw-channel-dingtalk`
- Active worktree: `/Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-reasoning-block-assembly`
- Branch: `feat/card-reasoning-block-assembly`
- Current commit at time of handoff: `c8a4bc4`
- `~/.openclaw/openclaw.json` plugin path already points to this worktree
- Gateway was restarted during testing and DingTalk stream reconnected successfully

## Local Code Changes Already In This Worktree

Current unstaged diff:

- `src/card/reasoning-block-assembler.ts`
- `src/inbound-handler.ts`
- `src/reply-strategy-card.ts`
- `tests/unit/inbound-handler.test.ts`
- `tests/unit/reasoning-block-assembler.test.ts`
- `tests/unit/reply-strategy-card.test.ts`

High-level changes already implemented:

1. Card-mode reasoning assembly

- Added/extended `reasoning-block-assembler` so card mode can assemble reasoning blocks from:
  - explicit `Reason:`-prefixed reasoning text
  - unprefixed underscore-wrapped reasoning snapshots
- Fixed `/reasoning stream` truncation on DingTalk real device by buffering grown reasoning snapshots until a boundary

2. Session-aware card block streaming gate

- `src/inbound-handler.ts` now distinguishes reply mode:
  - `markdown`
  - `card`
- For card mode:
  - `/reasoning on` enables block streaming
  - non-`on` modes keep card block streaming disabled

3. Card strategy fixes already landed

- `src/reply-strategy-card.ts` no longer drops text blocks in card mode
- visible `Reasoning:` block text is treated as reasoning, not as answer
- ordinary block-delivered answer text is preserved in card timeline
- `finalize()` now prefers final answer snapshot over stale partial answer
- `getFinalText()` now prefers final payload over older partials

These fixes addressed plugin-side regressions found by code review, especially:

- block-delivered reasoning/answer text being lost in card mode
- finalize using older partial answer instead of final answer snapshot

## Verified Test Status

Verified after the latest plugin-side fix:

- `npm run type-check` passed
- `pnpm test` passed
- latest full suite result on the current followup branch: `70` test files, `781` tests passed

This means the current remaining problem is not covered by the existing local test surface yet. It is a real-device/runtime-contract problem, not an obvious failing unit test in this repo.

## Real-Device Findings

### What is now working

1. `/reasoning stream` on DingTalk card mode

- think block appears
- assembled reasoning content is no longer truncated
- tool blocks show correctly
- final answer is visible

2. Plugin-side card timeline behavior

- block-delivered reasoning is no longer misclassified as answer
- block-delivered answer text is preserved
- final card no longer prefers stale partial answer over newer final payload

3. Temporary transcript fallback on DingTalk `/reasoning on`

- pure reasoning now restores the final answer instead of dropping it entirely
- tool-success path now preserves the final answer `/Users/sym/clawd`
- plugin-side outbound persistence confirms the main regression is fixed: the final answer is present in `messages.context`

### What is still broken

The remaining failure is now narrower:

- DingTalk card mode
- `/reasoning on`
- pure reasoning path can still render blocks in the wrong final order

Observed behavior on DingTalk card:

1. Pure reasoning, no tools

- transcript contains:
  - `thinking`
  - final assistant `text`
- final answer is now visible
- but DingTalk shows `answer` before `think`
- plugin-side persisted outbound text in `messages.context` shows the same `answer -> think` order, so this is not just a client-side reorder

2. Reasoning plus tool

- transcript contains:
  - reasoning
  - tool call
  - final assistant answer text
- DingTalk card now shows:
  - reasoning
  - tool block
  - final answer
- tested `pwd` case ended with `/Users/sym/clawd`, and DingTalk-side order was correct

Updated real-device outcome:

- `/reasoning on` pure reasoning: final answer restored, order still wrong
- `/reasoning on` + `pwd`: final answer restored and order correct
- `/reasoning stream` + `pwd`: still correct as control case

### Important control result

Telegram was tested as a control channel.

- `/reasoning on` on Telegram looked correct
- the same prompt produced:
  - tool block
  - reasoning block
  - final answer

This matters because it narrows the claim:

- this is not a universal `/reasoning on` failure on every channel
- it is a runtime assembly/contract problem whose impact depends on channel behavior
- DingTalk card mode exposes it clearly because it relies more on assembled final payload

## Root Cause Analysis So Far

The remaining problem appears to be upstream in `openclaw`, not primarily in this plugin.

Most relevant upstream source paths:

- `src/agents/pi-embedded-subscribe.ts`
- `src/agents/pi-embedded-runner/run/payloads.ts`
- `extensions/telegram/src/bot-message-dispatch.ts`

### Important difference between `/reasoning on` and `/reasoning stream`

`/reasoning on`

- reasoning goes through normal block/final assembly path
- if block replies are emitted earlier in the same assistant turn, the final assistant text may never be pushed into `assistantTexts`

Relevant upstream logic:

- `finalizeAssistantTexts(...)` only force-inserts final assistant text in limited cases
- when `onBlockReply` already exists and block replies were emitted, final answer can fail to enter `assistantTexts`

Then in `buildEmbeddedRunPayloads(...)`:

- `assistantTexts` are preferred over `fallbackAnswerText` from `lastAssistant.text`
- if `assistantTexts` are non-empty but incomplete, `lastAssistant.text` is ignored

Result:

- transcript contains final assistant answer
- assembled final payload does not
- channels relying on assembled final payload can lose the answer

`/reasoning stream`

- reasoning goes through a separate `onReasoningStream` path
- final answer path is less likely to be shadowed by earlier block-reply state
- Telegram also adds channel-side draft/preview compensation, which likely masks this class of bug

## Upstream Tracking

A new upstream issue was filed:

- `openclaw/openclaw#58627`
- URL: `https://github.com/openclaw/openclaw/issues/58627`

Title:

- `bug(reply-runtime): /reasoning on can lose final answer after block replies`

Related upstream items already found during investigation:

- `openclaw/openclaw#30804`
- `openclaw/openclaw#51132`
- `openclaw/openclaw#29678`
- `openclaw/openclaw#43885`
- `openclaw/openclaw#57984`

These are not exact duplicates, but they show a pattern of reasoning/block/final delivery inconsistencies across channels.

## Recommended Next Steps

### For this repo

1. Keep the current plugin-side fixes

- they are valid and already verified
- they fixed real plugin regressions
- they should not be reverted

2. Add a DingTalk-side fallback for `/reasoning on`

Recommended direction:

- when card finalize sees:
  - reasoning/tool blocks already delivered
  - no usable final answer in strategy state
  - but the OpenClaw session transcript contains a later assistant `text`
- recover the latest assistant answer from transcript and use it as final answer fallback

Practical path:

- read `~/.openclaw/agents/main/sessions/sessions.json`
- resolve `sessionKey -> sessionId -> sessionFile`
- load the latest assistant message from transcript
- use that final assistant text only as a narrow fallback for card finalize

This should be scoped carefully so it does not override normal working paths.

Temporary workaround note:

- upstream fix is now being tracked in PR `openclaw/openclaw#58650`
- until that PR or an equivalent upstream chain fix lands, plugin-side transcript fallback is acceptable only as a temporary compatibility path
- keep code comments and docs explicit that this path should be removed or narrowed once upstream reliably preserves final answers after block replies

4. Investigate the remaining `/reasoning on` pure-reasoning order issue

- compare the final persisted outbound `messages.context` text with DingTalk display order
- inspect whether pure-reasoning finalize is appending thinking blocks after answer assembly in plugin strategy state
- keep scope narrow so the temporary fallback continues to fix answer loss without perturbing the already-correct tool-success and `/reasoning stream` paths

3. Add regression coverage around the fallback if implemented

- likely at plugin integration level rather than only unit level
- simulate transcript-backed recovery for `/reasoning on`

### For upstream follow-up

Track `openclaw/openclaw#58627`.

If upstream lands a fix:

- re-test DingTalk `/reasoning on`
- remove or narrow local transcript fallback if it becomes unnecessary

## Suggested Resume Checklist For Next Session

1. Read this file first
2. Review current local diff in the six modified files
3. Re-read upstream issue `openclaw/openclaw#58627`
4. Inspect:
   - `~/.openclaw/agents/main/sessions/sessions.json`
   - `~/.openclaw/agents/main/sessions/681e2b80-7a40-4405-902a-6d0793e24a55.jsonl`
5. Implement transcript-based DingTalk card fallback for `/reasoning on`
6. Restart gateway
7. Re-test on DingTalk:
   - `/reasoning on` + pure reasoning prompt
   - `/reasoning on` + `pwd` prompt
   - `/reasoning stream` control case

## Reference Evidence Snapshot

Key conclusions from the latest real-device loop:

- DingTalk `/reasoning on`:
  - transcript has final answer
  - card final payload may still lose it
- DingTalk `/reasoning stream`:
  - looks correct
- Telegram `/reasoning on`:
  - looks correct

That is the exact boundary at handoff time.
