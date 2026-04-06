# Card V2 Rebase PR #494 — Handoff Document

**Date:** 2026-04-06
**Branch:** `card-template-v2-clean`
**Base commit:** `f32bb40` on `card-template-v2-clean`

## Summary

Task 1-3（代码修复）已完成，Task 4（rebase PR #494）进行中，遇到 8 文件冲突，已解决 4 个，剩余 4 个待继续。

---

## Completed Tasks

### Task 1: quoteContent 语义修复 ✅

**Commit:** `9846d64` fix(card): quoteContent always shows inbound message text

**Changes:**
- `src/inbound-handler.ts` — quoteContent 改为 `extractedContent.text.trim().slice(0, 200)`，hasQuote 改为 `inboundQuoteText.length > 0`
- `src/reply-strategy.ts` — ReplyStrategyContext 增加 `inboundText?: string`
- `src/reply-strategy-card.ts` — finalize 中从 ctx.inboundText 构建 quoteContent 传给 commitAICardBlocks
- 测试：inbound-handler + reply-strategy-card 各新增测试

**Review status:**
- Spec review ✅ — 所有 6 项要求满足
- Code quality ✅ — 1 个 Important: sub-agent context hint 泾漏到 quoteContent（超出计划范围，记录为已知限制）

### Task 2: taskInfo 补传 ✅

**Commit:** `c5f9272` feat(card): pass taskInfo to finalize for model/usage/elapsed display

**Changes:**
- `src/reply-strategy.ts` — 新增 TaskMeta interface，ReplyStrategyContext 增加 `taskMeta?: TaskMeta`
- `src/reply-strategy-card.ts` — finalize 中构建 taskInfoJson 并传给 commitAICardBlocks
- 测试：reply-strategy-card 新增 2 个测试（with/without taskMeta）

**Review status:**
- Spec review ✅
- Code quality：跳过（改动 65 行，清晰简洁）

### Task 3: mediaId 桥接 ✅

**Commit:** `fcbf4e1` feat(card): bridge sendMedia mediaId to active card via run registry (+ `f32bb40` style fix)

**Changes:**
- `src/card/card-run-registry.ts` — 新增 resolveCardRunByConversation(accountId, cid)，registerCardRun 增加 registeredAt 参数
- `src/send-service.ts` — sendProactiveMedia 返回值增加 mediaId
- `src/channel.ts` — sendMedia 成功后桥接到活跃卡片 appendImageBlock
- `tests/unit/card-run-registry.test.ts` — 新建，4 个测试

**Review status:**
- Spec review ✅
- Code quality ✅ — 1 个 Important: curly lint（已修复），1 个 Important: 缺少 channel.ts bridge 雛成测试（建议后续补）

---

## In-Progress: Task 4 — Rebase PR #494

### Background

PR #494 (`d268a2e`) 引入了：
- `cardStreamingMode: off | answer | all` 配置替代 `cardRealTimeStream` 布尔值
- `open → final_seen → sealed` 生命周期状态机
- `CardDraftController` 去重追踪 (`lastQueuedContent` / `inFlightContent`)
- `appendToolBeforeCurrentAnswer` — late tool 排序
- `sealActiveThinking` — 显式 seal thinking
- `splitCardReasoningAnswerText` — 混合 reasoning+answer 文本拆分

main 同时包含 PR #495（rollback card v2）和 PR #496（docs CI）。

### Rebase Approach

采用 squash + rebase（19 commits → 1 squash commit），减少冲突解决轮次。

### Conflict Analysis

8 个冲突文件，已解决 4 个：

| File | Strategy | Status |
|------|----------|--------|
| `docs/assets/card-data-mock-v2.json` | take ours | ✅ Done |
| `src/reply-strategy.ts` | combine（TaskMeta + InternalReplyStrategyConfig） | ✅ Done |
| `src/card-service.ts` | take ours（commitAICardBlocks） | ✅ Done |
| `src/card-draft-controller.ts` | **combine** — ✅ Done（手写合并版） |

4 个未解决：

| File | Strategy | Complexity | Notes |
|------|----------|-----------|-------|
| `src/reply-strategy-card.ts` | **combine** | **最高** | PR#494 生命周期 + cardStreamingMode + 我们的 commitAICardBlocks + image + quoteContent + taskInfo |
| `tests/unit/card-draft-controller.test.ts` | combine | 高 | 10 个冲突，需适配新接口 |
| `tests/unit/inbound-handler.test.ts` | combine | 低 | 1 个冲突 |
| `tests/unit/reply-strategy-card.test.ts` | adapt | 中 | 无冲突标记，但需适配新接口 |

### card-draft-controller.ts 合并详情（已完成）

合并了两边的改动：

**来自 PR#494:**
- `appendToolBeforeCurrentAnswer` — late tool 插入到当前 answer 前
- `findLastAnswerEntryIndex` — 辅助方法
- `updateAnswer(text, { stream?: boolean })` — stream:false 静默捕获
- `sealActiveThinking` — 显式 seal thinking
- 去重追踪: `lastQueuedContent` / `inFlightContent` / `clearPendingRender`
- Transport: `streamAICard`（markdown streaming API）

**来自我们:**
- `image` timeline entry kind + `appendImageBlock` — 图片块支持
- `discardCurrentAnswer` — 丢弃当前 answer draft
- `notifyNewAssistantTurn({ discardActiveAnswer })` — 支持丢弃参数
- CardBlock[] 渲染 (`renderTimelineAsBlocks`) 替代 markdown
- `getRenderedBlocks` + `getRenderedContent` 双输出
- 实时流式: `streamContentToCard` / `clearStreamingContentFromCard`
- Transport: `updateAICardBlockList`（instances API）

### reply-strategy-card.ts 合并策略（待执行）

这是最关键的文件。策略是**从 PR#494 的版本出发，补入我们的 V2 特性**：

**保留 PR#494 的骨架（控制流）:**
1. `CardReplyLifecycleState` 类型 (`"open" | "final_seen" | "sealed"`)
2. `resolveCardStreamingMode()` — cardStreamingMode 配置解析
3. `shouldWarnDeprecatedCardRealTimeStreamOnce()` — 弃用警告
4. `splitCardReasoningAnswerText()` — 混合文本拆分
5. `lifecycleState` 状态转换: deliver(final) → "final_seen", finalize() → "sealed", abort() → "sealed"
6. Mode-aware routing: `streamAnswerLive` / `streamThinkingLive` from config
7. Late tool handling: `deliver(tool)` + `lifecycleState === "final_seen"` → `appendToolBeforeCurrentAnswer`
8. `handleAnswerSnapshot()` — lifecycle-aware answer 更新
9. `applySplitTextToTimeline()` — 文本拆分 + mode-aware routing
10. `normalizeDeliveredText()` / `applyDeliveredContent()` — text routing helpers

**补入我们的 V2 特性（行为层）:**
1. `commitAICardBlocks` finalize（替代 `finishAICard`）— 使用 `getRenderedBlocks` 生成 blockListJson
2. inline media upload — `prepareMediaInput` + `uploadMedia` → `controller.appendImageBlock`
3. `discardCurrentAnswerDraft` — 部分答案丢弃逻辑
4. `quoteContent` 从 `ctx.inboundText` 构建
5. `taskInfoJson` 从 `ctx.taskMeta` 构建
6. `attachCardRunController` — 注册 controller 到 run registry

**需要导入的新模块:**
- `./card/reasoning-answer-split` — PR#494 新增
- `./card/card-streaming-mode` — PR#494 新增

**需要替换的调用:**
- `finishAICard(card, content, log, ...)` → `commitAICardBlocks(card, { blockListJson, content, ... }, log)`
- `ctx.deliverMedia(urls)` → inline `prepareMediaInput` + `uploadMedia` + `controller.appendImageBlock`

### 测试文件适配

**card-draft-controller.test.ts（10 个冲突）:**
- Controller 接口变了（多了 appendToolBeforeCurrentAnswer, appendImageBlock, discardCurrentAnswer 等）
- 需要适配 mock controller 对象
- 渲染方法名从 `renderTimeline` 改为 `renderTimelineAsBlocks`

**inbound-handler.test.ts（1 个冲突）:**
- 可能是 `createAICard` 参数冲突（新增 `inboundText` 传给 strategy context）

**reply-strategy-card.test.ts（无冲突标记）:**
- 需要更新 mock 导入（`commitAICardBlocks` 替代 `finishAICard`）
- 新增 `card-streaming-mode` 和 `reasoning-answer-split` 的 mock
- 新增 lifecycle state 相关测试

---

## Rebase 操作步骤

1. `git fetch origin main`
2. 软重置到 merge-base: `git reset --soft $(git merge-base HEAD origin/main)`
3. 创建 squash commit
4. `git rebase origin/main`
5. 解决冲突（按上述策略）
6. `pnpm test && pnpm run type-check`
7. 真机验证

---

## PR#494 新增文件（需在合并后可用）

| File | Action | Purpose |
|------|--------|---------|
| `src/card/card-streaming-mode.ts` | TAKE THEIRS | resolveCardStreamingMode() + deprecation warning |
| `src/card/reasoning-answer-split.ts` | TAKE THEIRS | splitCardReasoningAnswerText() |

---

## Known Issues / Future Work

1. **Sub-agent context hint 泄漏:** `extractedContent.text` 在 sub-agent 模式下被注入 `[你被 @ 为"AgentName"]` 前缀，会泄漏到 quoteContent。需在 inbound-handler 中 capture 原始文本后再注入前缀。
2. **channel.ts bridge 集成测试缺失:** sendMedia → card bridge 路径没有 channel 级别的集成测试，只有 registry 单元测试。
3. **resolveCardRunByConversation 假阳性风险:** substring 匹配在极端情况下可能误匹配（DingTalk base64 conversationId 在实践中使这不太可能）。
4. **cardStreamingMode 与 cardRealTimeStream 兼容:** 合并后 `reply-strategy-card.ts` 需要使用 PR#494 的 `resolveCardStreamingMode()` 替代直接读取 `config.cardRealTimeStream`。
