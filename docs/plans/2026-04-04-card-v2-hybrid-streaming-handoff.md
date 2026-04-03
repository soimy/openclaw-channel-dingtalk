# DingTalk AI Card v2 Hybrid Streaming - Implementation Handoff

**日期：** 2026-04-04
**状态：** ✅ 已实现
**Commit:** b1163d0

## 概述

本文档总结了 DingTalk AI Card v2 模板的混合流式更新实现经验。

## 关键发现

### 1. Streaming API 与 Instances API 的分工

**问题：** `/v1.0/card/streaming` API 对复杂 loopArray 类型变量返回 500 错误

**解决方案：** 混合 API 路由策略
- **简单 string 类型变量**（如 `content`）→ streaming API ✅ 支持
- **复杂 loopArray 类型变量**（如 `blockList`）→ instances API ✅ 支持

### 2. 新模板支持 streaming API

新模板 `5db37f25-ac9e-4250-9c1d-c4ddba6e16e9.schema` 的 `content` key 支持 streaming API：

```
PUT /v1.0/card/streaming
{
  "outTrackId": "...",
  "guid": "...",
  "key": "content",
  "content": "流式内容...",
  "isFull": true,
  "isFinalize": false
}
```

### 3. 双路径输出架构

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  TimelineEntry  │ ──► │   queueRender()  │ ──► │   Dual-Path     │
│  (answer/text)  │     │                  │     │   Output        │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                         │
                        ┌────────────────────────────────┴────────────────────────────────┐
                        │                                                                         │
                        ▼                                                                         ▼
            ┌───────────────────────┐                                           ┌───────────────────────┐
            │    streaming API      │                                           │    instances API      │
            │    (content key)      │                                           │    (blockList key)    │
            │    实时预览            │                                           │    持久化存储          │
            └───────────────────────┘                                           └───────────────────────┘
```

### 4. cardRealTimeStream 配置开关

- `cardRealTimeStream=true`: answer 文本流式更新到 `content` key 实时显示，边界处清空并提交到 `blockList`
- `cardRealTimeStream=false`: 所有更新直接提交到 `blockList`

## 已实现的函数

### card-service.ts

```typescript
// 更新 blockList via instances API
export async function updateAICardBlockList(
  card: AICardInstance,
  blockListJson: string,
  log?: Logger,
): Promise<void>

// 流式更新 content key (仅当 cardRealTimeStream=true)
export async function streamAICardContent(
  card: AICardInstance,
  text: string,
  log?: Logger,
): Promise<void>

// 清空 streaming content (边界处调用)
export async function clearAICardStreamingContent(
  card: AICardInstance,
  log?: Logger,
): Promise<void>

// 组合提交：finalize 时写入 content 供复制功能使用，然后更新 blockList
export async function commitAICardBlocks(
  card: AICardInstance,
  blockListJson: string,
  isFinalize: boolean,
  log?: Logger,
): Promise<void>
```

### card-draft-controller.ts

```typescript
export interface CardDraftController {
  // ... 现有方法 ...

  // 新增：仅当 realTimeStreamEnabled=true 时可用
  streamContent?: (text: string) => Promise<void>;
  clearStreamingContent?: () => Promise<void>;
  isRealTimeStreamEnabled: () => boolean;
}
```

### card/card-template.ts

```typescript
export interface DingTalkCardTemplateContract {
  templateId: string;
  blockListKey: string;     // "blockList" - via instances API
  streamingKey: string;     // "content" - via streaming API
  copyKey: string;          // "content" - 复制按钮取值
  /** @deprecated Use blockListKey instead. */
  contentKey: string;       // backward compat alias
}
```

## 卡片变量映射

| 变量名 | 用途 | 类型 | 更新 API |
|--------|------|------|----------|
| `blockList` | 结构化内容块 | JSON string | instances |
| `content` | 纯文本（复制/流式显示） | string | streaming |
| `taskInfo` | 任务元数据 | JSON string | instances |
| `flowStatus` | 卡片状态 | string | instances |

## 测试覆盖

所有相关测试已更新，mock 从 `streamAICard` 改为 `updateAICardBlockList`：
- `tests/unit/card-draft-controller.test.ts` ✅
- `tests/unit/reply-strategy-card.test.ts` ✅
- `tests/unit/inbound-handler.test.ts` ✅

## 后续工作

1. **真机测试**：在钉钉客户端验证 `cardRealTimeStream=true/false` 两种模式
2. **性能优化**：评估 streaming API 与 instances API 的延迟差异
3. **错误处理**：streaming API 失败时的降级策略

## 参考文件

- 实现计划: `docs/plans/2026-04-04-dingtalk-card-v2-hybrid-streaming-implementation.md`
- 模板设计: `docs/spec/2026-03-30-card-template-v2-design.md`
