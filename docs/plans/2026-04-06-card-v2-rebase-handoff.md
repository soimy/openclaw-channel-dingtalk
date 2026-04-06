# Card V2 Rebase PR #494 — Handoff Document

**Date:** 2026-04-06
**Branch:** `card-template-v2-clean`
**Rebase commit:** `c161e6e` (squash of 21 V2 commits, rebased onto origin/main)

## Summary

Rebase 已完成，type-check 已通过。剩余 21 个测试失败需要修复，根因已定位。

---

## Current State

### ✅ Done

- Rebase 完成：`git rebase origin/main` 成功，19 files changed, +1890/-960
- Type-check 通过：`pnpm run type-check` clean
- `src/card/card-template.ts` 修复：`DingTalkCardTemplateContract` 接口增加 `streamingKey` + `blockListKey`
- `tests/unit/card-draft-controller.test.ts` 修复：line 719 缺少 `});` 关闭 `it()` block
- card-draft-controller.test.ts 全部通过（72 tests pass）

### ❌ Remaining: 21 Test Failures

| File | Failures | Root Cause |
|------|----------|------------|
| `tests/unit/inbound-handler.test.ts` | 20 | **card-service mock 缺少 3 个导出** |
| `tests/unit/reply-strategy-card.test.ts` | 1 | `deliver(block, isReasoning:true)` 在 block streaming 关闭时未路由到 controller |

---

## Fix 1: inbound-handler.test.ts — 20 failures

**Root cause:** `card-draft-controller.ts` imports `updateAICardBlockList`, `streamAICardContent`, `clearAICardStreamingContent` from `card-service`。但 inbound-handler.test.ts 的 card-service mock（lines 72-79）只提供了：

```typescript
vi.mock("../../src/card-service", () => ({
  createAICard: shared.createAICardMock,
  finishAICard: shared.finishAICardMock,
  commitAICardBlocks: shared.commitAICardBlocksMock,
  formatContentForCard: shared.formatContentForCardMock,
  isCardInTerminalState: shared.isCardInTerminalStateMock,
  streamAICard: shared.streamAICardMock,
  // ⚠️ MISSING: updateAICardBlockList, streamAICardContent, clearAICardStreamingContent
}));
```

当 `card-draft-controller` 调用 `updateAICardBlockList` 时得到 `undefined`，抛异常，card 进入 FAILED 状态，导致 `commitAICardBlocks` 永远不会被调用。

**Fix:** 在 card-service mock 中补上缺失的导出。需要：
1. 在 `vi.hoisted` shared 对象中新增 `updateAICardBlockListMock`、`streamAICardContentMock`、`clearAICardStreamingContentMock`
2. 在 `vi.mock("../../src/card-service", ...)` factory 中加入这三个 mock
3. 在 `beforeEach` 中 reset 这些 mock
4. line 1586 的 `shared.updateAICardBlockListMock` 应该能正常工作（目前引用 undefined mock 但 `toHaveBeenCalled()` 在 undefined 上不报错，只是永远 false）

**Mock 补充参考（reply-strategy-card.test.ts 的写法）：**
```typescript
// shared 对象新增:
updateAICardBlockListMock: vi.fn(),
streamAICardContentMock: vi.fn(),
clearAICardStreamingContentMock: vi.fn(),

// card-service mock factory 新增:
updateAICardBlockList: shared.updateAICardBlockListMock,
streamAICardContent: shared.streamAICardContentMock,
clearAICardStreamingContent: shared.clearAICardStreamingContentMock,

// beforeEach 新增:
shared.updateAICardBlockListMock.mockReset().mockResolvedValue(undefined);
shared.streamAICardContentMock.mockReset().mockResolvedValue(undefined);
shared.clearAICardStreamingContentMock.mockReset().mockResolvedValue(undefined);
```

另外，`createAICardMock` 返回的 card 对象（line 229-233）可能需要更多字段。当前返回：
```typescript
{ cardInstanceId: "card_1", state: "1", lastUpdated: Date.now() }
```
如果 `reply-strategy-card.ts` 在 deliver/finalize 中检查 `card.state` 为 `AICardStatus.PROCESSING`，那么 `state: "1"` 就是正确的（PROCESSING 枚举值是 "1"）。但缺少 `accessToken` 和 `conversationId` 字段可能导致某些路径失败。需要视测试结果验证。

---

## Fix 2: reply-strategy-card.test.ts — 1 failure

**Test:** `deliver(block) routes reasoning-on blocks into the card timeline`（line 355-369）

**Current behavior:** `deliver({ text: "Reasoning:\n_Reason: ..._", kind: "block", isReasoning: true })` 没有触发 `updateAICardBlockList`。

**Context:** `buildCtx(card)` 默认 `disableBlockStreaming: true`。在 PR#494 合并后的 `reply-strategy-card.ts` 中，`deliver(block)` 的路由逻辑可能已经改变：
- PR#494 引入了 `splitCardReasoningAnswerText()` 和 mode-aware routing
- 当 `disableBlockStreaming` 为 true 且无 `cardStreamingMode` 配置时，reasoning block 可能走的是"buffer locally"路径而非"stream to card"路径

**Debug approach:** 在 `reply-strategy-card.ts` 的 `deliver` 方法中，找到 `kind: "block"` 的处理分支，检查当 `isReasoning: true` 且 `disableBlockStreaming: true` 时，是否仍然调用 `controller.appendThinkingBlock()` 或类似方法。如果不是，需要修改代码或修改测试期望。

**可能的原因：** 测试期望可能是 ours 版本的行为（reasoning block 始终路由到 card），但 PR#494 的 mode-aware routing 在 `off` 模式（默认）下会 buffer 而非 stream。可以：
1. 在测试中加 `disableBlockStreaming: false` 使其符合 PR#494 的行为
2. 或者修改代码使 `isReasoning: true` 的 block 始终路由到 card（即使 block streaming 关闭）

---

## Unstaged Changes (working tree)

```
 src/card/card-template.ts                | 7 +++++++
 tests/unit/card-draft-controller.test.ts | 1 +
 2 files changed, 8 insertions(+)
```

这两个修复尚未 commit。修复完测试后应一并 `git add -A && git commit --amend --no-edit`。

---

## Completed Tasks (archived)

### Task 1: quoteContent 语义修复 ✅
**Commit:** `9846d64` fix(card): quoteContent always shows inbound message text

### Task 2: taskInfo 补传 ✅
**Commit:** `c5f9272` feat(card): pass taskInfo to finalize for model/usage/elapsed display

### Task 3: mediaId 桥接 ✅
**Commit:** `fcbf4e1` feat(card): bridge sendMedia mediaId to active card via run registry (+ `f32bb40` style fix)

### Task 4: Rebase PR #494 ✅ (rebase complete, test fixes pending)

**Rebase steps completed:**
1. `git fetch origin main` ✅
2. Squash 21 commits → 1 ✅
3. `git rebase origin/main` ✅ (8 conflict files resolved)
4. `src/card/card-template.ts` type fix ✅
5. `tests/unit/card-draft-controller.test.ts` brace fix ✅
6. Fix remaining 21 test failures ⬅️ **HERE**

---

## Conflict Resolution Details

8 个冲突文件，全部已解决：

| File | Strategy | Status |
|------|----------|--------|
| `docs/assets/card-data-mock-v2.json` | take ours | ✅ |
| `src/reply-strategy.ts` | combine (TaskMeta + InternalReplyStrategyConfig) | ✅ |
| `src/card-service.ts` | take ours (commitAICardBlocks) | ✅ |
| `src/card-draft-controller.ts` | hand-merge (PR#494 dedup + V2 block rendering) | ✅ |
| `src/reply-strategy-card.ts` | combine (PR#494 lifecycle + V2 APIs) | ✅ |
| `tests/unit/card-draft-controller.test.ts` | combine (brace fix applied) | ✅ |
| `tests/unit/inbound-handler.test.ts` | combine | ✅ (mock 补全 pending) |
| `tests/unit/reply-strategy-card.test.ts` | adapt | ✅ (1 test pending) |

---

## Known Issues / Future Work

1. **Sub-agent context hint 泄漏:** `extractedContent.text` 在 sub-agent 模式下被注入 `[你被 @ 为"AgentName"]` 前缀，会泄漏到 quoteContent。需在 inbound-handler 中 capture 原始文本后再注入前缀。
2. **channel.ts bridge 集成测试缺失:** sendMedia → card bridge 路径没有 channel 级别的集成测试。
3. **resolveCardRunByConversation 假阳性风险:** substring 匹配在极端情况下可能误匹配。
4. **tsconfig `.at()` warnings:** `es2022` target needed for `.at()` on arrays — pre-existing, not from merge。
5. **CardBlock type union:** `Property 'markdown' does not exist on type '{ type: 3; mediaId: string }'` — pre-existing, tests use `as any` workaround in `getBlockText` helper。
