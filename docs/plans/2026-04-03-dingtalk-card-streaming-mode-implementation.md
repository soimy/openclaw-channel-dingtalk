# DingTalk Card Streaming Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split card streaming booleans with `cardStreamingMode`, preserve `/reasoning on` timeline correctness, and minimize DingTalk card update API calls.

**Architecture:** Add a small config compatibility helper, keep `CardDraftController` as the single timeline renderer with content dedupe, and refactor `reply-strategy-card.ts` into a mode-driven event policy that preserves late think/tool events after `final` while freezing late answer edits. Keep the existing local reasoning/answer split helper and update user-facing docs after behavior is covered by tests.

**Tech Stack:** TypeScript, Vitest, Zod config schema, DingTalk AI Card streaming API, `apply_patch`, `pnpm`, `npm`

---

## Reference Spec

- `docs/spec/2026-04-03-dingtalk-card-streaming-mode-design.md`

## Worktree Notes

- Current branch: `reasoning-card-split`
- This worktree may already contain unrelated uncommitted cleanup in:
  - `src/reply-strategy-card.ts`
  - `tests/unit/reply-strategy-card.test.ts`
- Before starting implementation, run `git status --short` and preserve any existing user edits in those files. Do not revert them accidentally.

## File Map

- Create: `src/card/card-streaming-mode.ts`
  - Resolve the effective streaming mode from new and legacy config fields.
  - Expose tiny mode predicates and one-shot legacy warning helpers.
- Create: `tests/unit/card-streaming-mode.test.ts`
  - Lock compatibility mapping, explicit-precedence behavior, and one-shot warnings.
- Modify: `src/config-schema.ts`
  - Add `cardStreamingMode`, keep `cardStreamInterval`, deprecate `cardRealTimeStream`, and drop `cardStreamReasoning`.
- Modify: `src/types.ts`
  - Add the enum config field to both DingTalk config interfaces and `resolveDingTalkAccount`, mark `cardRealTimeStream` deprecated, and stop copying `cardStreamReasoning`.
- Modify: `src/config.ts`
  - Strip `cardStreamReasoning` from merged configs so removed legacy state does not leak through account inheritance.
- Modify: `tests/unit/config-schema.test.ts`
  - Cover the new enum field and confirm removed legacy fields do not surface.
- Modify: `tests/unit/config-advanced.test.ts`
  - Cover top-level/account config inheritance for `cardStreamingMode` and removal of `cardStreamReasoning`.
- Modify: `tests/unit/types.test.ts`
  - Cover `resolveDingTalkAccount()` copying `cardStreamingMode` and not copying `cardStreamReasoning`.
- Modify: `src/card-draft-controller.ts`
  - Add content-level dedupe before queueing stream updates.
- Modify: `tests/unit/card-draft-controller.test.ts`
  - Lock “same rendered content does not call `streamAICard` again”.
- Modify: `src/reply-strategy-card.ts`
  - Replace mode-specific branching with the new policy/state model, keep local split fallback, and preserve late process events after `final`.
- Modify: `tests/unit/reply-strategy-card.test.ts`
  - Lock `off | answer | all`, `final_seen`, late process acceptance, late answer freeze, and legacy-mode compatibility.
- Modify: `tests/unit/inbound-handler.test.ts`
  - Add integration coverage around `/reasoning on`, late process after `final`, and `cardStreamingMode` behavior.
- Modify: `docs/user/features/ai-card.md`
  - Document `cardStreamingMode`, mode semantics, and the legacy field deprecation.
- Modify: `docs/user/reference/configuration.md`
  - Replace the old card streaming boolean with the enum config and explain compatibility.
- Modify: `docs/user/reference/api-usage-and-cost.md`
  - Update cost recommendations and explain how `off | answer | all` affect API call volume.

## Task 1: Add `cardStreamingMode` Config and Compatibility Resolution

**Files:**
- Create: `src/card/card-streaming-mode.ts`
- Create: `tests/unit/card-streaming-mode.test.ts`
- Modify: `src/config-schema.ts`
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Test: `tests/unit/config-schema.test.ts`
- Test: `tests/unit/config-advanced.test.ts`
- Test: `tests/unit/types.test.ts`

- [ ] **Step 1: Write failing tests for mode resolution and config compatibility**

Add tests that lock these cases:

```ts
expect(resolveCardStreamingMode({ cardStreamingMode: "answer", cardRealTimeStream: true }))
  .toEqual({ mode: "answer", usedDeprecatedCardRealTimeStream: false });

expect(resolveCardStreamingMode({ cardRealTimeStream: true }))
  .toEqual({ mode: "all", usedDeprecatedCardRealTimeStream: true });

expect(resolveCardStreamingMode({}))
  .toEqual({ mode: "off", usedDeprecatedCardRealTimeStream: false });
```

Also add schema/type/config tests for:

- `cardStreamingMode` defaults to `off`
- account-level `cardStreamingMode` can override top-level defaults
- `cardStreamReasoning` is stripped from parsed/resolved configs
- `cardRealTimeStream` still parses for backward compatibility

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
pnpm exec vitest run tests/unit/card-streaming-mode.test.ts tests/unit/config-schema.test.ts tests/unit/config-advanced.test.ts tests/unit/types.test.ts
```

Expected:

- FAIL because `src/card/card-streaming-mode.ts` does not exist yet
- FAIL because `cardStreamingMode` is not in schema/types yet
- FAIL because `cardStreamReasoning` still leaks through config resolution

- [ ] **Step 3: Implement the config compatibility helper and schema/type updates**

Create `src/card/card-streaming-mode.ts` with a tiny pure resolver plus one-shot warning support:

```ts
export type CardStreamingMode = "off" | "answer" | "all";

const warnedLegacyConfigs = new Set<string>();

export function resolveCardStreamingMode(
  config: Pick<DingTalkConfig, "cardStreamingMode" | "cardRealTimeStream">,
): {
  mode: CardStreamingMode;
  usedDeprecatedCardRealTimeStream: boolean;
} {
  if (config.cardStreamingMode) {
    return { mode: config.cardStreamingMode, usedDeprecatedCardRealTimeStream: false };
  }
  if (config.cardRealTimeStream === true) {
    return { mode: "all", usedDeprecatedCardRealTimeStream: true };
  }
  return { mode: "off", usedDeprecatedCardRealTimeStream: false };
}
```

Implementation requirements:

- add `cardStreamingMode: z.enum(["off", "answer", "all"]).optional().default("off")` to `src/config-schema.ts`
- keep `cardStreamInterval` as the unified throttle field
- mark `cardRealTimeStream` as deprecated in `src/types.ts`
- remove `cardStreamReasoning` from public config interfaces and from `resolveDingTalkAccount()`
- extend `stripRemovedLegacyFields()` in `src/config.ts` so it also removes `cardStreamReasoning`

- [ ] **Step 4: Run the focused tests again and confirm they pass**

Run:

```bash
pnpm exec vitest run tests/unit/card-streaming-mode.test.ts tests/unit/config-schema.test.ts tests/unit/config-advanced.test.ts tests/unit/types.test.ts
```

Expected:

- PASS for all config and mode-resolution coverage

- [ ] **Step 5: Commit the config compatibility layer**

```bash
git add src/card/card-streaming-mode.ts src/config-schema.ts src/config.ts src/types.ts tests/unit/card-streaming-mode.test.ts tests/unit/config-schema.test.ts tests/unit/config-advanced.test.ts tests/unit/types.test.ts
git commit -m "feat(card): add cardStreamingMode config compatibility"
```

## Task 2: Add Content-Level Dedupe to `CardDraftController`

**Files:**
- Modify: `src/card-draft-controller.ts`
- Test: `tests/unit/card-draft-controller.test.ts`

- [ ] **Step 1: Write failing controller tests for duplicate-content suppression**

Add coverage for:

```ts
it("does not send the same rendered timeline twice", async () => {
    const card = makeCard();
    const controller = createCardDraftController({ card, log, throttleMs: 0 });

    await controller.appendThinkingBlock("先检查目录");
    await vi.advanceTimersByTimeAsync(0);

    await controller.sealActiveThinking();
    await vi.advanceTimersByTimeAsync(0);

    expect(streamAICardMock).toHaveBeenCalledTimes(1);
});
```

Also cover a no-op repeated `updateAnswer("same text")` update after the first send.

- [ ] **Step 2: Run controller tests and confirm they fail**

Run:

```bash
pnpm exec vitest run tests/unit/card-draft-controller.test.ts
```

Expected:

- FAIL because the controller currently queues stream updates whenever the rendered timeline is non-empty, even if content did not change

- [ ] **Step 3: Implement rendered-content dedupe inside `queueRender()`**

Keep strategy logic out of the controller and add only a rendering-level guard:

```ts
let lastQueuedContent = "";

const queueRender = () => {
    const rendered = renderTimeline({ compactProcessAnswerSpacing: true });
    if (!rendered || rendered === lastSentContent || rendered === lastQueuedContent) {
        if (!rendered) {
            loop.resetPending();
        }
        return;
    }
    lastQueuedContent = rendered;
    loop.update(rendered);
};
```

Implementation requirements:

- clear any local queued-content marker when a send completes and `lastSentContent` advances
- do not break `flush()`, `waitForInFlight()`, or `stop()`
- keep the controller API unchanged

- [ ] **Step 4: Run controller tests again and confirm they pass**

Run:

```bash
pnpm exec vitest run tests/unit/card-draft-controller.test.ts
```

Expected:

- PASS for existing timeline tests and the new dedupe coverage

- [ ] **Step 5: Commit the controller dedupe change**

```bash
git add src/card-draft-controller.ts tests/unit/card-draft-controller.test.ts
git commit -m "perf(card): skip duplicate timeline stream updates"
```

## Task 3: Refactor Card Reply Strategy Around Mode Policy and Event Normalization

**Files:**
- Modify: `src/reply-strategy-card.ts`
- Test: `tests/unit/reply-strategy-card.test.ts`

- [ ] **Step 1: Write failing strategy tests for `off | answer | all` mode semantics**

Add or update tests for:

- `cardStreamingMode="off"`:
  - `onPartialReply` does not live-stream answer text
  - reasoning snapshots only appear after a boundary/final flush
- `cardStreamingMode="answer"`:
  - `onPartialReply` streams answer snapshots
  - `onReasoningStream` still buffers reasoning until a sealed block/boundary
- `cardStreamingMode="all"`:
  - both answer partials and reasoning snapshots stream live
  - sealed thinking boundaries do not emit duplicate card content if nothing changed
- legacy fallback:
  - `cardRealTimeStream=true` and no explicit `cardStreamingMode` behaves like `all`
  - explicit `cardStreamingMode` wins over `cardRealTimeStream`

- [ ] **Step 2: Run strategy tests and confirm they fail**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts
```

Expected:

- FAIL because `reply-strategy-card.ts` still branches on `cardRealTimeStream` and `cardStreamReasoning`

- [ ] **Step 3: Implement the mode-driven event policy in `reply-strategy-card.ts`**

Refactor the strategy toward this shape:

```ts
type CardReplyLifecycleState = "open" | "final_seen" | "sealed";

const { mode, usedDeprecatedCardRealTimeStream } = resolveCardStreamingMode(config);
const streamAnswerLive = mode === "answer" || mode === "all";
const streamThinkingLive = mode === "all";
let lifecycleState: CardReplyLifecycleState = "open";

const shouldAcceptAnswerSnapshot = () => lifecycleState === "open";
```

Implementation requirements:

- create the controller with `throttleMs: config.cardStreamInterval ?? 1000`
- emit the deprecated `cardRealTimeStream` warning once if the helper reports legacy fallback usage
- keep `disableBlockStreaming` behavior unchanged
- map all upstream callbacks/deliveries through small local helpers that first normalize think/tool/answer semantics, then apply the mode policy
- in `off/answer`, route reasoning snapshots through the assembler and only append sealed thinking blocks
- in `all`, allow live `updateReasoning()` snapshots and call `sealActiveThinking()` at boundaries
- keep the existing conservative local split fallback for mixed block/final text

- [ ] **Step 4: Run strategy tests again and confirm they pass**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts
```

Expected:

- PASS for mode semantics, legacy fallback, and existing card strategy behavior

- [ ] **Step 5: Commit the mode-driven strategy refactor**

```bash
git add src/reply-strategy-card.ts tests/unit/reply-strategy-card.test.ts
git commit -m "refactor(card): drive card replies with cardStreamingMode"
```

## Task 4: Lock `final_seen` Late-Process Behavior and Freeze Late Answer Updates

**Files:**
- Modify: `src/reply-strategy-card.ts`
- Test: `tests/unit/reply-strategy-card.test.ts`
- Test: `tests/unit/inbound-handler.test.ts`

- [ ] **Step 1: Write failing unit and integration tests for late events after `final`**

Add unit coverage for:

```ts
it("keeps late tool and reasoning events after final but ignores late answer text", async () => {
    const card = makeCard();
    const strategy = createCardReplyStrategy(buildCtx(card, {
        config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "answer" } as any,
        disableBlockStreaming: false,
    }));

    await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "final" });
    await strategy.deliver({ text: "Reasoning:\n_Reason: late think_", mediaUrls: [], kind: "block" });
    await strategy.deliver({ text: "late tool", mediaUrls: [], kind: "tool" });
    await strategy.deliver({ text: "不应覆盖", mediaUrls: [], kind: "block" });
    await strategy.finalize();

    const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
    expect(rendered).toContain("> Reason: late think");
    expect(rendered).toContain("> late tool");
    expect(rendered).toContain("最终答案");
    expect(rendered).not.toContain("不应覆盖");
});
```

Add `tests/unit/inbound-handler.test.ts` coverage for a card-mode reply where the runtime dispatch path emits `final` before a late reasoning/tool event and the final card still includes those late process blocks.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts tests/unit/inbound-handler.test.ts
```

Expected:

- FAIL because late answer text is still accepted after `final`
- FAIL if post-final lifecycle handling is not explicitly modeled yet

- [ ] **Step 3: Implement the `open -> final_seen -> sealed` lifecycle rules**

Apply these rules in `src/reply-strategy-card.ts`:

- on the first `deliver(kind="final")`, set lifecycle state to `final_seen`
- while `final_seen`:
  - accept late reasoning snapshots and sealed thinking/tool blocks
  - reject any late answer snapshots from `onPartialReply` or split block/final text
- after a successful `finishAICard(...)`, set lifecycle state to `sealed`
- while `sealed`, ignore all incoming callbacks/deliveries

Implementation notes:

- keep late process acceptance because upstream may emit `final` before the reasoning/tool tail is fully flushed
- do not treat repeated `deliver(kind="final")` as an error; preserve the first final answer and ignore later answer mutations
- retain file/media delivery behavior for `kind="final"` media payloads

- [ ] **Step 4: Run focused tests again and confirm they pass**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts tests/unit/inbound-handler.test.ts
```

Expected:

- PASS for late process preservation and late answer freeze

- [ ] **Step 5: Commit the lifecycle hardening**

```bash
git add src/reply-strategy-card.ts tests/unit/reply-strategy-card.test.ts tests/unit/inbound-handler.test.ts
git commit -m "fix(card): preserve late process events after final"
```

## Task 5: Update User Docs and Run Full Regression

**Files:**
- Modify: `docs/user/features/ai-card.md`
- Modify: `docs/user/reference/configuration.md`
- Modify: `docs/user/reference/api-usage-and-cost.md`

- [ ] **Step 1: Update user-facing docs for the new streaming enum**

Document the new config and legacy fallback behavior:

```json5
{
  "channels": {
    "dingtalk": {
      "messageType": "card",
      "cardStreamingMode": "answer",
      "cardStreamInterval": 1000
    }
  }
}
```

Docs requirements:

- replace “两种流式策略” with a three-mode table for `off | answer | all`
- explain that `cardRealTimeStream` is deprecated and only kept as a compatibility fallback to `all`
- explain that `cardStreamInterval` controls live updates in `answer/all`
- update API-cost recommendations to use `cardStreamingMode`

- [ ] **Step 2: Run docs and full-code verification**

Run:

```bash
pnpm exec vitest run tests/unit/card-streaming-mode.test.ts tests/unit/config-schema.test.ts tests/unit/config-advanced.test.ts tests/unit/types.test.ts tests/unit/card-draft-controller.test.ts tests/unit/reply-strategy-card.test.ts tests/unit/inbound-handler.test.ts
npm run lint
npm run type-check
pnpm test
```

Expected:

- PASS for all targeted unit/integration tests
- lint/type-check succeed
- full Vitest suite passes

- [ ] **Step 3: Commit docs and final regression updates**

```bash
git add docs/user/features/ai-card.md docs/user/reference/configuration.md docs/user/reference/api-usage-and-cost.md
git commit -m "docs(card): document cardStreamingMode"
```

- [ ] **Step 4: Re-check final branch status**

Run:

```bash
git status --short
git log --oneline -8
```

Expected:

- only intentional tracked changes remain
- recent commits clearly separate config, controller, strategy, lifecycle, and docs work
