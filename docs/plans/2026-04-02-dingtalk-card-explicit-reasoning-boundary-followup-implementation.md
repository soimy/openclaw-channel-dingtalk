# DingTalk Card Explicit Reasoning Boundary Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove transcript final-answer fallback and plugin-local `plugin-debug` diagnostics from DingTalk card mode while keeping the current explicit-reasoning boundary and preserving the existing answer-block fallback behavior.

**Architecture:** Keep DingTalk card mode narrow: only consume runtime-delivered `partial` / `block` / `final` / explicit reasoning callbacks, and do not read external transcript state for answer recovery. Reuse the existing card draft controller as the answer aggregation surface, delete the temporary transcript fallback wiring, and remove repo-local `plugin-debug` sinks without changing the approved answer-block fallback semantics.

**Tech Stack:** TypeScript, Vitest, existing DingTalk reply strategy / AI Card pipeline, `apply_patch`, `pnpm`

---

## Reference Context

- Discussion record: `docs/plans/2026-04-02-dingtalk-reasoning-contract-and-telegram-alignment.md`
- Handoff context: `docs/plans/2026-04-01-dingtalk-card-reasoning-on-handoff.md`
- Related implementation baseline: `docs/plans/2026-03-30-dingtalk-card-reasoning-block-assembly-implementation.md`

## Confirmed Boundaries

- Keep the current explicit reasoning boundary:
  - only trust `onReasoningStream(...)`
  - only trust `payload.isReasoning === true`
- Keep the current answer-block fallback behavior:
  - non-`isReasoning` text delivered through `block` still counts as answer text
  - do **not** change this behavior in this follow-up
- Remove transcript final-answer fallback entirely
- Remove plugin-local `plugin-debug` output entirely
- Do not introduce a new answer pool on `AICardInstance`
  - continue using `CardDraftController` answer accumulation as the plugin-local aggregation surface
- Do not modify Telegram-alignment heuristics or reintroduce text-based reasoning splitting

## File Map

- Modify: `src/reply-strategy-card.ts`
  - remove transcript fallback logic and `plugin-debug` writes
  - keep answer-block fallback behavior unchanged
- Modify: `src/reply-strategy.ts`
  - remove transcript fallback fields from `ReplyStrategyContext`
- Modify: `src/inbound-handler.ts`
  - stop passing transcript fallback flags into the strategy
- Modify: `src/card-service.ts`
  - remove `plugin-debug` writes from card finalization
- Modify: `src/utils.ts`
  - delete `plugin-debug` helper exports
- Delete: `src/transcript-final-answer-fallback.ts`
  - remove the helper entirely after its call sites are gone
- Modify: `tests/unit/reply-strategy-card.test.ts`
  - replace transcript-fallback expectations with the new approved boundary
- Delete: `tests/unit/transcript-final-answer-fallback.test.ts`
  - remove the dead helper test file
- Modify: `docs/plans/2026-04-02-dingtalk-reasoning-contract-and-telegram-alignment.md`
  - update the written discussion to reflect the final decision:
    - keep answer-block fallback
    - remove transcript fallback
    - remove `plugin-debug` in this PR

## Task 1: Re-lock Card Strategy Tests Around the Approved Boundary

**Files:**
- Modify: `tests/unit/reply-strategy-card.test.ts`
- Delete: `tests/unit/transcript-final-answer-fallback.test.ts`

- [ ] **Step 1: Replace transcript fallback expectations with the approved finalization behavior**

Update `tests/unit/reply-strategy-card.test.ts` so it no longer expects transcript recovery.

Replace the current transcript fallback case with a case shaped like:

```ts
it("uses the file-only placeholder when process blocks exist but no answer text was delivered", async () => {
    const card = makeCard();
    const strategy = createCardReplyStrategy(buildCtx(card, {
        disableBlockStreaming: false,
    }));

    await strategy.deliver({
        text: "Reasoning:\n_Reason: 先执行 pwd_",
        mediaUrls: [],
        kind: "block",
        isReasoning: true,
    });
    await strategy.deliver({ text: "pwd", mediaUrls: [], kind: "tool" });
    await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
    await strategy.finalize();

    const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
    expect(rendered).toContain("> Reason: 先执行 pwd");
    expect(rendered).toContain("> pwd");
    expect(rendered).toContain("附件已发送，请查收。");
    expect(rendered).not.toContain("/Users/sym/clawd");
});
```

Also remove the test case that injects `readFinalAnswerFromTranscript`.

- [ ] **Step 2: Delete the now-dead helper test file**

Delete `tests/unit/transcript-final-answer-fallback.test.ts`.

- [ ] **Step 3: Run targeted tests to verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts
```

Expected:

- FAIL because runtime-facing card strategy still contains transcript fallback state and old tests/code paths

- [ ] **Step 4: Keep the existing answer-block fallback coverage intact**

Before implementing code changes, confirm these existing tests still remain in the file:

- `deliver(block) preserves answer text even when card block streaming is disabled`
- `finalize preserves answer text that only arrived through block delivery`

Do not weaken or remove them; they capture the approved “问题 2 维持现状” decision.

- [ ] **Step 5: Commit the test boundary update**

```bash
git add tests/unit/reply-strategy-card.test.ts tests/unit/transcript-final-answer-fallback.test.ts
git commit -m "test(card): lock explicit reasoning boundary without transcript fallback"
```

## Task 2: Remove Transcript Final-Answer Fallback from the Card Strategy

**Files:**
- Modify: `src/reply-strategy-card.ts`
- Modify: `src/reply-strategy.ts`
- Modify: `src/inbound-handler.ts`
- Delete: `src/transcript-final-answer-fallback.ts`

- [ ] **Step 1: Remove transcript fallback fields from strategy context**

In `src/reply-strategy.ts`, delete these fields from `ReplyStrategyContext`:

```ts
enableTemporaryTranscriptFinalAnswerFallback?: boolean;
readFinalAnswerFromTranscript?: (params: {
  agentId: string;
  sessionKey: string;
}) => Promise<string | undefined>;
```

- [ ] **Step 2: Remove transcript fallback wiring from inbound-handler**

In `src/inbound-handler.ts`, stop passing:

```ts
enableTemporaryTranscriptFinalAnswerFallback:
  replyMode === "card" && sessionReasoningLevel === "on",
```

No replacement wiring is needed.

- [ ] **Step 3: Remove transcript fallback logic from the card strategy**

In `src/reply-strategy-card.ts`:

- delete the import of `readLatestAssistantTextFromTranscript`
- delete `usedTranscriptFinalAnswerFallback`
- delete `readFinalAnswerFromTranscript`
- delete the `if (...) { ...readFinalAnswerFromTranscript(...)... }` branch inside `finalize()`
- simplify the final source log so it no longer includes `transcript.fallback`

After this change, `finalize()` should derive the final card text only from:

1. `finalTextForFallback`
2. `controller.getFinalAnswerContent()`
3. file-only placeholder through `getRenderedTimeline(...)`
4. final `"✅ Done"` fallback

- [ ] **Step 4: Delete the dead helper file**

Delete `src/transcript-final-answer-fallback.ts`.

- [ ] **Step 5: Run targeted tests to verify GREEN**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts tests/unit/inbound-handler.test.ts
```

Expected:

- PASS
- no remaining imports or references to transcript fallback helper

- [ ] **Step 6: Run type-check**

Run:

```bash
npm run type-check
```

Expected:

- PASS

- [ ] **Step 7: Commit transcript fallback removal**

```bash
git add src/reply-strategy-card.ts src/reply-strategy.ts src/inbound-handler.ts src/transcript-final-answer-fallback.ts tests/unit/reply-strategy-card.test.ts
git commit -m "refactor(card): remove transcript final-answer fallback"
```

## Task 3: Remove Plugin-Local `plugin-debug` Diagnostics

**Files:**
- Modify: `src/utils.ts`
- Modify: `src/reply-strategy-card.ts`
- Modify: `src/card-service.ts`

- [ ] **Step 1: Remove the helper exports from `utils.ts`**

Delete:

```ts
const PLUGIN_DEBUG_FILE = "plugin-debug.jsonl";
const DEBUG_PREVIEW_LIMIT = 240;

export function previewDebugText(...) { ... }
export function writePluginDebugLog(...) { ... }
```

Keep the existing non-debug utility helpers intact.

- [ ] **Step 2: Remove plugin-debug usage from card strategy**

In `src/reply-strategy-card.ts`:

- remove `previewDebugText` and `writePluginDebugLog` imports
- delete `emitPluginDebug(...)`
- delete the `emitPluginDebug(ctx, "finalize", "pre_finish", ...)` call

Do not replace it with new filesystem writes in this PR.

- [ ] **Step 3: Remove plugin-debug usage from card-service**

In `src/card-service.ts`, delete both `writePluginDebugLog(...)` calls inside `finishAICard(...)`.

Keep the normal `log?.debug?.(...)` calls unchanged.

- [ ] **Step 4: Run focused regression tests**

Run:

```bash
pnpm exec vitest run tests/unit/card-service.test.ts tests/unit/reply-strategy-card.test.ts tests/unit/utils.test.ts
```

Expected:

- PASS
- no compile/runtime references to deleted `plugin-debug` helpers

- [ ] **Step 5: Run type-check again**

Run:

```bash
npm run type-check
```

Expected:

- PASS

- [ ] **Step 6: Commit plugin-debug removal**

```bash
git add src/utils.ts src/reply-strategy-card.ts src/card-service.ts
git commit -m "refactor(debug): remove plugin-local card debug sink"
```

## Task 4: Align the Written Follow-up Record with the Final Decision

**Files:**
- Modify: `docs/plans/2026-04-02-dingtalk-reasoning-contract-and-telegram-alignment.md`

- [ ] **Step 1: Update the discussion record so it matches the approved scope**

Revise the existing Chinese write-up to reflect:

- keep answer-block fallback behavior
- remove transcript final-answer fallback
- remove `plugin-debug` in this PR
- follow-up global debug stabilization will happen in a separate PR

Specifically correct the current section that suggests future tightening of answer-block UI behavior when `disableBlockStreaming=true`.

- [ ] **Step 2: Run a quick content grep to verify the old conclusion is gone**

Run:

```bash
rg -n "transcript fallback|answer block 不应|plugin-debug" docs/plans/2026-04-02-dingtalk-reasoning-contract-and-telegram-alignment.md
```

Expected:

- only the new, approved wording remains

- [ ] **Step 3: Commit the documentation alignment**

```bash
git add docs/plans/2026-04-02-dingtalk-reasoning-contract-and-telegram-alignment.md docs/plans/2026-04-02-dingtalk-card-explicit-reasoning-boundary-followup-implementation.md
git commit -m "docs(plans): align explicit reasoning boundary follow-up scope"
```

## Task 5: Final Verification Before Merge Preparation

**Files:**
- Verify the modified files from Tasks 1-4 only

- [ ] **Step 1: Run the full test suite**

Run:

```bash
pnpm test
```

Expected:

- PASS

- [ ] **Step 2: Run type-check one last time**

Run:

```bash
npm run type-check
```

Expected:

- PASS

- [ ] **Step 3: Review final diff against `origin/main`**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --unified=40 origin/main...HEAD -- src/reply-strategy-card.ts src/reply-strategy.ts src/inbound-handler.ts src/card-service.ts src/utils.ts tests/unit/reply-strategy-card.test.ts docs/plans/2026-04-02-dingtalk-reasoning-contract-and-telegram-alignment.md
```

Expected review outcome:

- transcript fallback is fully gone
- `plugin-debug` is fully gone
- explicit reasoning boundary remains unchanged
- answer-block fallback behavior remains unchanged

- [ ] **Step 4: Prepare merge-facing summary**

Summarize for PR update / merge prep:

- removed transcript fallback due lack of stable per-turn anchor
- removed plugin-local debug sink; future debug stabilization will be handled in a separate PR
- intentionally kept answer-block fallback behavior unchanged

- [ ] **Step 5: Commit any final nits from verification**

```bash
git add -A
git commit -m "chore: finalize explicit reasoning boundary follow-up"
```
