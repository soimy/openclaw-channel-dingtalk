# DingTalk Card Single Timeline Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild DingTalk AI Card display so thinking, tool, and answer content render through one single-timeline card body while keeping ackReaction as an independent outer status indicator.

**Architecture:** Keep DingTalk's existing `streamAICard(..., isFull=true)` transport and `draft-stream-loop` throttle layer, but replace the current split reasoning/tool/answer code paths with one controller that owns timeline state and full-card rendering. Let upstream session commands continue to decide whether reasoning/tool events exist, remove the plugin-local `verboseRealtimeStream` display switch, and make `cardRealTimeStream` mean transport cadence only.

**Tech Stack:** TypeScript, Vitest, DingTalk AI Card streaming API, `apply_patch`, `pnpm`

---

## Reference Spec

- `docs/spec/2026-03-27-dingtalk-card-single-timeline-display-design.md`

## File Map

- Modify: `src/card-draft-controller.ts`
  - Keep the file name for this implementation pass, but convert the internals from phase-gated preview logic into single-timeline state + rendering.
- Modify: `src/reply-strategy-card.ts`
  - Stop routing tool display through `sendMessage(... cardUpdateMode: "append")`; map all visible card events into the controller.
- Modify: `src/config-schema.ts`
  - Remove `verboseRealtimeStream` from config schema.
- Modify: `src/types.ts`
  - Remove `verboseRealtimeStream` from `DingTalkConfig`, `DingTalkChannelConfig`, and `resolveDingTalkAccount`.
- Modify: `src/send-service.ts`
  - Remove now-dead card append support once no call sites remain.
- Modify: `tests/unit/card-draft-controller.test.ts`
  - Lock the controller's timeline, rendering, and multi-turn behavior.
- Modify: `tests/unit/reply-strategy-card.test.ts`
  - Lock strategy/controller integration and confirm no append send path remains.
- Modify: `tests/unit/inbound-handler.test.ts`
  - Lock end-to-end reasoning/tool visibility semantics, file-only behavior, and ackReaction independence.
- Modify: `tests/unit/config-schema.test.ts`
  - Remove expectations for `verboseRealtimeStream`.
- Modify: `tests/unit/types.test.ts`
  - Remove or replace any assertions that mention `verboseRealtimeStream`.
- Modify: `tests/unit/send-service-card.test.ts`
  - Remove or rewrite append-path-specific tests once the branch is deleted.
- Modify: `README.md`
  - Clarify that `/reasoning stream` and `/verbose on` are session-level display toggles, `cardRealTimeStream` is transport-only, and `ackReaction` remains independent.

## Task 1: Convert the Controller Into a Timeline Renderer

**Files:**
- Modify: `src/card-draft-controller.ts`
- Test: `tests/unit/card-draft-controller.test.ts`

- [ ] **Step 1: Write the failing controller tests for timeline rendering**

Add focused tests like:

```ts
it("renders thinking and tool blocks as blockquotes while leaving answer plain", async () => {
    const ctrl = createCardDraftController({ card, throttleMs: 0 });

    ctrl.updateThinking("先检查改动");
    await vi.advanceTimersByTimeAsync(0);

    await ctrl.appendTool("git diff --stat");
    await vi.advanceTimersByTimeAsync(0);

    ctrl.updateAnswer("这里是最终回复");
    await vi.advanceTimersByTimeAsync(0);

    const rendered = ctrl.getRenderedContent();
    expect(rendered).toContain("🤔 思考");
    expect(rendered).toContain("> 先检查改动");
    expect(rendered).toContain("🛠 工具");
    expect(rendered).toContain("> git diff --stat");
    expect(rendered).toContain("这里是最终回复");
    expect(rendered).not.toContain("> 这里是最终回复");
});
```

Also add coverage for:

- repeated thinking updates replace the live thinking block
- each tool result becomes a new process block
- `startAssistantTurn()` preserves earlier answer text and starts a new turn
- `getFinalAnswerContent()` returns answer-only text

- [ ] **Step 2: Run the focused controller tests and confirm they fail**

Run:

```bash
pnpm exec vitest run tests/unit/card-draft-controller.test.ts
```

Expected:

- FAIL because the current controller still models `idle -> reasoning -> answer`
- FAIL because `appendTool`, `getRenderedContent`, or answer-turn accumulation do not exist yet

- [ ] **Step 3: Implement the minimal timeline state machine in the controller**

Refactor `src/card-draft-controller.ts` toward this shape:

```ts
type ProcessBlock = { kind: "thinking" | "tool"; text: string };

let processBlocks: ProcessBlock[] = [];
let liveThinkingText = "";
let answerTurns: string[] = [];
let currentAnswerTurn = "";
let renderedContent = "";

function render(): string {
    const parts: string[] = [];
    // render sealed process blocks
    // render live thinking block
    // render accumulated answer turns without blockquotes
    return parts.filter(Boolean).join("\n\n");
}
```

Implementation requirements:

- rename `updateReasoning` to `updateThinking` only if that keeps the public API readable, otherwise keep `updateReasoning` and add an alias later in `reply-strategy-card.ts`
- seal live thinking into `processBlocks` when tool or answer arrives
- render process blocks with markdown quote lines (`> `)
- keep `draft-stream-loop` as the only throttle / single-flight mechanism
- expose `getRenderedContent()` and `getFinalAnswerContent()`

- [ ] **Step 4: Run the controller tests again and confirm they pass**

Run:

```bash
pnpm exec vitest run tests/unit/card-draft-controller.test.ts
```

Expected:

- PASS for all controller timeline tests

- [ ] **Step 5: Commit the controller refactor**

```bash
git add src/card-draft-controller.ts tests/unit/card-draft-controller.test.ts
git commit -m "refactor: model card display as a single timeline"
```

## Task 2: Rewire Card Reply Strategy and Remove `verboseRealtimeStream`

**Files:**
- Modify: `src/reply-strategy-card.ts`
- Modify: `src/config-schema.ts`
- Modify: `src/types.ts`
- Test: `tests/unit/reply-strategy-card.test.ts`
- Test: `tests/unit/config-schema.test.ts`
- Test: `tests/unit/types.test.ts`

- [ ] **Step 1: Write the failing strategy and config tests**

Add or update tests to assert:

```ts
it("deliver(tool) appends to the controller instead of sendMessage append mode", async () => {
    const card = makeCard();
    const strategy = createCardReplyStrategy(buildCtx(card));

    await strategy.deliver({ text: "tool output", mediaUrls: [], kind: "tool" });

    expect(sendMessageMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ cardUpdateMode: "append" }),
    );
});
```

Add schema/type assertions that:

- `verboseRealtimeStream` is no longer in the parsed config shape
- account resolution no longer copies `verboseRealtimeStream`

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts tests/unit/config-schema.test.ts tests/unit/types.test.ts
```

Expected:

- FAIL because `reply-strategy-card.ts` still uses `sendMessage(... cardUpdateMode: "append")`
- FAIL because config/types still mention `verboseRealtimeStream`

- [ ] **Step 3: Implement the strategy rewiring and config cleanup**

Apply these changes:

- in `src/reply-strategy-card.ts`
  - remove `verboseMode: config.verboseRealtimeStream`
  - map `onReasoningStream` -> controller thinking update
  - map `deliver(kind: "tool")` -> controller tool append
  - keep `onPartialReply` gated by `cardRealTimeStream`
- in `src/config-schema.ts`
  - delete `verboseRealtimeStream`
- in `src/types.ts`
  - delete the field from config interfaces and resolver wiring

The strategy should now have one visible card path:

```ts
onReasoningStream: (payload) => payload.text && controller.updateThinking(payload.text)
onPartialReply: config.cardRealTimeStream ? (payload) => payload.text && controller.updateAnswer(payload.text) : undefined
deliver(tool): await controller.appendTool(text)
```

- [ ] **Step 4: Run the focused tests again and confirm they pass**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts tests/unit/config-schema.test.ts tests/unit/types.test.ts
```

Expected:

- PASS for strategy and config cleanup coverage

- [ ] **Step 5: Commit the strategy/config changes**

```bash
git add src/reply-strategy-card.ts src/config-schema.ts src/types.ts tests/unit/reply-strategy-card.test.ts tests/unit/config-schema.test.ts tests/unit/types.test.ts
git commit -m "refactor: route card reasoning and tool events through one timeline"
```

## Task 3: Finalize and Fallback With the Rendered Timeline

**Files:**
- Modify: `src/card-draft-controller.ts`
- Modify: `src/reply-strategy-card.ts`
- Test: `tests/unit/reply-strategy-card.test.ts`
- Test: `tests/unit/inbound-handler.test.ts`

- [ ] **Step 1: Write the failing finalize/fallback tests**

Add or update tests to lock:

```ts
it("finalize uses the rendered timeline instead of answer-only text", async () => {
    // reasoning -> tool -> answer
    // expect finishAICard to receive the fully rendered timeline
});

it("markdown fallback sends the rendered timeline after card failure", async () => {
    // force finishAICard/streamAICard failure
    // expect sendMessage(... forceMarkdown: true) to receive full rendered content
});

it("file-only card replies append a short plain-text answer placeholder", async () => {
    // no final answer text, only process blocks
    // expect final rendered card to include "附件已发送，请查收。"
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts tests/unit/inbound-handler.test.ts
```

Expected:

- FAIL because finalize still chooses `lastAnswerContent || finalTextForFallback || "✅ Done"`
- FAIL because markdown fallback still prefers answer-only text

- [ ] **Step 3: Implement timeline-based finalize and fallback**

Update `src/reply-strategy-card.ts` so that:

- `finalize()` asks the controller for the rendered timeline
- file-only responses inject a short answer placeholder before final rendering
- markdown fallback uses the last rendered timeline first

Suggested shape:

```ts
const finalRendered = controller.getRenderedContent({
    fallbackAnswer: finalTextForFallback || "附件已发送，请查收。",
});

await finishAICard(card, finalRendered, log, { quotedRef: ctx.replyQuotedRef });
```

Also ensure:

- answer-only helpers still exist for logs and minimal fallback logic
- media delivery still happens before card finalize

- [ ] **Step 4: Run the focused tests again and confirm they pass**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-card.test.ts tests/unit/inbound-handler.test.ts
```

Expected:

- PASS for finalize/fallback/file-only coverage

- [ ] **Step 5: Commit the finalize/fallback changes**

```bash
git add src/card-draft-controller.ts src/reply-strategy-card.ts tests/unit/reply-strategy-card.test.ts tests/unit/inbound-handler.test.ts
git commit -m "fix: finalize dingtalk cards with the full rendered timeline"
```

## Task 4: Remove the Legacy Card Append Path and Refresh User-Facing Semantics

**Files:**
- Modify: `src/send-service.ts`
- Modify: `tests/unit/send-service-card.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing cleanup tests**

Replace append-specific tests with assertions that card send-service behavior only covers:

- terminal-card fallback to session/proactive send
- no internal append-mode branch for card timeline updates

Example test direction:

```ts
it("does not expose append-mode card updates after timeline migration", async () => {
    // remove append expectations and verify normal card fallback behavior still works
});
```

- [ ] **Step 2: Run the focused cleanup tests and confirm they fail**

Run:

```bash
pnpm exec vitest run tests/unit/send-service-card.test.ts
```

Expected:

- FAIL because the file still contains card append tests or dead append logic

- [ ] **Step 3: Remove the dead append branch and update README semantics**

In `src/send-service.ts`:

- delete `options.cardUpdateMode === "append"` handling once no callers remain

In `README.md`:

- keep `/reasoning stream` and `/verbose on` as session-level switches
- clarify that `cardRealTimeStream` only changes update cadence
- clarify that `ackReaction` is independent from card-body process visibility

- [ ] **Step 4: Run the focused cleanup tests again and confirm they pass**

Run:

```bash
pnpm exec vitest run tests/unit/send-service-card.test.ts
```

Expected:

- PASS after dead-path cleanup

- [ ] **Step 5: Commit the cleanup**

```bash
git add src/send-service.ts tests/unit/send-service-card.test.ts README.md
git commit -m "refactor: remove legacy card append updates"
```

## Task 5: Regression Coverage for Visibility Gates and AckReaction Independence

**Files:**
- Modify: `tests/unit/inbound-handler.test.ts`
- Modify: `tests/unit/dynamic-ack-reaction-controller.test.ts`

- [ ] **Step 1: Add failing regression tests for event gating**

Cover these cases:

- no reasoning event emitted -> no thinking block rendered
- no tool deliver event emitted -> no tool block rendered
- tool runtime event occurs without visible tool block -> ackReaction still switches

Suggested inbound regression:

```ts
it("keeps ackReaction tool progress independent from visible tool blocks", async () => {
    // emit runtime tool-start event
    // do not call dispatcherOptions.deliver(..., { kind: "tool" })
    // expect reaction switch calls to happen anyway
});
```

- [ ] **Step 2: Run the focused regression tests and confirm they fail**

Run:

```bash
pnpm exec vitest run tests/unit/inbound-handler.test.ts tests/unit/dynamic-ack-reaction-controller.test.ts
```

Expected:

- FAIL until the new assumptions are covered and any timing issues are fixed

- [ ] **Step 3: Make the minimal glue fixes needed for the regression suite**

Fix only what the new tests expose. Typical adjustments:

- ensure visible card process blocks depend on reasoning/tool events reaching the controller
- ensure ackReaction listens only to runtime tool events and remains independent of body rendering
- tighten any timers or mocks made brittle by the controller rewrite

- [ ] **Step 4: Run the regression tests again and confirm they pass**

Run:

```bash
pnpm exec vitest run tests/unit/inbound-handler.test.ts tests/unit/dynamic-ack-reaction-controller.test.ts
```

Expected:

- PASS for visibility-gating and ackReaction-independence coverage

- [ ] **Step 5: Commit the regression coverage**

```bash
git add tests/unit/inbound-handler.test.ts tests/unit/dynamic-ack-reaction-controller.test.ts
git commit -m "test: cover card visibility gates and ack reaction independence"
```

## Task 6: Full Verification and Any Small Follow-Up Fixes

**Files:**
- Modify: any touched file if verification exposes a small follow-up fix

- [ ] **Step 1: Run lint**

Run:

```bash
npm run lint
```

Expected:

- exit code `0`

- [ ] **Step 2: Run the full test suite**

Run:

```bash
pnpm test
```

Expected:

- all unit and integration tests pass

- [ ] **Step 3: Run type-check**

Run:

```bash
npm run type-check
```

Expected:

- exit code `0`

- [ ] **Step 4: Commit any verification follow-ups**

```bash
git add .
git commit -m "test: verify dingtalk card single timeline display flow"
```
