# DingTalk Card Reasoning and Answer Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DingTalk card mode recover real answers during `/reasoning on` by splitting delivered text into reasoning and answer segments before writing into the existing single-timeline card controller.

**Architecture:** Keep explicit reasoning callbacks and `isReasoning` metadata as the primary source of truth, but add a DingTalk-local split helper for `deliver(block/final)` text so mixed `Reasoning:` payloads can still be routed into `thinking` and `answer` timeline entries. Reuse the existing card controller and reasoning assembler instead of introducing a second timeline or transcript fallback.

**Tech Stack:** TypeScript, Vitest, existing DingTalk reply strategy / AI Card pipeline, `apply_patch`, `pnpm`

---

## Reference Context

- Spec: `docs/spec/2026-04-02-dingtalk-card-reasoning-answer-split-design.md`
- Discussion record: `docs/plans/2026-04-02-dingtalk-reasoning-contract-and-telegram-alignment.md`
- Related baseline: `docs/plans/2026-03-30-dingtalk-card-reasoning-block-assembly-implementation.md`

## File Map

- Create: `src/card/reasoning-answer-split.ts`
  - DingTalk-local helper that splits one text payload into `reasoningText` and `answerText`
- Modify: `src/reply-strategy-card.ts`
  - apply explicit reasoning first, then use split helper for `block/final` payloads
- Modify: `tests/unit/reply-strategy-card.test.ts`
  - cover mixed block/final reasoning payloads and final-answer recovery
- Modify: `tests/unit/inbound-handler.test.ts`
  - cover end-to-end `/reasoning on` card behavior without relying on mocked ideal runtime callbacks
- Optional verify-only reads:
  - `src/card/reasoning-block-assembler.ts`
  - `src/card-draft-controller.ts`

## Hard Boundaries

- Do not change markdown strategy behavior in this pass.
- Do not copy Telegram draft lane lifecycle into DingTalk.
- Do not loosen reasoning detection to arbitrary prose like “分步思考如下”.
- Do not modify `src/send-service.ts` or `src/card-service.ts`.
- Do not reintroduce transcript fallback.

## Task 1: Add Failing Tests for Mixed Reasoning/Answer Delivery

**Files:**
- Modify: `tests/unit/reply-strategy-card.test.ts`
- Modify: `tests/unit/inbound-handler.test.ts`

- [ ] **Step 1: Add a failing card-strategy test for mixed block payload splitting**

Add a case shaped like:

```ts
it("deliver(block) splits mixed Reasoning and answer text into separate timeline entries", async () => {
    const card = makeCard();
    const strategy = createCardReplyStrategy(buildCtx(card, { disableBlockStreaming: false }));

    await strategy.deliver({
        text: "Reasoning:\\n_Reason: 先检查当前目录_\\n\\n最终答案：/tmp",
        mediaUrls: [],
        kind: "block",
    });
    await strategy.finalize();

    const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
    expect(rendered).toContain("> Reason: 先检查当前目录");
    expect(rendered).toContain("最终答案：/tmp");
});
```

- [ ] **Step 2: Add a failing card-strategy test for mixed final payload splitting**

Add a second case where `deliver(final)` receives:

```ts
"Reasoning:\n_Reason: 先检查当前目录_\n\n最终答案"
```

Assert that:

- reasoning enters the rendered timeline as blockquote text
- final answer content is preserved as plain answer text
- `strategy.getFinalText()` equals the answer-only portion

- [ ] **Step 3: Add a failing inbound-handler test for `/reasoning on` real-device shape**

Mock runtime delivery so card mode receives only:

```ts
await dispatcherOptions.deliver({
  text: "Reasoning:\n_Reason: 先检查当前目录_\n\n最终答案",
}, { kind: "block" });
await dispatcherOptions.deliver({ text: "" }, { kind: "final" });
```

Assert that final card content contains both:

- `> Reason: 先检查当前目录`
- `最终答案`

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts tests/unit/inbound-handler.test.ts
```

Expected:

- FAIL because current card strategy keeps non-`isReasoning` mixed payloads in the answer lane or drops answer recovery

## Task 2: Implement DingTalk-Local Reasoning/Answer Split Helper

**Files:**
- Create: `src/card/reasoning-answer-split.ts`
- Modify: `src/reply-strategy-card.ts`

- [ ] **Step 1: Add the split helper with a minimal public surface**

Create:

```ts
export type CardReasoningAnswerSplit = {
    reasoningText?: string;
    answerText?: string;
};

export function splitCardReasoningAnswerText(text?: string): CardReasoningAnswerSplit
```

Rules:

- prefer exact `Reasoning:\n...` prefix handling
- support top-level `<think>` / `<thinking>` tag extraction
- return answer-only when no stable reasoning wrapper is present

- [ ] **Step 2: Reuse the helper inside `reply-strategy-card.ts`**

Apply this order:

1. `payload.isReasoning === true`
   - keep current reasoning assembler path
2. otherwise, when `payload.text` exists
   - call `splitCardReasoningAnswerText(...)`
   - send `reasoningText` through `ingestReasoningSnapshot(...)`
   - send `answerText` through `controller.updateAnswer(...)`

- [ ] **Step 3: Make final-answer fallback answer-only**

When `deliver(final)` receives mixed text:

- flush pending reasoning first
- split final text
- only persist the answer portion into `finalTextForFallback`

If the split yields only reasoning and no answer:

- do not overwrite a previously accumulated answer with reasoning text

- [ ] **Step 4: Keep answer-only and explicit reasoning paths unchanged**

Confirm that:

- explicit `isReasoning` blocks still route through assembler
- pure answer blocks/finals still route directly to `updateAnswer(...)`
- existing reasoning-stream callback flow still works

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts tests/unit/inbound-handler.test.ts
```

Expected:

- PASS for the new mixed-payload cases
- PASS for the existing explicit reasoning tests

## Task 3: Regression Verification

**Files:**
- No new files

- [ ] **Step 1: Run reasoning/card focused tests**

Run:

```bash
pnpm exec vitest run \
  tests/unit/reply-strategy-card.test.ts \
  tests/unit/inbound-handler.test.ts \
  tests/unit/card-draft-controller.test.ts \
  tests/unit/reasoning-block-assembler.test.ts
```

Expected:

- PASS

- [ ] **Step 2: Run type-check**

Run:

```bash
npm run type-check
```

Expected:

- PASS

- [ ] **Step 3: Run full test suite**

Run:

```bash
pnpm test
```

Expected:

- PASS

- [ ] **Step 4: Commit the implementation**

```bash
git add docs/spec/2026-04-02-dingtalk-card-reasoning-answer-split-design.md \
  docs/plans/2026-04-02-dingtalk-card-reasoning-answer-split-implementation.md \
  src/card/reasoning-answer-split.ts \
  src/reply-strategy-card.ts \
  tests/unit/reply-strategy-card.test.ts \
  tests/unit/inbound-handler.test.ts
git commit -m "fix(card): split delivered reasoning and answer text"
```
