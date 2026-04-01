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
- Active worktree for the latest continuation: `/Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/review-card-reasoning-followup`
- Active branch now tracks PR #474 branch: `fix/card-reasoning-on-transcript-fallback`
- Latest committed branch head: `cc3fc66`
- Current uncommitted local edits exist on top of `cc3fc66`
- `~/.openclaw/openclaw.json` currently points plugin loading to `/Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/review-card-reasoning-followup`
- `~/.openclaw/openclaw.json` currently has:
  - `logging.consoleLevel = "debug"`
  - `logging.level = "debug"`
- Gateway was restarted after switching plugin path / logging config
- Current local evidence files:
  - plugin debug log: `~/.openclaw/agents/default/sessions/dingtalk-state/plugin-debug.jsonl`
  - outbound context store: `~/.openclaw/agents/default/sessions/dingtalk-state/messages.context.account-ZGVmYXVsdA.conversation-Y2lkS3pIbGtsV0lHWExGZVBES05WazBmcWpBYlhKekkrOHZoTTVYUzJpS0hFVT0.json`
  - active session index: `~/.openclaw/agents/main/sessions/sessions.json`

## Local Code Changes Already In This Worktree

Current unstaged diff on top of `cc3fc66`:

- `src/reply-strategy-card.ts`
- `src/card-service.ts`
- `src/utils.ts`
- `tests/unit/reply-strategy-card.test.ts`

High-level changes already implemented and committed before this continuation:

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

High-level changes currently only in local, uncommitted edits:

1. Narrow timeline-order fix in `card-draft-controller`

- completed thinking blocks that arrive after an answer in the same segment are inserted before that segment's answer
- `tool` boundaries still remain hard boundaries, so late thinking cannot jump back ahead of earlier tool blocks

2. Mixed final-payload split in `reply-strategy-card`

- local code now attempts to split `deliver(final)` text into:
  - answer portion
  - trailing `Reasoning:` portion
- the trailing `Reasoning:` portion is fed back into reasoning assembly instead of staying as raw answer text

3. Plugin-local debug sink for real-device debugging

- local code now writes plugin-specific debug probes to:
  - stdout directly
  - `dingtalk-state/plugin-debug.jsonl`
- current implementation reuses existing `channels.dingtalk.debug`
- helper was refactored into `src/utils.ts` so files stop duplicating debug helpers

## Verified Test Status

Verified after the latest plugin-side fix:

- `npm run type-check` passed
- `pnpm test` passed
- latest committed branch result before current local edits: `70` test files, `785` tests passed
- latest local verification after moving plugin debug helpers into `src/utils.ts`:
  - `npm run type-check` passed
  - no fresh full-suite run yet after the very latest uncommitted debug-helper refactor

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

The remaining failure has shifted and is now better understood:

- DingTalk card mode
- `/reasoning on`
- some models still leak reasoning into the answer lane before finalization

Observed behavior on DingTalk card:

1. Pure reasoning / math-style prompts show unstable model-dependent shapes

- some runs produced only `✅ Done`
- some runs produced `answer + trailing Reasoning:` in `messages.context`
- some runs produced correctly formatted `> think` blocks before the answer
- some `gpt-5.4` runs timed out upstream and silently fell back to another model in the same session

2. The newest hard evidence identifies the pollution point

- plugin-local debug file now shows repeated entries like:
  - `category=partial event=onPartialReply`
  - `category=partial event=updateAnswer source=partial`
- the `textPreview` recorded in those entries is already reasoning-like text such as:
  - `分步推理过程`
  - `分步推理过程如下：...`
- this means raw reasoning text is entering `controller.updateAnswer(...)` through `onPartialReply` before later reasoning blocks are processed

3. Why this matters

- once reasoning text has already entered the answer lane, later correct reasoning blocks can only add another thinking section
- this explains why `messages.context` could end up as:
  - answer first
  - then raw `Reasoning:` tail
  - or answer plus duplicated think content

4. Latest local plugin-debug evidence

- file: `~/.openclaw/agents/default/sessions/dingtalk-state/plugin-debug.jsonl`
- latest samples show:
  - `onPartialReply` repeatedly growing answer text with reasoning-style prefixes
  - `deliver(block)` later classifying explicit `Reasoning:` text correctly
  - therefore the earliest pollution happens before `deliver(block)` / `deliver(final)` cleanup

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

The investigation now points to a mixed responsibility split:

- upstream/runtime/model behavior is still unstable across providers and retries
- but the plugin has its own contamination path: `onPartialReply -> controller.updateAnswer(...)`

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

New plugin-local finding from this continuation:

- even when later reasoning blocks or transcript fallback are available, partial text can already pollute the answer lane first
- the current strongest local hypothesis is:
  - for card mode `/reasoning on`, `onPartialReply` is too permissive
  - it should not blindly feed partial text into `updateAnswer(...)`
  - at minimum, the plugin needs to suppress or classify reasoning-like partial text before it reaches the answer lane

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

4. Investigate / fix partial-reply contamination before further order work

- use `plugin-debug.jsonl` as the primary evidence source
- confirm whether the current model/path is emitting reasoning-like partial text
- then narrow `onPartialReply` for card `/reasoning on` so partial reasoning stops entering the answer lane
- only after that, re-evaluate whether remaining order issues still need the later timeline reordering logic

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
2. Confirm current uncommitted files:
   - `src/reply-strategy-card.ts`
   - `src/card-service.ts`
   - `src/utils.ts`
   - `tests/unit/reply-strategy-card.test.ts`
3. Inspect plugin-local debug evidence first:
   - `~/.openclaw/agents/default/sessions/dingtalk-state/plugin-debug.jsonl`
   - `~/.openclaw/agents/default/sessions/dingtalk-state/messages.context.account-ZGVmYXVsdA.conversation-Y2lkS3pIbGtsV0lHWExGZVBES05WazBmcWpBYlhKekkrOHZoTTVYUzJpS0hFVT0.json`
4. Confirm runtime session file:
   - `~/.openclaw/agents/main/sessions/sessions.json`
   - currently points to session `6e63b13b-bf5d-4ee6-95a5-57073cee526a.jsonl`
5. Continue by narrowing `onPartialReply` for card `/reasoning on`
   - goal: prevent reasoning-like partial text from entering `updateAnswer(...)`
6. After code changes:
   - `npm run type-check`
   - targeted reply-strategy tests
   - restart gateway
7. Re-test one minimal prompt first:
   - `请分步思考后再给结论：如果一个团队有 5 个人，分别单独需要 10、12、15、20、30 天完成同一项任务，且效率可叠加，这项任务预计多少天完成？`
8. Only after that passes, widen back out to the broader `/reasoning on` / `/reasoning stream` matrix

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
