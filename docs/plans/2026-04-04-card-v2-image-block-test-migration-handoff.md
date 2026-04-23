# Handoff: Card v2 Image Block 测试迁移完成

## 状态

**测试进度**: 829/829 全部通过 ✅

**分支**: `card-template-v2`

**完成日期**: 2026-04-04

## 核心变更

card-draft-controller 从 markdown 字符串格式迁移到 JSON `CardBlock[]` 格式。

### 格式对比

**旧格式 (markdown)**
```
> 思考中...

> 工具调用结果...

最终答案文本
```

**新格式 (JSON CardBlock[])**
```json
[
  {"type": 1, "markdown": "思考中..."},
  {"type": 2, "markdown": "工具调用结果..."},
  {"type": 0, "markdown": "最终答案文本"},
  {"type": 3, "mediaId": "xxx"}
]
```

### CardBlock 类型定义

```typescript
type CardBlock =
  | { type: 0; markdown: string }  // answer
  | { type: 1; markdown: string }  // thinking
  | { type: 2; markdown: string }  // tool
  | { type: 3; mediaId: string };  // image
```

## 修复的 3 个测试失败

### 1. card-service.test.ts > createAICard returns card instance

**问题**: 测试期望 `cardParamMap` 不包含 `hasQuote`/`quoteContent`，但实际代码添加了这些字段。

**修复**: 更新测试断言以包含新字段：
```typescript
expect(body.cardData?.cardParamMap).toEqual({
    config: '{"autoLayout":true,"enableForward":true}',
    content: '',
    stop_action: 'true',
    hasQuote: 'false',
    quoteContent: '',
});
```

### 2. inbound-handler.test.ts > finalizes card with default content when no textual output is produced

**问题**: 测试期望 `"✅ Done"`，但得到 `"[]"` (空 JSON 数组)。

**根本原因**: `getRenderedContent()` 返回 JSON 字符串。当没有内容时，返回 `"[]"` 而不是空字符串。由于 `"[]"` 是 truthy，`||` fallback 不触发。

**修复**: 在 `card-draft-controller.ts` 的 `getRenderedContent` 中检查空数组：
```typescript
getRenderedContent: (options?) => {
    const blocks = renderTimelineAsBlocks(options);
    if (blocks.length === 0) {
        return "";
    }
    return JSON.stringify(blocks);
},
```

### 3. inbound-handler.test.ts > card mode + media

**问题**: 测试期望 `sendMessage` 被调用（旧行为），但新行为使用 `uploadMedia → appendImageBlock`。

**根本原因**:
1. `send-service` mock 缺少 `uploadMedia` 导出
2. 测试期望基于旧的 markdown fallback 行为

**修复**:
1. 添加 `uploadMediaMock` 到 shared mocks
2. 更新 `send-service` mock 导出 `uploadMedia`
3. 更新测试预期匹配新行为：
```typescript
// 旧: expect(sendMessageMock).toHaveBeenCalledWith(...)
// 新:
expect(shared.uploadMediaMock).toHaveBeenCalledWith(
    expect.objectContaining({ dmPolicy: "open", messageType: "card" }),
    "https://cdn.example.com/report.pdf",
    "image",
    undefined,
);
expect(shared.finishAICardMock).toHaveBeenCalledWith(
    card,
    JSON.stringify([
        { type: 3, mediaId: "media_img_123" },
        { type: 0, markdown: "final output" },
    ]),
    undefined,
    { quotedRef: {...} },
);
```

## 测试迁移辅助函数

在 `card-draft-controller.test.ts` 中添加：

```typescript
function parseBlocks(content: string): CardBlock[] {
    try {
        return JSON.parse(content);
    } catch {
        return [];
    }
}

function getBlockText(blocks: CardBlock[], index: number): string {
    const block = blocks[index];
    if (!block) return "";
    return "markdown" in block ? block.markdown : "";
}
```

## 关键文件变更

| 文件 | 变更类型 |
|------|----------|
| `src/card-draft-controller.ts` | `getRenderedContent` 返回 JSON，空数组返回 `""` |
| `src/reply-strategy-card.ts` | mediaUrls → `uploadMedia` → `appendImageBlock` |
| `tests/unit/card-service.test.ts` | 添加 `hasQuote`/`quoteContent` 断言 |
| `tests/unit/inbound-handler.test.ts` | 添加 `uploadMediaMock`，更新 media 测试预期 |
| `tests/unit/card-draft-controller.test.ts` | 添加 `parseBlocks`/`getBlockText` 辅助函数 |

## 下一步

- [ ] 真机验证 image block 渲染
- [ ] 确认 mediaId 上传后图片正常显示
- [ ] 合并到主分支
