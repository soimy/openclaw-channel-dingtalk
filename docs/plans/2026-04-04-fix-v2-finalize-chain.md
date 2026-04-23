# Fix Plan: V2 Finalize 链路 - commitAICardBlocks 一次性固化

**日期：** 2026-04-04
**优先级：** P0 (阻塞级)
**状态：** 待实施
**关联问题：** V2 template finalize 必须使用 card/instances API

## 问题描述

当前 `reply-strategy-card.ts finalize()` 调用 `finishAICard()`，但该函数仍然使用 streaming API (`/v1.0/card/streaming`) 做 finalize，而根据 V2 template 实验结论，**finalize 必须使用 instances API**。

### 当前错误链路

```
finalize() → finishAICard() → streamAICard() → putAICardStreamingField()
                                                     ↓
                                          PUT /v1.0/card/streaming ❌
```

### V2 设计期望链路

```
finalize() → commitAICardBlocks() → updateCardVariables() (instances API)
                                           ↓
                          PUT /v1.0/card/instances ✅
                          一次性写入: blockList, content, quoteContent, taskInfo, flowStatus
```

## 设计决策

### 1. Stop Button 隐藏 - 不需要处理

**原因**：V2 模板在 `flowStatus=3`（完成态）时，卡片 UI 已经不渲染 Stop Button，因此无需调用 `hideCardStopButton()`。

### 2. Content 写入 - 在 instances API 中一次性提交

Finalize 时通过 **单次 instances API 调用** 提交所有需要固化的变量：

| 变量 | 类型 | 用途 |
|------|------|------|
| `blockList` | JSON string | 结构化内容块 |
| `content` | string | 复制按钮取值（纯文本 answer） |
| `quoteContent` | string | 引用内容（如果有） |
| `taskInfo` | JSON string | 任务元数据 |
| `flowStatus` | number | 卡片状态 (3 = 完成) |

## 修复方案

### 重构 `commitAICardBlocks()` - 一次性固化所有变量

```typescript
export interface FinalizeCardOptions {
  blockListJson: string;       // CardBlock[] JSON
  content: string;             // 纯文本 answer（供复制）
  quoteContent?: string;       // 引用内容
  taskInfoJson?: string;       // 任务元数据 JSON
  quotedRef?: QuotedRef;       // 用于缓存
}

export async function commitAICardBlocks(
  card: AICardInstance,
  options: FinalizeCardOptions,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    return;
  }

  const template = DINGTALK_CARD_TEMPLATE;
  const updates: Record<string, string | number> = {
    [template.blockListKey]: options.blockListJson,
    [template.streamingKey]: options.content,  // content 也通过 instances 写入
    flowStatus: 3,  // 完成态
  };

  // 可选字段
  if (options.quoteContent) {
    updates.quoteContent = options.quoteContent;
  }
  if (options.taskInfoJson) {
    updates.taskInfo = options.taskInfoJson;
  }

  // 单次 instances API 调用
  await updateCardVariables(card, updates, log);

  // 缓存 card content（用于 quote recovery）
  if (card.conversationId && options.content.trim() && card.accountId && card.processQueryKey) {
    cacheCardContentByProcessQueryKey(
      card.accountId,
      card.contextConversationId || card.conversationId,
      card.processQueryKey,
      options.content,
      card.storePath,
      options.quotedRef,
      log,
    );
  }

  // 更新本地状态
  card.state = AICardStatus.FINISHED;
  card.lastUpdated = Date.now();
  removePendingCard(card, log);
}
```

### 调用方修改

`reply-strategy-card.ts finalize()`:

```typescript
// 之前
const finalText = getRenderedTimeline({ preferFinalAnswer: true });
await finishAICard(card, finalText, log, { quotedRef: ctx.replyQuotedRef });

// 之后
const blockListJson = controller.getRenderedBlocks();  // CardBlock[] JSON
const content = controller.getFinalAnswerContent();     // 纯文本 answer
const quoteContent = ctx.replyQuotedRef?.previewText;

await commitAICardBlocks(card, {
  blockListJson,
  content,
  quoteContent,
  quotedRef: ctx.replyQuotedRef,
}, log);
```

## 需要新增的方法

### `controller.getRenderedBlocks()`

返回 `CardBlock[]` 的 JSON 字符串（当前 `getRenderedContent()` 的行为，改名）：

```typescript
getRenderedBlocks: () => string {
  const blocks = renderTimelineAsBlocks();
  return blocks.length > 0 ? JSON.stringify(blocks) : "";
}
```

### `controller.getFinalAnswerContent()`

已存在，返回纯文本 answer。

## 实施步骤

1. **card-draft-controller.ts**
   - 重命名当前 `getRenderedContent()` → `getRenderedBlocks()`
   - 新增 `getRenderedContent()` 返回纯 markdown（见另一个 fix plan）

2. **card-service.ts**
   - 重构 `commitAICardBlocks()` 按上述设计
   - 标记 `finishAICard()` 为 deprecated（或删除）

3. **reply-strategy-card.ts**
   - `finalize()` 调用 `commitAICardBlocks()` 替代 `finishAICard()`

4. **测试更新**
   - 更新 `card-draft-controller.test.ts`
   - 更新 `reply-strategy-card.test.ts`
   - 新增 `commitAICardBlocks` 集成测试

5. **真机验证**

## API 调用对比

| 阶段 | 之前 | 之后 |
|------|------|------|
| Streaming blockList | instances API ✅ | instances API ✅ |
| Streaming content | streaming API ✅ | streaming API ✅ |
| Finalize | streaming API ❌ | **instances API** ✅ |

## 风险评估

- **风险中**：涉及核心 finalize 链路
- **需要真机验证**：确认 instances API 可以同时写入 `content` 和 `blockList`
- **关联修复**：需要与 `getRenderedContent()` 修复协调
