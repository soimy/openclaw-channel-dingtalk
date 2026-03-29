# DingTalk Markdown Incremental Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DingTalk markdown mode send `thinking / tool / answer` as incremental message segments while keeping `final` answer delivery non-duplicative and leaving all card modules untouched.

**Architecture:** Keep the existing `sendMessage(..., { sessionWebhook })` transport exactly as-is and implement the new behavior entirely inside `src/reply-strategy-markdown.ts`. Model only the minimum markdown-local state needed to compute incremental suffixes for live `thinking` and `answer`, send each `tool` event as its own quoted block, and reset answer cursors on `onAssistantMessageStart()`.

**Tech Stack:** TypeScript, Vitest, existing DingTalk session webhook send path, `apply_patch`, `pnpm`

---

## Reference Spec

- `docs/spec/2026-03-30-dingtalk-markdown-incremental-timeline-design.md`
- `docs/plans/2026-03-29-markdown-thinking-tool-answer-order-analysis.md`

## File Map

- Modify: `src/reply-strategy-markdown.ts`
  - Register markdown-mode streaming callbacks and add the minimal incremental timeline state.
- Modify: `tests/unit/reply-strategy-markdown.test.ts`
  - Lock suffix computation, quoted process rendering, assistant-turn reset, and final-tail-only behavior.
- Modify: `tests/unit/inbound-handler.test.ts`
  - Lock markdown end-to-end behavior with runtime callbacks and verify multi-message delivery order.

## Hard Boundaries

- Do not modify `src/card-draft-controller.ts`.
- Do not modify `src/reply-strategy-card.ts`.
- Do not modify `src/card-service.ts`.
- Do not modify `src/draft-stream-loop.ts`.
- Do not change `src/send-service.ts` transport behavior unless tests prove an unavoidable compatibility gap.

## Task 1: Lock Markdown Incremental Behavior in Unit Tests

**Files:**
- Modify: `tests/unit/reply-strategy-markdown.test.ts`
- Reference: `src/reply-strategy-markdown.ts`

- [ ] **Step 1: Add failing callback registration coverage**

Extend the existing `getReplyOptions()` test so markdown strategy is expected to expose:

```ts
expect(opts.disableBlockStreaming).toBe(false);
expect(opts.onReasoningStream).toBeDefined();
expect(opts.onPartialReply).toBeDefined();
expect(opts.onAssistantMessageStart).toBeDefined();
```

Also keep the existing assertion shape readable by renaming the test to reflect incremental mode.

- [ ] **Step 2: Add failing thinking increment tests**

Add focused tests like:

```ts
it("onReasoningStream sends only the incremental thinking suffix as a quoted block", async () => {
    const strategy = createMarkdownReplyStrategy(buildCtx());
    const opts = strategy.getReplyOptions();

    await opts.onReasoningStream?.({ text: "先检查当前分支" });
    await opts.onReasoningStream?.({ text: "先检查当前分支的改动范围" });

    expect(sendMessageMock).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        "user_1",
        "> 先检查当前分支",
        expect.anything(),
    );
    expect(sendMessageMock).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        "user_1",
        "> 的改动范围",
        expect.anything(),
    );
});
```

Add a second test to lock the conservative rule:

- non-prefix rewrite sends nothing new
- empty or whitespace-only text is ignored

- [ ] **Step 3: Add failing tool and answer increment tests**

Add tests to cover:

- `deliver(kind: "tool")` sends one quoted message per tool event
- `onPartialReply` sends only the answer suffix
- `deliver(kind: "final")` sends only the unsent tail
- `deliver(kind: "final")` sends nothing when partial already sent the full answer

Example:

```ts
it("deliver(final) only sends the unsent answer tail", async () => {
    const strategy = createMarkdownReplyStrategy(buildCtx());
    const opts = strategy.getReplyOptions();

    await opts.onPartialReply?.({ text: "结论：" });
    await opts.onPartialReply?.({ text: "结论：主要改动在 reply strategy" });
    await strategy.deliver({ text: "结论：主要改动在 reply strategy 和测试", mediaUrls: [], kind: "final" });

    expect(sendMessageMock.mock.calls.map((call) => call[2])).toEqual([
        "结论：",
        "主要改动在 reply strategy",
        "和测试",
    ]);
});
```

- [ ] **Step 4: Add failing assistant-turn reset and media-order tests**

Add coverage for:

- `onAssistantMessageStart()` resets only the answer cursor
- next answer turn starts sending from scratch
- `deliver(final)` with `mediaUrls` still calls `deliverMedia` before text tail send

- [ ] **Step 5: Run the markdown strategy unit tests and confirm they fail**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-markdown.test.ts
```

Expected:

- FAIL because current markdown strategy still has `disableBlockStreaming=true`
- FAIL because it does not register callbacks
- FAIL because it ignores `thinking`, `tool`, and partial `answer` events

- [ ] **Step 6: Commit the test expectations**

```bash
git add tests/unit/reply-strategy-markdown.test.ts
git commit -m "test(markdown): lock incremental timeline delivery semantics"
```

## Task 2: Implement Markdown-Local Incremental Timeline State

**Files:**
- Modify: `src/reply-strategy-markdown.ts`
- Test: `tests/unit/reply-strategy-markdown.test.ts`

- [ ] **Step 1: Add minimal internal state and helpers**

Introduce markdown-local state only:

```ts
let finalText: string | undefined;
let activeThinkingText = "";
let lastSentThinkingText = "";
let activeAnswerText = "";
let lastSentAnswerText = "";
```

Add helper functions inside `src/reply-strategy-markdown.ts`:

```ts
function renderQuotedSegment(text: string): string {
    return text
        .split("\n")
        .map((line) => line.trim() ? `> ${line.trim()}` : ">")
        .join("\n");
}

function computeIncrementalSuffix(previous: string, next: string): string {
    const prev = previous || "";
    const current = next || "";
    if (!current.trim()) return "";
    if (!prev) return current;
    if (!current.startsWith(prev)) return "";
    return current.slice(prev.length).trimStart();
}
```

Do not move these helpers into shared modules for this implementation pass.

- [ ] **Step 2: Register streaming callbacks in `getReplyOptions()`**

Update markdown strategy to return:

```ts
{
    disableBlockStreaming: false,
    onReasoningStream: async ({ text }) => { ... },
    onPartialReply: async ({ text }) => { ... },
    onAssistantMessageStart: async () => { ... },
}
```

Implementation rules:

- `onReasoningStream` computes suffix from `lastSentThinkingText`
- quoted output goes through the existing `sendMessage(...)`
- successful sends update `lastSentThinkingText`
- `onAssistantMessageStart` resets only answer-turn state

- [ ] **Step 3: Rework `deliver()` for tool and final semantics**

Apply these rules:

- always keep the existing `payload.mediaUrls` handling first
- `tool`:
  - ignore empty text
  - send a quoted block immediately
- `final`:
  - save `finalText`
  - compute answer tail against `lastSentAnswerText`
  - send only the unsent tail
  - send nothing if there is no new tail

Keep `getFinalText()` aligned with the latest complete final answer:

```ts
return finalText || activeAnswerText || undefined;
```

- [ ] **Step 4: Re-run the markdown strategy tests and confirm they pass**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-markdown.test.ts
```

Expected:

- PASS for all incremental thinking/tool/answer tests

- [ ] **Step 5: Commit the markdown strategy implementation**

```bash
git add src/reply-strategy-markdown.ts tests/unit/reply-strategy-markdown.test.ts
git commit -m "feat(markdown): send incremental timeline segments"
```

## Task 3: Lock End-to-End Markdown Delivery Order in Inbound Handler Tests

**Files:**
- Modify: `tests/unit/inbound-handler.test.ts`
- Reference: `src/inbound-handler.ts`
- Reference: `src/reply-strategy-markdown.ts`

- [ ] **Step 1: Add a failing end-to-end incremental markdown test**

Add a test where the mocked runtime emits:

1. `replyOptions.onReasoningStream({ text: "先检查" })`
2. `replyOptions.onReasoningStream({ text: "先检查当前改动" })`
3. `dispatcherOptions.deliver({ text: "git diff --stat" }, { kind: "tool" })`
4. `replyOptions.onPartialReply({ text: "结论：" })`
5. `replyOptions.onPartialReply({ text: "结论：主要改动集中在 markdown strategy" })`
6. `dispatcherOptions.deliver({ text: "结论：主要改动集中在 markdown strategy 和测试" }, { kind: "final" })`

Assert that `sendMessageMock` receives six user-visible sends in the expected order:

```ts
[
  "> 先检查",
  "> 当前改动",
  "> git diff --stat",
  "结论：",
  "主要改动集中在 markdown strategy",
  "和测试",
]
```

- [ ] **Step 2: Add a failing multi-turn answer reset test**

Add a test where runtime emits:

- first partial answer turn
- `onAssistantMessageStart()`
- second partial answer turn
- final for second turn

Assert that the second turn starts from scratch instead of being diffed against turn one.

- [ ] **Step 3: Add a failing mixed media + final order assertion**

Add or update a markdown-mode integration test so `deliver(final)` with both media and text still results in:

1. media send
2. text tail send

If an existing test already covers this order, tighten it to assert call ordering explicitly.

- [ ] **Step 4: Run the focused inbound handler tests and confirm they fail**

Run:

```bash
pnpm exec vitest run tests/unit/inbound-handler.test.ts -t "markdown"
```

Expected:

- FAIL because current markdown strategy only sends final text
- FAIL because partial callbacks are ignored

- [ ] **Step 5: Re-run the focused inbound handler tests after implementation**

Run:

```bash
pnpm exec vitest run tests/unit/inbound-handler.test.ts -t "markdown"
```

Expected:

- PASS for the new markdown incremental delivery scenarios

- [ ] **Step 6: Commit the inbound handler coverage**

```bash
git add tests/unit/inbound-handler.test.ts
git commit -m "test(inbound): cover markdown incremental timeline delivery"
```

## Task 4: Final Verification

**Files:**
- Verify only

- [ ] **Step 1: Run the focused verification suite**

Run:

```bash
pnpm exec vitest run tests/unit/reply-strategy-markdown.test.ts tests/unit/inbound-handler.test.ts
```

Expected:

- PASS with 0 failures in the touched markdown-related suites

- [ ] **Step 2: Run the full test suite if the focused suite passes**

Run:

```bash
pnpm test
```

Expected:

- PASS with 0 failures

If unrelated failures appear, capture them explicitly before deciding whether to proceed.

- [ ] **Step 3: Review git diff for scope control**

Run:

```bash
git diff -- src/reply-strategy-markdown.ts tests/unit/reply-strategy-markdown.test.ts tests/unit/inbound-handler.test.ts docs/spec/2026-03-30-dingtalk-markdown-incremental-timeline-design.md docs/plans/2026-03-30-dingtalk-markdown-incremental-timeline-implementation.md
```

Confirm:

- no card module changes slipped in
- no send-service transport changes slipped in unless intentionally required
- markdown-only scope is preserved

- [ ] **Step 4: Create the final implementation commit**

```bash
git add src/reply-strategy-markdown.ts tests/unit/reply-strategy-markdown.test.ts tests/unit/inbound-handler.test.ts docs/spec/2026-03-30-dingtalk-markdown-incremental-timeline-design.md docs/plans/2026-03-30-dingtalk-markdown-incremental-timeline-implementation.md
git commit -m "feat(markdown): stream incremental timeline segments"
```
