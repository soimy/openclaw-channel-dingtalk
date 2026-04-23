# 真机测试发现的问题清单

**日期：** 2026-04-05
**分支：** card-template-v2-clean
**测试环境：** 钉钉群聊 "虾塘" (cid//Vc7N7lA5mymGresI0XAw==)
**测试方法：** 基于 handoff 文档 T1-T5 逐步真机验证

---

## 设计误区记录

### quoteContent 的正确语义

**错误理解：** `quoteContent` 指向用户发送消息时引用的那条消息（即"回复某条消息"场景）。

**正确语义：** `quoteContent` 始终指向**入站消息本身**——用户发送的那条触发本次卡片回复的消息。其功能是在一堆消息流中，让用户一眼识别出当前卡片回复的是自己输入的哪一条消息。因此 `quoteContent` 和 `hasQuote` 应该**始终有值**，除非入站消息为空。

**影响范围：**
- 卡片创建时的 `cardParamMap` 中 `quoteContent` 和 `hasQuote`
- `reply-strategy-card.ts` finalize 链路中的 `quoteContent` 写入
- `inbound-handler.ts` 中 `quoteContent` 的取值逻辑

---

## 已发现问题

### Issue 1: taskInfo 未传入 finalize 调用 [P1]

**发现于：** T1 真机测试
**现象：** 卡片底部 taskInfo 区域为空，缺少 model/effort/usage/taskTime 元数据
**根因：** `reply-strategy-card.ts:349-354` 调用 `commitAICardBlocks()` 时未传入 `taskInfoJson` 字段。`FinalizeCardOptions` 接口定义了该字段，但无任何调用方填充。
**预期数据结构（来自 mock）：**
```json
{
  "model": "gpt-5.4",
  "effort": "medium",
  "dapi_usage": 12,
  "taskTime": 24
}
```
**修复方向：** 从 agent run context 中提取 model/usage/elapsed 等元数据，在 finalize 调用时传入 `taskInfoJson`。

**关键文件：**
- `src/reply-strategy-card.ts` — finalize 调用方，需补传 taskInfoJson
- `src/card-service.ts:944` — `commitAICardBlocks()` 定义，已支持 taskInfoJson

---

### Issue 2: quoteContent 语义错误 + 始终为空 [P1]

**发现于：** T1 真机测试
**现象：** 卡片顶部引用区域始终为空
**根因：**
1. **语义错误**：代码将 `quoteContent` 当作"被引用消息的预览"（即 reply-to 场景），而非"入站消息本身的预览"。
2. **始终为空**：当前逻辑 `quoteContent: quotedRef ? quotePreview : ""`，当不存在 quotedRef 时留空。但按正确语义，`quoteContent` 应始终填充用户发送的消息内容。

**当前错误逻辑（inbound-handler.ts:707-713）：**
```typescript
const quotePreview =
  extractedContent.quoted?.previewText || data.content?.quoteContent || "";
// ...
quoteContent: quotedRef ? quotePreview : "",
```

**正确逻辑应为：**
- `quoteContent` = 入站消息的文本内容（截断至合理长度）
- `hasQuote` = 始终为 `"true"`（除非入站消息为空）
- 在 finalize 阶段也需要确保 quoteContent 被写入 instances API

**修复方向：**
1. 卡片创建时：`quoteContent` 取 `extractedContent.text`（用户发送的消息文本），`hasQuote` 始终 `"true"`
2. finalize 时：确保 `quoteContent` 通过 `commitAICardBlocks` 写入（当前被注释掉）

**关键文件：**
- `src/inbound-handler.ts:707-713` — quoteContent 取值逻辑
- `src/card-service.ts:714` — 卡片创建时的 cardParamMap
- `src/reply-strategy-card.ts:352` — finalize 时 quoteContent 被注释跳过

---

### Issue 3: reasoning 覆盖 answer + answer 被丢弃 [P1] — PR #494 已修复

**发现于：** T2 真机测试
**状态：** PR #494 (reasoning-card-split 分支, 已合并到 main) 已修复，当前基线未包含

**现象：**
1. 先流式显示正确答案文本
2. 突然出现整块 thinking/reasoning block，答案被覆盖
3. 最终卡片显示的是 reasoning 文本而非实际 answer

**日志证据：**
```
00:13:57.519 - content=349 "量子纠缠是..." (answer, 正确)
00:13:57.532 - content=417 "Reasoning:\n_The user is asking..." (reasoning, 覆盖了 answer)
00:13:57.938 - finalize: contentLen=417 preview="Reasoning:\n..." source=timeline.answer
```

**根因：**
1. `appendThinkingBlock` 调用后触发 `queueRender()`，此时 `activeAnswerIndex !== null`，导致 `streamContentToCard()` 将错误内容推送到 `content` key
2. finalize 阶段 `discardCurrentAnswerDraft("card.finalize")` 丢弃了正确答案，但 `getRenderedContent()` 返回的是 reasoning 覆盖后的内容
3. CardDraftController 存在 pending/in-flight 竞态

**PR #494 修复内容（已合并到 main）：**
- 引入 `cardStreamingMode: off | answer | all` 替代 `cardRealTimeStream`
- CardDraftController 添加渲染级去重，修复 pending/in-flight 竞态
- 引入 `final_seen → sealed` 生命周期，防止 late reasoning 覆盖 answer
- late tool 排序修复

**结论：** 当前基线不含此修复。将 PR #494 合入 card-template-v2-clean 后可验证。

---

### Issue 4: gateway method 获取 mediaId 后未嵌入卡片 [P2]

**发现于：** T3 真机测试
**状态：** 代码缺口 — mediaId 已获取但被主动消息路径独占

**现象：**
- agent 通过 `image` tool 处理图片 → `channel.ts` gateway method 调用 `sendProactiveMedia`
- 上传成功后获得 `mediaId`（如 `@lADPM2haUcIp0qHNAcfNA8A`）
- 但该 mediaId 仅用于发送独立主动消息，未传递给活跃卡片的 `appendImageBlock`

**日志证据：**
```
00:33:27 - Uploading media: windows_stained_glass.jpg (149834 bytes) as image
00:33:27 - Media uploaded: @lADPM2haUcIp0qHNAcfNA8A  ← mediaId 已获取
00:33:27 - Sending proactive image message to group     ← 仅走主动消息，未嵌入卡片
00:33:34 - finalize: blockListLen=322 contentLen=288     ← 卡片中无图片块
```

**根因：** `channel.ts:294` 的 `sendProactiveMedia` gateway method 与 `reply-strategy-card.ts` 的卡片流式更新是**两条完全独立的路径**。gateway method 不知道当前有活跃卡片，也不会将 mediaId 传递给 card controller。

**修复方向：**
1. 在 `card-run-registry.ts` 增加 `resolveCardRunBySession(sessionKey)` 或 `resolveCardRunByConversation(accountId, conversationId)` 方法
2. 在 `channel.ts` gateway method 中，`sendProactiveMedia` 成功获取 mediaId 后，查询当前会话的活跃卡片
3. 若有活跃卡片且有 controller，调用 `controller.appendImageBlock(mediaId)` 嵌入图片

**已有基础设施：** `src/card/card-run-registry.ts` 提供了按 `outTrackId` 查找活跃卡片的注册表，`CardRunRecord` 已持有 `controller?: CardDraftController` 引用。只需增加按会话维度的查找方法。

**关键文件：**
- `src/card/card-run-registry.ts` — 已有卡片运行注册表，需增加按 sessionKey/conversationId 查找
- `src/channel.ts:282-314` — gateway method，处理 media 发送，需桥接到 card controller
- `src/card-draft-controller.ts:414` — `appendImageBlock` 实现（已就绪）

---

## 测试进度

| 编号 | 测试项 | 优先级 | 状态 | 结果 |
|------|--------|--------|------|------|
| T1 | V2 Finalize 链路 | P0 | 通过 | instances API 正确，flowStatus=3 成功，Card FINISHED |
| T2 | getRenderedContent/Blocks 输出 | P1 | 有问题 | reasoning 覆盖 answer → Issue 3 (PR #494 已修) |
| T3 | 远程 Media URL 处理 | P2 | 有问题 | mediaId 已获取但未嵌入卡片 → Issue 4 (需修复) |
| T4 | 非图片附件降级 | P2 | 未覆盖 | agent 用 file tool 处理，卡片仅文本回复无报错 |
| T5 | Quote 内容来源 | P3 | 已验证 | 确认 quoteContent 始终为空 → Issue 2 (需修复) |

---

## 问题分类汇总

### 需在 card-template-v2-clean 分支修复

| # | 问题 | 优先级 | 修复范围 |
|---|------|--------|----------|
| 1 | taskInfo 未传入 finalize | P1 | `reply-strategy-card.ts` — 从 agent run context 提取元数据并传入 `taskInfoJson` |
| 2 | quoteContent 语义错误 | P1 | `inbound-handler.ts` + `card-service.ts` + `reply-strategy-card.ts` — 改为始终填充入站消息文本 |
| 4 | mediaId 未嵌入卡片 | P2 | `channel.ts` gateway method + card session 关联 — 桥接主动消息路径与卡片路径 |

### 合入 PR #494 后可解决

| # | 问题 | 优先级 | 状态 |
|---|------|--------|------|
| 3 | reasoning 覆盖 answer + timeline 竞态 | P1 | PR #494 已合并到 main，需 cherry-pick 或 rebase |
