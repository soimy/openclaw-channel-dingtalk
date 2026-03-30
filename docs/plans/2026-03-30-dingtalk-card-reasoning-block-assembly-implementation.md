# DingTalk Card Reasoning Block Assembly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DingTalk card mode show think blocks for both `/reasoning on` and `/reasoning stream`, while buffering stream reasoning into block-level card updates instead of high-frequency token-level card refreshes.

**Architecture:** Add a dedicated card-domain reasoning block assembler that normalizes and groups upstream formatted reasoning snapshots into sealed think blocks. Route both `onReasoningStream` and `deliver(kind: "block", isReasoning: true)` through that assembler, flush pending reasoning at tool / answer / finalize boundaries, and append only assembled think blocks to the existing card timeline controller.

**Tech Stack:** TypeScript, Vitest, existing DingTalk AI Card timeline controller, `apply_patch`, `pnpm`

---

## Reference Spec

- `docs/spec/2026-03-30-dingtalk-card-reasoning-block-assembly-design.md`
- `docs/spec/2026-03-27-dingtalk-card-single-timeline-display-design.md`
- `docs/plans/2026-03-27-dingtalk-card-single-timeline-display.md`

## File Map

- Create: `src/card/reasoning-block-assembler.ts`
  - Normalize formatted reasoning text, track consumed regions, emit complete think blocks, and flush pending reasoning at boundaries.
- Modify: `src/reply-strategy.ts`
  - Extend `DeliverPayload` to carry reasoning block metadata.
- Modify: `src/inbound-handler.ts`
  - Preserve upstream `isReasoning` metadata when translating dispatcher deliveries to strategy deliveries.
- Modify: `src/reply-strategy-card.ts`
  - Route `/reasoning on` and `/reasoning stream` through the assembler and append only assembled think blocks to the card timeline.
- Modify: `src/card-draft-controller.ts`
  - Add a sealed-thinking append API so completed reasoning blocks enter the timeline without live replace semantics.
- Create: `tests/unit/reasoning-block-assembler.test.ts`
  - Lock grouping, flush, dedupe, and boundary behavior.
- Modify: `tests/unit/reply-strategy-card.test.ts`
  - Lock card strategy integration with the assembler.
- Modify: `tests/unit/inbound-handler.test.ts`
  - Lock end-to-end `/reasoning on` and block-level `/reasoning stream` card behavior.

## Hard Boundaries

- Do not modify `src/send-service.ts`.
- Do not modify `src/card-service.ts`.
- Do not change markdown strategy behavior in this implementation pass.
- Do not build a generalized cross-channel reasoning parser in `shared/`; keep the first pass card-local.
- Do not reintroduce token-level reasoning pushes to the card controller after the new assembler is in place.

## Task 1: Lock Reasoning Block Assembly Behavior in New Unit Tests

**Files:**
- Create: `tests/unit/reasoning-block-assembler.test.ts`
- Reference: `src/card/reasoning-block-assembler.ts`

- [ ] **Step 1: Write the failing assembler test file**

Create focused tests for these cases:

```ts
it("emits nothing until a complete Reason block is closed", () => {
    const assembler = createReasoningBlockAssembler();

    expect(assembler.ingestSnapshot("Reasoning:\n_Reason: 先检查")).toEqual([]);
    expect(
        assembler.ingestSnapshot("Reasoning:\n_Reason: 先检查当前改动_"),
    ).toEqual(["Reason: 先检查当前改动"]);
});
```

Add separate tests for:

- multiple complete think blocks emitted in order from one snapshot
- repeated snapshot input does not re-emit already consumed blocks
- prefix-growing stream input only emits newly completed blocks
- boundary flush emits pending unfinished reasoning as the final block
- empty / whitespace / malformed input yields no output

- [ ] **Step 2: Run the new assembler tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/reasoning-block-assembler.test.ts
```

Expected:

- FAIL because `src/card/reasoning-block-assembler.ts` does not exist yet

- [ ] **Step 3: Create minimal assembler implementation to satisfy the first test**

Create `src/card/reasoning-block-assembler.ts` with only the minimum public surface:

```ts
export interface ReasoningBlockAssembler {
    ingestSnapshot(text: string | undefined): string[];
    flushPendingAtBoundary(): string[];
    reset(): void;
}
```

Implement just enough parsing to pass the first test, then expand iteratively.

- [ ] **Step 4: Re-run assembler tests and add the next failing cases one by one**

Use red-green cycles until all assembler tests pass.

Run repeatedly:

```bash
pnpm exec vitest run tests/unit/reasoning-block-assembler.test.ts
```

- [ ] **Step 5: Commit the assembler test + implementation baseline**

```bash
git add tests/unit/reasoning-block-assembler.test.ts src/card/reasoning-block-assembler.ts
git commit -m "feat(card): add reasoning block assembler"
```

## Task 2: Lock Card Controller and Strategy Expectations Before Rewiring

**Files:**
- Modify: `tests/unit/reply-strategy-card.test.ts`
- Modify: `tests/unit/card-draft-controller.test.ts`
- Reference: `src/reply-strategy-card.ts`
- Reference: `src/card-draft-controller.ts`

- [ ] **Step 1: Add a failing controller test for sealed thinking append**

Add a focused test that describes the new API:

```ts
it("appends completed thinking blocks without live replacement semantics", async () => {
    const ctrl = createCardDraftController({ card: makeCard(), throttleMs: 0 }) as any;

    await ctrl.appendThinkingBlock("Reason: 先检查当前目录");
    await ctrl.appendThinkingBlock("Reason: 再确认 reply strategy 入口");
    await vi.advanceTimersByTimeAsync(0);

    const rendered = ctrl.getRenderedContent?.() ?? "";
    expect(rendered).toContain("> Reason: 先检查当前目录");
    expect(rendered).toContain("> Reason: 再确认 reply strategy 入口");
});
```

- [ ] **Step 2: Add failing card strategy tests for unified reasoning sources**

Extend `tests/unit/reply-strategy-card.test.ts` to cover:

- `onReasoningStream` does not stream every partial snapshot directly into the controller
- `deliver({ kind: "block", isReasoning: true })` enters the same reasoning path
- `deliver({ kind: "tool" })` first flushes pending reasoning before appending the tool block
- `deliver({ kind: "final" })` first flushes pending reasoning before saving the final answer

Example shape:

```ts
await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 先检查" });
await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 先检查当前改动_" });

expect(streamAICardMock).toHaveBeenCalledTimes(1);
expect(streamAICardMock.mock.calls[0]?.[1]).toContain("> Reason: 先检查当前改动");
```

- [ ] **Step 3: Run the controller + strategy tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/card-draft-controller.test.ts tests/unit/reply-strategy-card.test.ts
```

Expected:

- FAIL because `appendThinkingBlock` does not exist
- FAIL because card strategy still uses `updateThinking()` directly
- FAIL because `DeliverPayload` cannot distinguish reasoning blocks

- [ ] **Step 4: Implement the minimal controller API**

Modify `src/card-draft-controller.ts` to add a sealed-thinking append entry point.

Constraints:

- keep existing `updateReasoning / updateThinking` exports temporarily for compatibility
- new sealed append should insert a `thinking` entry and immediately treat it as finalized
- do not break existing reasoning-related tests that still cover legacy controller behavior

- [ ] **Step 5: Commit the controller surface change**

```bash
git add tests/unit/card-draft-controller.test.ts tests/unit/reply-strategy-card.test.ts src/card-draft-controller.ts
git commit -m "refactor(card): add sealed thinking block append api"
```

## Task 3: Thread Reasoning Metadata Through the Delivery Path

**Files:**
- Modify: `src/reply-strategy.ts`
- Modify: `src/inbound-handler.ts`
- Modify: `tests/unit/inbound-handler.test.ts`

- [ ] **Step 1: Add failing end-to-end tests for reasoning-on card delivery**

In `tests/unit/inbound-handler.test.ts`, add a targeted case where the mocked runtime delivers:

```ts
await dispatcherOptions.deliver(
    { text: "Reasoning:\n_Reason: 先检查当前目录_", isReasoning: true },
    { kind: "block" },
);
await dispatcherOptions.deliver({ text: "最终答案" }, { kind: "final" });
```

Assert:

- `finishAICardMock` final content contains the think block
- the think block appears before the answer
- no markdown fallback path is used

- [ ] **Step 2: Add failing tests for stream reasoning block assembly at runtime level**

Add a second inbound-handler test where:

- two `onReasoningStream` snapshots arrive
- only the completed one causes a card update
- a subsequent `tool` or `final` flushes remaining pending reasoning before answer/tool

- [ ] **Step 3: Run inbound-handler tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/inbound-handler.test.ts -t "reasoning on|reasoning stream|card"
```

Expected:

- FAIL because `isReasoning` metadata is dropped in `inbound-handler.ts`
- FAIL because card strategy still ignores text `block` payloads

- [ ] **Step 4: Extend delivery types and pass through reasoning metadata**

Modify `src/reply-strategy.ts`:

```ts
export interface DeliverPayload {
    text?: string;
    mediaUrls: string[];
    kind: "block" | "final" | "tool";
    isReasoning?: boolean;
}
```

Modify `src/inbound-handler.ts` to preserve upstream payload metadata:

```ts
const richPayload = payload as ReplyStreamPayload & { isReasoning?: boolean };
...
await strategy.deliver({
    text: payload.text,
    mediaUrls,
    kind: ...,
    isReasoning: richPayload.isReasoning === true,
});
```

- [ ] **Step 5: Re-run the inbound-handler tests**

Run:

```bash
pnpm exec vitest run tests/unit/inbound-handler.test.ts -t "reasoning on|reasoning stream|card"
```

Keep iterating until the new runtime-path tests pass.

- [ ] **Step 6: Commit delivery-path metadata support**

```bash
git add tests/unit/inbound-handler.test.ts src/reply-strategy.ts src/inbound-handler.ts
git commit -m "feat(card): preserve reasoning block metadata in reply delivery"
```

## Task 4: Rewire Card Strategy to Use the Assembler

**Files:**
- Modify: `src/reply-strategy-card.ts`
- Reference: `src/card/reasoning-block-assembler.ts`
- Test: `tests/unit/reply-strategy-card.test.ts`

- [ ] **Step 1: Instantiate the assembler inside card strategy**

Add assembler lifecycle state near controller creation:

```ts
const reasoningAssembler = createReasoningBlockAssembler();
```

Add a small local helper:

```ts
const appendAssembledThinkingBlocks = async (blocks: string[]) => {
    for (const block of blocks) {
        if (!block.trim() || isStopRequested?.()) continue;
        await controller.appendThinkingBlock(block);
    }
};
```

- [ ] **Step 2: Route `onReasoningStream` through the assembler**

Replace direct `controller.updateThinking(payload.text)` calls with:

```ts
const blocks = reasoningAssembler.ingestSnapshot(payload.text);
await appendAssembledThinkingBlocks(blocks);
```

- [ ] **Step 3: Route reasoning-on blocks through the same assembler**

In `deliver(payload)`:

- if `payload.kind === "block"` and `payload.isReasoning === true`
- feed `payload.text` into the assembler
- append any completed blocks
- still preserve media delivery behavior

Normal non-reasoning text blocks should remain ignored in card mode.

- [ ] **Step 4: Flush pending reasoning at boundaries**

Before:

- appending a tool block
- saving a final answer
- finalizing the card

call:

```ts
await appendAssembledThinkingBlocks(reasoningAssembler.flushPendingAtBoundary());
```

- [ ] **Step 5: Re-run strategy tests until GREEN**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts tests/unit/card-draft-controller.test.ts
```

- [ ] **Step 6: Commit card strategy rewiring**

```bash
git add src/reply-strategy-card.ts tests/unit/reply-strategy-card.test.ts
git commit -m "feat(card): assemble reasoning into block-level timeline updates"
```

## Task 5: Run Full Verification and Update User-Facing Docs if Needed

**Files:**
- Modify if needed: `docs/user/features/reply-modes.md`
- Verify: `docs/spec/2026-03-30-dingtalk-card-reasoning-block-assembly-design.md`

- [ ] **Step 1: Re-read the user-facing reply mode wording**

Check whether the current card wording:

- overstates `/reasoning stream`
- understates `/reasoning on`
- or needs to mention “block-level” rather than “fully live token stream”

If wording is now inaccurate, update `docs/user/features/reply-modes.md` minimally.

- [ ] **Step 2: Run targeted verification**

Run:

```bash
pnpm exec vitest run tests/unit/reasoning-block-assembler.test.ts tests/unit/reply-strategy-card.test.ts tests/unit/card-draft-controller.test.ts tests/unit/inbound-handler.test.ts -t "reasoning|card"
```

Expected:

- all targeted reasoning/card tests PASS

- [ ] **Step 3: Run full repository verification**

Run:

```bash
pnpm test
```

Expected:

- full suite PASS

- [ ] **Step 4: Run static verification if docs or types changed materially**

Run:

```bash
pnpm run type-check
pnpm run lint
```

Expected:

- both commands PASS

- [ ] **Step 5: Commit verification-ready result**

```bash
git add src/card/reasoning-block-assembler.ts src/reply-strategy-card.ts src/card-draft-controller.ts src/reply-strategy.ts src/inbound-handler.ts tests/unit/reasoning-block-assembler.test.ts tests/unit/reply-strategy-card.test.ts tests/unit/card-draft-controller.test.ts tests/unit/inbound-handler.test.ts docs/user/features/reply-modes.md
git commit -m "fix(card): unify reasoning-on and reasoning-stream block delivery"
```

## Execution Notes

- Prefer tiny red-green cycles over writing the whole parser first.
- If the first parser implementation becomes regex-heavy and brittle, stop and split the logic into:
  - normalization
  - block scanning
  - boundary flush
- Preserve existing card timeline ordering invariants:
  - earlier thinking block
  - then tool block
  - then answer
- Do not silently relax tests that prove `/reasoning stream` no longer drives token-level card updates.
