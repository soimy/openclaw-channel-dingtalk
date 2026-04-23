# Card V2 Template Alignment — Handoff Document

**Date:** 2026-04-08
**Branch:** `card-template-v2-clean`
**Latest commit:** `3e36a47` feat(card-v2): align with V2 template - hasAction, agent in taskInfo, remove hasQuote

## Summary

AI Card V2 实现已完成，包括：
1. Codex 对抗性审核发现的问题修复
2. V2 模板对齐（hasAction, agent in taskInfo, remove hasQuote）
3. 所有 855 个测试通过

---

## Current State

### ✅ Completed Tasks

| Task | Description | Commit |
|------|-------------|--------|
| **Adversarial Review Fixes** | 修复 4 个跨用户/数据完整性问题 | `e9ebc75` |
| **V2 Template Alignment** | hasAction, agent in taskInfo, remove hasQuote | `3e36a47` |

### ✅ All Tests Pass

- 855 tests passed
- TypeScript type-check clean
- Lint passed (warnings only)

---

## Adversarial Review Fixes (e9ebc75)

### F1: 跨用户图片嵌入问题

**问题：** `resolveCardRunByConversation` 仅用 `accountId + conversationId` 匹配，群聊中并发卡片回复时图片会错配。

**修复：**
- 扩展 `resolveCardRunByConversation` 支持 `ownerUserId` 过滤
- 添加 `expectedCardOwnerId` 参数到 `sendMedia` gateway
- 保守策略：仅当调用方能提供期望的卡片所有者 ID 时才执行嵌入

**文件：**
- `src/card/card-run-registry.ts:99-121`
- `src/channel.ts:503-630`

### F2: Abort 路径使用废弃 API

**问题：** V2 卡片生命周期已迁移到 `commitAICardBlocks`，但 abort 分支仍调用废弃的 `finishAICard`。

**修复：**
- 替换 abort 分支的 `finishAICard` 为 `commitAICardBlocks`
- 创建 abort 文本块：`[{ type: 2, markdown: abortText }]`

**文件：**
- `src/inbound-handler.ts:1363-1382`

### F3: 非图片附件绕过 reply session

**问题：** 延迟的非图片附件使用 `sendProactiveMedia` 而非 `sessionWebhook`。

**修复：**
- 优先使用 `sessionWebhook` + `sendMessage` 发送延迟附件
- 仅在无 session 时 fallback 到 proactive send

**文件：**
- `src/reply-strategy-card.ts:493-536`

### F4: quoteContent 使用重写后的入站文本

**问题：** sub-agent 路由时 `extractedContent.text` 被重写（添加 `[你被 @ 为"..."]` 前缀）。

**修复：**
- 在 sub-agent 重写前保存 `rawInboundText`
- 使用原始文本填充 `quoteContent`

**文件：**
- `src/inbound-handler.ts:443-448, 733-738`

---

## V2 Template Alignment (3e36a47)

### Task 1: Remove hasQuote

**原因：** V2 模板根据 `quoteContent` 值是否为空自动控制引用块显示。

**变更：**
- 移除 `CreateAICardOptions` 接口中的 `hasQuote` 字段
- 移除 `cardParamMap` 中的 `hasQuote` 设置
- 移除 `inbound-handler.ts` 中的 `hasQuote` 传参

### Task 2: taskInfo.agent

**变更：**
- `TaskMeta` 接口新增 `agent?: string` 字段
- 新增 `getAgentDisplayName()` 辅助函数（优先级：matchedName > agents.list name > agentId）
- 在 `inbound-handler.ts` 中传递 agent 名称到 `taskMeta`

**Agent 名称获取优先级：**

```typescript
// src/targeting/agent-name-matcher.ts
export function getAgentDisplayName(params: {
  subAgentOptions?: { matchedName?: string };
  agentId: string;
  agentsList?: Array<{ id: string; name?: string }>;
}): string {
  // 1. 子 agent 的 matchedName (用户友好名称，如 "代码专家")
  // 2. 从 agents.list 查找配置的 name
  // 3. fallback 到 agentId
}
```

### Task 3: hasAction replaces stop_action

**变更：**
- `STOP_ACTION_VISIBLE/HIDDEN` 从字符串改为布尔值
- `cardParamMap` 同时设置 `hasAction` (V2) 和 `stop_action` (V1 兼容)
- `hideCardStopButton` 更新为设置两个变量

**兼容性设计：**
```typescript
const cardParamMap = {
  // ...
  hasAction: true,           // V2
  stop_action: "true",       // V1 compat
};
```

---

## Key Files Modified

| File | Changes |
|------|---------|
| `src/card/card-template.ts` | STOP_ACTION 常量改为布尔值 |
| `src/card-service.ts` | 移除 hasQuote，添加 hasAction，V2 finalize |
| `src/card/card-run-registry.ts` | ownerUserId 过滤 |
| `src/channel.ts` | expectedCardOwnerId 参数 |
| `src/inbound-handler.ts` | rawInboundText, taskMeta.agent, V2 abort finalize |
| `src/reply-strategy.ts` | TaskMeta.agent 字段 |
| `src/reply-strategy-card.ts` | taskInfo.agent, sessionWebhook 延迟附件 |
| `src/targeting/agent-name-matcher.ts` | getAgentDisplayName 函数 |

---

## Known Issues / Future Work

### 真机测试验证

需要真机验证以下场景：

| 测试项 | 验证点 |
|--------|--------|
| **卡片创建** | quoteContent 显示用户原始消息（非 sub-agent 前缀） |
| **卡片 finalize** | taskInfo 区域显示 model/usage/taskTime/agent |
| **图片嵌入** | agent 生成的图片正确嵌入卡片（非错配到其他用户） |
| **非图片附件** | voice/video/file 在卡片 finalize 后作为独立消息发送 |
| **Abort 流程** | `/stop` 后卡片正确离开 PROCESSING 状态 |
| **群聊并发** | 多用户同时触发卡片时图片不串卡 |
| **Stop Button** | hasAction 正确控制 Stop Button 显示/隐藏 |

### 真机测试 Checklist

参考 `skills/dingtalk-real-device-testing/SKILL.md`:

1. **T1: V2 Finalize 链路** — instances API 正确调用，flowStatus=3
2. **T2: getRenderedContent 输出** — reasoning 不覆盖 answer
3. **T3: MediaId 嵌入** — 图片正确嵌入卡片
4. **T4: 非图片附件** — voice/video/file 延迟发送
5. **T5: Quote 内容** — quoteContent 显示用户原始消息

---

## Related Documentation

- `docs/plans/2026-04-07-codex-adversarial-review-fixes.md` — 对抗性审核修复计划
- `docs/plans/2026-04-07-card-v2-template-alignment.md` — V2 模板对齐设计
- `docs/plans/2026-04-06-card-v2-real-device-fixes.md` — 真机测试修复
- `docs/assets/card-template-v2.json` — V2 卡片模板
- `docs/assets/card-data-mock-v2.json` — V2 卡片数据 Mock

---

## New Session Prompt

```
我在 card-template-v2-clean 分支上完成了 AI Card V2 实现，包括对抗性审核修复和 V2 模板对齐。

当前状态：
- 最新 commit: 3e36a47
- 所有 855 个测试通过
- 类型检查和 lint 通过

已完成的工作：
1. Codex 对抗性审核修复（F1-F4）
2. V2 模板对齐（hasAction, agent in taskInfo, remove hasQuote）

下一步：真机测试验证

请阅读 docs/plans/2026-04-08-card-v2-template-alignment-handoff.md 了解完整上下文，然后帮我：
1. 确认真机测试环境就绪
2. 按真机测试 checklist 逐项验证
3. 记录任何发现的问题
```