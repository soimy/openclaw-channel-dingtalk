# Card V2 Rebase PR #494 — Handoff Document

**Date:** 2026-04-06
**Branch:** `card-template-v2-clean`
**Rebase commit:** `c161e6e` (squash of 21 V2 commits, rebased onto origin/main)
**Fix commit:** `076cbb1` fix(test): repair 21 test failures after PR#494 rebase

## Summary

Rebase 已完成，type-check 和所有 870 个测试均已通过。

---

## Current State

### ✅ All Done

- Rebase 完成：`git rebase origin/main` 成功，19 files changed, +1890/-960
- Type-check 通过：`pnpm run type-check` clean
- `src/card/card-template.ts` 修复：`DingTalkCardTemplateContract` 接口增加 `streamingKey` + `blockListKey`
- `tests/unit/card-draft-controller.test.ts` 修复：line 719 缺少 `});` 关闭 `it()` block
- card-draft-controller.test.ts 全部通过（72 tests pass）
- inbound-handler.test.ts 全部通过（156 tests pass）
- reply-strategy-card.test.ts 全部通过（46 tests pass）
- **全量测试通过：870 tests pass**

### ✅ Test Fixes Applied

| Issue | Root Cause | Fix |
|-------|------------|-----|
| 20 test failures in inbound-handler.test.ts | card-service mock 缺少 3 个导出 | 补充 `updateAICardBlockList`, `streamAICardContent`, `clearAICardStreamingContent` mocks |
| V2 finalize path mismatch | 测试期望 `finishAICard` 但实现使用 `commitAICardBlocks` | 更新测试期望为 `commitAICardBlocksMock` |
| Reasoning streaming assertions | 测试期望 `streamAICard` 但实现使用 `updateAICardBlockList` | 更新断言匹配 `cardStreamingMode` 行为 |

---

## Key Changes in PR#494

### cardStreamingMode 模式系统

PR#494 引入了 `cardStreamingMode` 配置项替代旧的 `cardRealTimeStream`：

| Mode | Reasoning | Answer | 说明 |
|------|-----------|--------|------|
| `off` | buffer | buffer | 完全缓冲，finalize 时一次性提交 |
| `answer` | buffer | stream | 答案实时流式，推理缓冲 |
| `all` | stream | stream | 全部实时流式 |

### V2 Template finalize 路径

- **旧版**：`finishAICard(card, content, ...)` — 单次 content 提交
- **V2**：`commitAICardBlocks(card, { blockListJson, content }, ...)` — block-based 渲染

### Block Timeline 更新

- `updateAICardBlockList(card, blockListJson)` 用于更新 block timeline
- `streamAICard` 现在仅用于 finalize 时的最终 content 提交（内部调用）

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
| `tests/unit/inbound-handler.test.ts` | combine + mock fix | ✅ |
| `tests/unit/reply-strategy-card.test.ts` | adapt | ✅ |

---

## Known Issues / Future Work

1. **Sub-agent context hint 泄漏:** `extractedContent.text` 在 sub-agent 模式下被注入 `[你被 @ 为"AgentName"]` 前缀，会泄漏到 quoteContent。需在 inbound-handler 中 capture 原始文本后再注入前缀。
2. **channel.ts bridge 集成测试缺失:** sendMedia → card bridge 路径没有 channel 级别的集成测试。
3. **resolveCardRunByConversation 假阳性风险:** substring 匹配在极端情况下可能误匹配。
4. **tsconfig `.at()` warnings:** `es2022` target needed for `.at()` on arrays — pre-existing, not from merge。
5. **CardBlock type union:** `Property 'markdown' does not exist on type '{ type: 3; mediaId: string }'` — pre-existing, tests use `as any` workaround in `getBlockText` helper。

---

## Test File Split (Deferred)

`tests/unit/inbound-handler.test.ts` (7772 行) 拆分工作已评估，但由于 Vitest `vi.hoisted()` 无法跨文件导出的限制，需要采用更复杂的模式。当前所有测试已通过，拆分可作为后续优化任务。

---

## Completed Tasks (archived)

### Task 1: quoteContent 语义修复 ✅
**Commit:** `9846d64` fix(card): quoteContent always shows inbound message text

### Task 2: taskInfo 补传 ✅
**Commit:** `c5f9272` feat(card): pass taskInfo to finalize for model/usage/elapsed display

### Task 3: mediaId 桥接 ✅
**Commit:** `fcbf4e1` feat(card): bridge sendMedia mediaId to active card via run registry (+ `f32bb40` style fix)

### Task 4: Rebase PR #494 ✅
**Commit:** `076cbb1` fix(test): repair 21 test failures after PR#494 rebase

**Rebase steps completed:**
1. `git fetch origin main` ✅
2. Squash 21 commits → 1 ✅
3. `git rebase origin/main` ✅ (8 conflict files resolved)
4. `src/card/card-template.ts` type fix ✅
5. `tests/unit/card-draft-controller.test.ts` brace fix ✅
6. Fix 21 test failures ✅
7. All 870 tests pass ✅
8. Push to origin ✅