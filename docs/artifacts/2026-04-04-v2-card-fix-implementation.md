# V2 Card Template 修复实施记录

**日期：** 2026-04-04
**分支：** card-template-v2-clean
**PR：** #480

## 问题背景

Codex review 发现 V2 卡片模板实现存在多个问题，核心是 finalize 链路仍使用 streaming API 而非 instances API。

## 修复清单

| # | 问题 | 优先级 | Commit |
|---|------|--------|--------|
| 1 | `getRenderedContent()` 返回 JSON 而非 markdown | P1 | `2e10243` |
| 2 | `finishAICard()` 使用 streaming API finalize | P0 | `6dc9419` |
| 3 | 远程 media URL 直接传给 `uploadMedia()` | P2 | `d9f8f80` |
| 4 | 非图片附件硬编码为 `image` 类型 | P2 | `d9f8f80` |
| 5 | Quote header 用错内容来源 | P3 | `fab3738` |

## 实现路径

### P1: getRenderedContent 方法拆分

**问题**：`getRenderedContent()` 返回 `CardBlock[]` JSON，但调用方期望 markdown 文本。

**解决方案**：拆分为两个方法

```typescript
// card-draft-controller.ts 接口
getRenderedBlocks: () => string   // CardBlock[] JSON (供 instances API)
getRenderedContent: () => string  // 纯 markdown (供复制/fallback)
```

**实现**：两个方法共享 `renderTimelineAsBlocks()` 逻辑

```typescript
getRenderedBlocks: (options?) => {
    const blocks = renderTimelineAsBlocks(options);
    return blocks.length > 0 ? JSON.stringify(blocks) : "";
},
getRenderedContent: (options?) => {
    const blocks = renderTimelineAsBlocks(options);
    return blocks
        .filter((b) => b.type === 0 && "markdown" in block && block.markdown)
        .map((block) => block.markdown)
        .join("\n\n");
},
```

### P0: commitAICardBlocks 单次 instances API 固化

**问题**：`finishAICard()` 调用 `streamAICard()` 使用 streaming API，但 V2 template 实验表明 finalize 必须用 instances API。

**解决方案**：重构 `commitAICardBlocks()` 为 V2 finalize 入口

```typescript
export interface FinalizeCardOptions {
    blockListJson: string;    // CardBlock[] JSON
    content: string;          // 纯文本 (供复制)
    quoteContent?: string;    // 引用内容
    quotedRef?: QuotedRef;    // 用于缓存
}

export async function commitAICardBlocks(
    card: AICardInstance,
    options: FinalizeCardOptions,
    log?: Logger,
): Promise<void> {
    const updates: Record<string, string | number> = {
        blockList: options.blockListJson,
        content: options.content,      // 同样通过 instances 写入
        flowStatus: 3,                 // 完成态
    };

    // 单次 instances API 调用
    await updateCardVariables(card, updates, log);

    // 缓存 + 状态更新
    cacheCardContentByProcessQueryKey(...);
    card.state = AICardStatus.FINISHED;
    removePendingCard(card, log);
}
```

**关键发现**：
- V2 template 的 `flowStatus=3` 时，Stop Button 自动隐藏，无需单独调用 `hideCardStopButton()`
- `content` key 可以通过 instances API 写入，用于复制按钮取值

### P2: 远程 Media URL 处理

**问题**：`uploadMedia()` 只支持本地文件路径，远程 URL 导致 ENOENT。

**解决方案**：复用 `prepareMediaInput()` 处理远程 URL

```typescript
import { prepareMediaInput, resolveOutboundMediaType } from "./media-utils";

for (const url of payload.mediaUrls || []) {
    const prepared = await prepareMediaInput(url, log);
    const mediaType = resolveOutboundMediaType({ mediaPath: prepared.path, asVoice: false });

    if (mediaType === "image") {
        // 图片 → 嵌入卡片
        const result = await uploadMedia(config, prepared.path, "image", log);
        await controller.appendImageBlock(result.mediaId);
    } else {
        // 非图片 → 降级为卡片外发送 (V2 卡片只支持 type=3 图片块)
        log?.debug?.(`[DingTalk][Card] Skipping non-image media in card: ${url}`);
    }

    // 清理临时文件
    await prepared.cleanup?.();
}
```

### P3: Quote 内容来源修复

**问题**：`quoteContent` 使用 `extractedContent.text`（当前消息），而非被引用消息。

**解决方案**：从正确的来源获取

```typescript
// inbound-handler.ts
const quotePreview = extractedContent.quoted?.previewText
    || data.content?.quoteContent
    || "";

quoteContent: quotedRef ? quotePreview : "",
```

## API 路由总结

| 阶段 | API | 变量 | 用途 |
|------|-----|------|------|
| 创建 | instances (createAndDeliver) | content, stop_action, hasQuote | 初始化卡片 |
| 流式预览 | streaming | content | 实时预览文本 |
| 流式块更新 | instances | blockList | 结构化内容 |
| Finalize | instances | blockList, content, flowStatus | 一次性固化 |

## 经验总结

### 1. API 选择原则

- **streaming API**：仅用于简单 string 类型变量（如 `content` 的实时预览）
- **instances API**：用于复杂类型（`blockList` loopArray）和 finalize 固化

### 2. V2 Template 特性

- `flowStatus=3` 自动隐藏 Stop Button
- `content` key 可通过 instances API 写入，作为复制按钮取值来源
- `blockList` 是 JSON string，需要 `JSON.stringify(CardBlock[])`

### 3. 方法命名规范

- `getRenderedBlocks()` - 返回结构化数据 JSON
- `getRenderedContent()` - 返回用户可见文本
- 语义清晰，避免调用方混淆

### 4. 测试策略

- Mock `prepareMediaInput` 和 `resolveOutboundMediaType` 以隔离 media 处理逻辑
- 测试文件使用 `.png`/`.jpg` 而非 `.pdf` 以触发 image 路径
- 默认 mock 返回 `"file"` 类型，image 测试显式 override

## 文件变更

| 文件 | 变更类型 |
|------|----------|
| `src/card-draft-controller.ts` | 接口拆分 |
| `src/card-service.ts` | 重构 commitAICardBlocks |
| `src/reply-strategy-card.ts` | finalize 切换 + media 处理 |
| `src/inbound-handler.ts` | quote 来源修复 |
| `tests/unit/card-draft-controller.test.ts` | 新增测试 |
| `tests/unit/reply-strategy-card.test.ts` | media mock 更新 |
| `tests/unit/inbound-handler.test.ts` | quote 测试更新 |

## 验证结果

- 831 tests passed
- type-check passed
- lint passed (0 errors, 89 warnings for `no-explicit-any`)