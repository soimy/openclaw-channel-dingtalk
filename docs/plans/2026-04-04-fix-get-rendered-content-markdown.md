# Fix Plan: getRenderedContent() 返回汇总 Markdown

**日期：** 2026-04-04
**优先级：** P1
**状态：** 待实施
**关联问题：** Codex Review P1 - finalize/fallback 消费方期望 markdown

## 问题描述

`getRenderedContent()` 当前返回 `JSON.stringify(CardBlock[])`，但其消费方期望纯 markdown 文本：

| 消费方 | 位置 | 期望 | 实际 |
|--------|------|------|------|
| `finalize()` → `finishAICard()` | `reply-strategy-card.ts:316` | markdown | JSON |
| fallback 降级发送 | `reply-strategy-card.ts:277` | markdown | JSON |
| `finishAICard()` 写入 `content` key | `card-service.ts:1022` | 纯文本 | JSON |

## 影响范围

1. **复制功能损坏**：用户点击卡片复制按钮，得到 JSON 字符串
2. **Fallback 损坏**：卡片失败时降级发送 JSON 到聊天
3. **Content key 损坏**：钉钉卡片 `content` 变量被写入 JSON

## 当前实现

```typescript
// card-draft-controller.ts:448-454
getRenderedContent: (options?: { fallbackAnswer?: string; overrideAnswer?: string }) => {
    const blocks = renderTimelineAsBlocks(options);
    if (blocks.length === 0) {
        return "";
    }
    return JSON.stringify(blocks);  // ← 返回 JSON
},
```

## 修复方案

`getRenderedContent()` 应返回 timeline 中所有 answer 的 markdown 拼接：

```typescript
getRenderedContent: (options?: { fallbackAnswer?: string; overrideAnswer?: string }) => {
    const blocks = renderTimelineAsBlocks(options);
    if (blocks.length === 0) {
        return "";
    }
    // 从 blocks 中提取所有 type=0 的 markdown 内容
    return blocks
        .filter((b) => b.type === 0 && b.markdown)
        .map((b) => b.markdown)
        .join("\n\n");
},
```

## 方法重命名

为明确语义，将当前方法拆分：

```typescript
// 返回 CardBlock[] JSON（供 commitAICardBlocks 的 blockListJson 参数使用）
getRenderedBlocks: (options?) => string  // JSON.stringify(CardBlock[])

// 返回 markdown 文本（供 finalize 的 content 参数和 fallback 使用）
getRenderedContent: (options?) => string  // 纯文本
```

**当前** `getRenderedContent()` 返回 JSON → **重命名为** `getRenderedBlocks()`
**新增** `getRenderedContent()` 返回纯 markdown

## 测试覆盖

- `card-draft-controller.test.ts` 已有 `getRenderedContent returns JSON blocks array` 测试需要更新
- 新增测试：验证返回的是纯 markdown 文本
- 新增测试：验证空 timeline 返回空字符串
- 新增测试：验证只有 thinking/tool 块时返回空字符串

## 实施步骤

1. 修改 `card-draft-controller.ts` 中 `getRenderedContent()` 实现
2. 更新相关测试
3. 运行 `pnpm test` 验证
4. 运行 `pnpm run lint` 确保无新增错误

## 风险评估

- **风险低**：修改范围小，逻辑清晰
- **向后兼容**：需确认没有其他消费方依赖 JSON 输出
