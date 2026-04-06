# Card Template V2 Rebase PR #494 Handoff

**日期：** 2026-04-06
**分支：** card-template-v2-clean (worktree: `.worktrees/card-template-v2`)
**状态：** Task 1-3 代码修复已完成，commit 通过； Task 4 rebase 进行中，遇到冲突

---

## 已完成工作

### Task 1: quoteContent 语义修复 ✅ (commit `9846d64`)

**问题：** `quoteContent` 仅在有 `quotedRef`（被引用消息）时填充，实际语义应始终指向入站消息本身。

**改动：**
- `inbound-handler.ts`: `quoteContent = extractedContent.text.trim().slice(0, 200)` 替代旧的 `quotedRef ? quotePreview : ""`
- `reply-strategy.ts`: `ReplyStrategyContext` 新增 `inboundText?: string`
- `reply-strategy-card.ts` finalize: 从 `ctx.inboundText` 构建 `quoteContent` 传入 `commitAICardBlocks`
- 测试: 4 个新测试（非引用消息填充、finalize 阶段传入、空文本、200 字截断）

### Task 2: taskInfo 补传 ✅ (commit `c5f9272`)

**问题：** `commitAICardBlocks` 的 `FinalizeCardOptions` 已有 `taskInfoJson` 字段，但 finalize 从未传入。

**改动：**
- `reply-strategy.ts`: 新增 `TaskMeta` 接口（`model`, `effort`, `usage`, `elapsedMs`）+ `taskMeta?` 字段
- `reply-strategy-card.ts` finalize: 从 `ctx.taskMeta` 构建 `taskInfoJson`（映射 `usage→dapi_usage`, `elapsedMs→taskTime`）
- 测试: 2 个新测试（有/无 taskMeta）

### Task 3: mediaId 桥接 ✅ (commit `fcbf4e1` + `f32bb40`)

**问题：** agent 通过 `sendMedia` 发送图片时，图片独立于活跃卡片，应同时嵌入卡片。

**改动：**
- `card-run-registry.ts`: 新增 `resolveCardRunByConversation(accountId, conversationId)` — 按 accountId + conversationId（case-insensitive）查找最新注册的卡片运行
- `send-service.ts`: `sendProactiveMedia` 返回值增加 `mediaId`
- `channel.ts`: sendMedia 成功后，若为 image，查找活跃卡片并调用 `controller.appendImageBlock(mediaId)`
- 测试: 新建 `tests/unit/card-run-registry.test.ts`（4 个测试）

- 额外 commit: `f32bb40` 修复 curly lint

---

## Task 4: Rebase PR #494 — 进行中（已中止，未完成）

### PR #494 概要

PR #494 (`d268a2e`) 引入：
- `cardStreamingMode: off | answer | all` 配置替代旧 `cardRealTimeStream` 布尔值
- CardDraftController 去重（`lastQueuedContent`/`inFlightContent`）和竞态修复
- `open → final_seen → sealed` 生命周期状态机
- `splitCardReasoningAnswerText` 文本拆分 + 模式驱动流式路由
- `appendToolBeforeCurrentAnswer` 处理 final_seen 后的 late tool
- `sealActiveThinking` 显式封存 thinking entry
- 新文件: `src/card/card-streaming-mode.ts`, `src/card/reasoning-answer-split.ts`

### Rebase 冲突分析

采用 squash + rebase 策略（19 个 commit 压缩为 1 个），共有 8 个冲突文件：

| 文件 | 策略 | 状态 | 说明 |
|------|------|------|------|
| `docs/assets/card-data-mock-v2.json` | take ours | ✅ 已解决 | 新增文件，无冲突 |
| `src/reply-strategy.ts` | combine | ✅ 已解决 | 保留 PR#494 的 `InternalReplyStrategyConfig` + 我们的 `TaskMeta`/`inboundText`/`taskMeta` |
| `src/card-service.ts` | take ours | ✅ 已解决 | `commitAICardBlocks` + `updateAICardBlockList` 完全取代旧 `finishAICard` |
| `src/card-draft-controller.ts` | **手写合并** | ✅ 已解决 | 最复杂：合并两边所有改动（见下方） |
| `src/reply-strategy-card.ts` | **待合并** | ❌ 未完成 | 最关键文件（见下方） |
| `tests/unit/card-draft-controller.test.ts` | 待解决 | ❌ 10 个冲突 | 需适配新接口 |
| `tests/unit/inbound-handler.test.ts` | 待解决 | ❌ 1 个冲突 | 需适配新接口 |
| `tests/unit/reply-strategy-card.test.ts` | 待验证 | ⚠ 无冲突标记 | 但可能需要适配新接口 |

### card-draft-controller.ts 合并详情（已完成）

从 PR#494 保留：
- `appendToolBeforeCurrentAnswer` — late tool 插入当前 answer 之前
- `findLastAnswerEntryIndex` — 辅助方法
- 去重追踪： `lastQueuedContent` / `inFlightContent`
- `updateAnswer({ stream?: boolean })` — `stream: false` 静默捕获
- `sealActiveThinking` — 显式封存 thinking
- `clearPendingRender` — 重置排队内容

从我们保留：
- `CardBlock[]` JSON 渲染（`renderTimelineAsBlocks`）
- `image` timeline entry + `appendImageBlock`
- `discardCurrentAnswer` — 丢弃当前 answer draft
- `notifyNewAssistantTurn({ discardActiveAnswer })` — 支持 discard
- 实时流式： `streamContentToCard` / `clearStreamingContentFromCard`
- Transport: `updateAICardBlockList`（非 `streamAICard`）
- `getRenderedBlocks` + `getRenderedContent` 双输出

---

## 后续工作计划

### 1. 完成 reply-strategy-card.ts 合并（最高优先级）

这是整个 rebase 的核心。合并策略：**从 PR#494 的版本出发，补入我们的 V2 特性。**

从 PR#494 的版本出发是因为 PR#494 引入的生命周期状态机和 `cardStreamingMode` routing 是控制流骨架，覆盖整个 `deliver()`/`finalize()` 流程。我们的改动（`commitAICardBlocks` finalize、image blocks、quoteContent、taskInfo）是附加在骨架上的行为层。

需要在 PR#494 版本基础上补入：
- `commitAICardBlocks` finalize 路径（替代 `finishAICard`）
- inline media upload（`prepareMediaInput` → `uploadMedia` → `controller.appendImageBlock`）
- `discardCurrentAnswerDraft` 逻辑
- `quoteContent` / `taskInfoJson` 在 finalize 中构建
- `attachCardRunController` 注册
- `ctx.inboundText` / `ctx.taskMeta` 使用
- 保留 `ctx.deliverMedia()` 作为非图片媒体的 fallback

### 2. 解决测试文件冲突

- `tests/unit/card-draft-controller.test.ts` — 10 个冲突，需适配合并后的接口
- `tests/unit/inbound-handler.test.ts` — 1 个冲突
- `tests/unit/reply-strategy-card.test.ts` — 验证与新接口兼容

### 3. 采纳 PR#494 新文件

这些文件在 origin/main 上存在，我们的分支没有：
- `src/card/card-streaming-mode.ts` — `resolveCardStreamingMode()` + deprecation warning
- `src/card/reasoning-answer-split.ts` — `splitCardReasoningAnswerText()`
- 合并后需要在 `reply-strategy-card.ts` 中 import 并使用

### 4. 全量验证

```bash
pnpm test && pnpm run type-check
```

### 5. 真机回归验证

按真机测试 skill 流程，验证 Issue 1-4 均已修复。

---

## 已知问题

1. **Sub-agent context hint 泄漏**（code review 发现）：sub-agent 模式下 `extractedContent.text` 被注入 `[你被 @ 为"AgentName"]` 前缀，会泄漏到 `quoteContent`。修复方案：在注入前捕获原始文本。超出当前计划范围。
2. **resolveCardRunByConversation substring 匹配**：理论上 `cid//abc` 会匹配 `cid//abc123`，但 DingTalk 的 base64 编码 conversationId 使此风险极低。可后续优化为精确匹配。

---

## Git 状态

```
当前分支: card-template-v2-clean
基线: 692a032 (docs(handoff): add card v2 fix and device test handoff)
最新 commits:
  f32bb40 style(card): add braces to satisfy curly lint rule
  fcbf4e1 feat(card): bridge sendMedia mediaId to active card via run registry
  c5f9272 feat(card): pass taskInfo to finalize for model/usage/elapsed display
  9846d64 fix(card): quoteContent always shows inbound message text

rebase 操作已中止，git 状态干净。需要重新开始 rebase：
  git fetch origin main
  git rebase origin/main
```
