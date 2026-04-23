# Fix Plan: Card Media 处理 + Quote 内容修复

**日期：** 2026-04-04
**优先级：** P2/P3
**状态：** 待实施
**关联问题：** Codex Review P2/P3 - media 和 quote 处理

## 问题 1 [P2]：远程 media URL 直接传给 `uploadMedia()`

### 位置
- `src/reply-strategy-card.ts:181-185` (deliver final)
- `src/reply-strategy-card.ts:229-233` (deliver block)

### 问题描述

```typescript
for (const url of payload.mediaUrls || []) {
    const result = await uploadMedia(config, url, "image", log);  // ← HTTP URL 直接当路径
}
```

`uploadMedia()` 内部调用 `readMediaBuffer()` 只支持 `fs.readFile()`，远程 URL 会导致 ENOENT 错误。

### 修复方案

复用已有的 `prepareMediaInput()` 处理远程 URL 下载：

```typescript
import { prepareMediaInput } from "./media-utils";

for (const url of payload.mediaUrls || []) {
    const { localPath, mediaType } = await prepareMediaInput(url, log);
    // localPath 现在是本地文件路径（远程 URL 已下载）
}
```

---

## 问题 2 [P2]：非图片附件硬编码为 `image` 类型

### 位置
- `src/reply-strategy-card.ts:181-185`
- `src/reply-strategy-card.ts:229-233`

### 问题描述

`mediaUrls` 可能包含 PDF、语音、视频等，但代码：
1. 硬编码 `mediaType="image"`
2. 只追加 `type=3` 图片块

导致非图片附件上传失败或渲染损坏。

### 修复方案

根据 `resolveOutboundMediaType()` 检测类型，非图片附件降级为卡片外单独发送：

```typescript
import { prepareMediaInput, resolveOutboundMediaType } from "./media-utils";

for (const url of payload.mediaUrls || []) {
    const { localPath, mediaType } = await prepareMediaInput(url, log);

    if (mediaType === "image") {
        // 图片 → 嵌入卡片
        const result = await uploadMedia(config, localPath, "image", log);
        if (result?.mediaId) {
            await controller.appendImageBlock(result.mediaId);
        }
    } else {
        // 非图片 → 降级为卡片外单独发送
        // V2 卡片模板只支持 type=3 图片块
        nonImageMediaUrls.push(url);
    }
}

// 在 finalize 后发送非图片附件
if (nonImageMediaUrls.length > 0) {
    await deliverMediaAttachments(nonImageMediaUrls, mediaType);
}
```

### 降级策略

| 附件类型 | 处理方式 |
|----------|----------|
| image | 嵌入卡片 (type=3 块) |
| voice | 卡片外单独发送 |
| video | 卡片外单独发送 |
| file | 卡片外单独发送 |

---

## 问题 3 [P3]：Quote header 内容来源错误

### 位置
- `src/inbound-handler.ts:710-711`

### 问题描述

```typescript
quoteTitle: quotedRef ? extractedContent.text.slice(0, 50) : undefined,
quoteContent: quotedRef ? extractedContent.text.slice(0, 200) : undefined,
```

`extractedContent.text` 是**当前消息**的内容（如"继续"），而非**被引用消息**的内容。

用户回复"继续"时，卡片 quote header 会显示"继续"而非被引用的原消息。

### 修复方案

从正确的来源获取被引用消息的文本：

```typescript
// 被引用消息的预览文本
const quotePreview = content?.quoted?.previewText
    || content?.quoteContent
    || "";

quoteTitle: quotedRef ? quotePreview.slice(0, 50) : undefined,
quoteContent: quotedRef ? quotePreview.slice(0, 200) : undefined,
```

### 变量来源说明

| 变量 | 来源 | 含义 |
|------|------|------|
| `extractedContent.text` | 当前消息 | 用户输入的文本 |
| `content.quoted.previewText` | 被引用消息 | 引用消息的预览 |
| `content.quoteContent` | 被引用消息 (legacy) | 兼容字段 |

---

## 实施步骤

1. **修复 P2 远程 URL**
   - 在 `reply-strategy-card.ts` 中导入 `prepareMediaInput`
   - 在 media 处理循环中使用它

2. **修复 P2 非图片附件**
   - 检测 mediaType
   - 非图片类型收集到单独列表
   - finalize 后降级发送

3. **修复 P3 quote 内容**
   - 在 `inbound-handler.ts` 中使用正确的 quote 来源

4. **测试更新**
   - 新增远程 URL 测试用例
   - 新增非图片附件降级测试
   - 新增 quote 内容测试

---

## 风险评估

| 问题 | 风险 | 备注 |
|------|------|------|
| P2 远程 URL | 低 | 复用已有函数 |
| P2 非图片降级 | 中 | 需要确认发送时机 |
| P3 quote | 低 | 简单字段替换 |
