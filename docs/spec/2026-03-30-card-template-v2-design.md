# AI Card v2 模板重构设计

> 更新日期：2026-03-31
> 状态：草案，讨论中

## 背景

当前 AI Card 通过钉钉 streaming API 的单一 `key: "content"` 推送 markdown 文本，`CardDraftController` 维护 `TimelineEntry[]` (thinking/tool/answer) 并渲染为单一 markdown 流。这种方式无法利用钉钉卡片模板的结构化 UI 能力（blockList、taskInfo、引用展示、交互按钮等）。

本次重构将 AI Card 数据结构从单一 markdown 升级为多 key 结构化数据，同时简化配置（取消用户自定义 `cardTemplateId`/`cardTemplateKey`），使用预置的统一卡片模板。

## 目标

1. 使用钉钉卡片模板 v2 的结构化 UI 能力（blockList、taskInfo、引用展示、按钮）
2. 用 `CardBlock[]` 替代 `TimelineEntry[]`，直接传递结构化数据而非渲染后的 markdown
3. 简化配置：取消 `cardTemplateId`/`cardTemplateKey` 用户配置，使用预置模板
4. 采集任务元数据（model、effort、taskTime、dapi_usage）展示在卡片中
5. 支持引用消息的独立展示（`hasQuote`/`quoteContent`）
6. 预留交互按钮能力（`btns`），当前默认隐藏（`hasAction=false`）
7. **新增**：多类型 block（answer/think/tool/image/approval/topic），共 6 种类型，使用 `type: number` 字段驱动模板条件渲染

---

## 新数据结构

### Block 类型枚举（`src/types.ts`）

```typescript
/**
 * Card block type enum — drives conditional rendering in the preset template.
 *
 * - 0: answer  — markdown body block
 * - 1: think   — thinking/reasoning text block
 * - 2: tool    — tool execution text block
 * - 3: image   — image block (requires mediaId)
 * - 4: approval — image + interactive buttons (requires mediaId + btns)
 * - 5: topic   — topic/tag text block
 */
export type CardBlockType = 0 | 1 | 2 | 3 | 4 | 5;
```

### 卡片传输类型（`src/types.ts`）

```typescript
/** 预置卡片模板 ID（统一模板，取消用户配置） */
export const PRESET_CARD_TEMPLATE_ID = "301508cd-5ddd-4e86-85f0-6b5312032743.schema";

export interface CardBlock {
  /**
   * Block type — drives conditional rendering in the preset template.
   *
   * - 0 = answer  — markdown body block (MarkdownBlock)
   * - 1 = think   — thinking/reasoning text block (BaseText)
   * - 2 = tool    — tool execution text block (BaseText)
   * - 3 = image   — image block (Image component, requires mediaId)
   * - 4 = approval — image + interactive buttons (Image + ButtonGroup)
   * - 5 = topic   — topic/tag text block (Grid/Tag)
   */
  type: CardBlockType;

  /**
   * Plain text content.
   * - type=0 (answer): plain text version of the answer
   * - type=1/2 (think/tool): full thinking/tool text
   * - type=3/4 (image/approval): empty or image description
   * - type=5 (topic): topic text
   */
  text: string;

  /**
   * Markdown content.
   * - type=0 (answer): streaming markdown content
   * - type=1/2 (think/tool): same as text
   * - type=3/4/5: empty or placeholder
   */
  markdown: string;

  /**
   * DingTalk mediaId for image blocks (type=3 only).
   * Empty string for other types.
   */
  mediaId: string;

  /**
   * Interactive buttons for approval blocks (type=4 only).
   * Empty array for other types.
   */
  btns: CardBtn[];
}

export interface CardTaskInfo {
  model?: string;       // 模型名（通过 onModelSelected 获取）
  effort?: string;      // 思维链深度（通过 onModelSelected 获取）
  dap_usage?: number;   // 钉钉 API 调用次数（插件本地计数，字段名与模板一致）
  taskTime?: number;    // 任务耗时，秒（插件本地计时）
  inputTokens?: number; // 输入 token 数（含 cache，通过 llm_output hook 累加）
  outputTokens?: number;// 输出 token 数
  cacheRead?: number;   // 缓存命中读取的 token 数
  cacheWrite?: number;  // 写入缓存的 token 数
  totalTokens?: number; // 总 token 数
}

export interface CardBtn {
  text: string;
  color: string;
  status: string;
  event: {
    type: "openLink" | "sendCardRequest";
    params: Record<string, unknown>;
  };
}

/** streamAICard 传输的完整 payload */
export interface CardStreamPayload {
  blockList: CardBlock[];
  taskInfo: CardTaskInfo;
  hasAction: boolean;       // 默认 false，隐藏按钮
  content: string;          // fallback 文本（内部保留，暂不推送钉钉）
  hasQuote: boolean;        // 是否有引用消息
  quoteContent?: string;    // 引用消息内容
  btns: CardBtn[];          // 按钮列表（当前为空）
}
```

### Session 状态类型（`src/session-state.ts` 新文件）

```typescript
export interface SessionState {
  model?: string;           // 当前模型名
  effort?: string;          // 思维链深度
  taskStartTime: number;    // 任务开始时间戳
  dapiCount: number;        // 钉钉 API 调用计数
}
```

存储方式：内存 `Map<string, SessionState>`，key 为 `accountId:conversationId`，不持久化。

---

## blockList 与类型映射

| type 值 | 含义 | 模板渲染组件 | 关键字段 | 说明 |
|---------|------|-------------|---------|------|
| 0 | answer | `MarkdownBlock` (isStreaming=true) | `.markdown` | 流式 markdown 富文本 |
| 1 | think | `BaseText` | `.text` | 思考过程，普通文本 |
| 2 | tool | `BaseText` | `.text` | 工具执行结果，普通文本 |
| 3 | image | `Image` | `.mediaId` | 图片，需钉钉 mediaId |
| 4 | approval | `ButtonGroup` | `.btns` | 审核交互按钮组（无图片） |
| 5 | topic | `Grid`/`Tag` | `.text` | 主题标签 |

所有六种 type 均进入同一个 `blockList` 数组，按到达顺序排列（支持交错）。模板通过 `item.type == N` 数字比较做条件渲染，选择不同的 UI 组件。

---

## 模板条件渲染设计

V2 模板的 `Loop` 子组件需要根据 `type` 字段做条件渲染。模板变量 schema 定义：

```json
{
  "name": "blockList",
  "type": "loopArray",
  "schema": [
    { "name": "type", "type": "number" },
    { "name": "text", "type": "string" },
    { "name": "markdown", "type": "markdown" },
    { "name": "mediaId", "type": "string" }
  ]
}
```

Loop 内部组件结构（伪代码，需在钉钉卡片搭建器中配置）：

```
Loop → blockList
  ├─ MarkdownBlock(content=${item.markdown}, isStreaming=true)
  │     visible: type == 0        // answer: 流式富文本
  │
  ├─ BaseText(text=${item.text}, style=引用样式)
  │     visible: type == 1        // think: 普通文本
  │
  ├─ BaseText(text=${item.text}, style=引用样式)
  │     visible: type == 2        // tool: 普通文本
  │
  └─ Image(mediaId=${item.mediaId})
  │     visible: type == 3        // image: 钉钉图片
  │
  ├─ ButtonGroup(btns=${item.btns})
  │     visible: type == 4        // approval: 审核交互按钮组
  │
  └─ Grid/Tag(text=${item.text})
        visible: type == 5        // topic: 主题标签
```

> **注意**：钉钉卡片模板的条件渲染通过组件的 `visible` 属性绑定表达式实现（如 `type == 0`）。已通过模板 JSON 确认支持数字比较。think 和 tool 各自一个 BaseText 实例，便于差异化样式。

---

## 图片 block 处理流程

### mediaId 获取

type=3 (IMAGE) block 需要 `mediaId`。获取流程：

```
1. Agent 返回图片 URL 或本地路径 (mediaUrl/mediaPath)
2. 如果是远程 URL: prepareMediaInput() 下载到临时文件
3. uploadMedia(config, localPath, "image", getAccessToken, log) → { mediaId }
4. 构造 CardBlock: { type: 3, text: "图片描述", markdown: "", mediaId: "xxx" }
5. push 到 blockList，触发流式推送
```

### 现有 uploadMedia 能力

| 来源 | 能力 | 代码位置 |
|------|------|---------|
| 本地文件路径 | 已有 | `readMediaBuffer()` → direct fs |
| sandbox/container 路径 | 已有 | `rt.media.loadWebMedia()` bridge |
| 远程 URL | 已有 | `prepareMediaInput()` 下载到临时文件 |
| 大小限制 | 已有 | 20MB (`FILE_SIZE_LIMITS.image`) |
| access_token | 已有 | `getAccessToken()` 自动刷新 |

`uploadMedia()` 位于 `src/media-utils.ts:692`，`src/send-service.ts` 中的 wrapper 已在生产环境使用。图片 block 可直接复用。

### mediaId 注意事项

- 钉钉 `media_id` 可复用，无明确过期时间
- 钉钉互动卡片 Image 组件**仅支持 mediaId**，不支持外部 URL
- 建议每次 image block 创建时重新上传以确保可用性（避免过期问题）
- 图片建议尺寸：宽 600px × 高 400px，宽高比 3:2

---

## 数据流

### 创建卡片（`createAndDeliver`）

通过 `cardParamMap` 一次性部署静态参数：

```typescript
cardParamMap = {
  config: JSON.stringify({ autoLayout: true, enableForward: true }),
  taskInfo: JSON.stringify({ model, effort }),
  hasQuote: String(hasQuote),
  quoteContent: quoteContent || "",
  btns: JSON.stringify([]),
  hasAction: "false",
}
```

### Streaming（`PUT /v1.0/card/streaming`）

推送 `blockList`：

```typescript
{
  outTrackId: card.outTrackId,
  guid: randomUUID(),
  key: "blockList",
  content: JSON.stringify(blockList),  // CardBlock[] 序列化
  isFull: true,
  isFinalize: finished,
  isError: false,
}
```

### 全量替换策略

每次流式推送发送**完整 blockList 数组**（`isFull=true`）：
- 已封存的 think/tool block 保持不变
- 正在流式的 answer block 更新 `.markdown` 字段
- 新的 image block 追加到数组末尾
- 幂等性保证：即使某次推送丢失，下一次包含完整状态

### Finalize

最后一次 streaming 调用推送最终 `blockList` 状态（`isFinalize=true`）。`content` 和 `taskInfo.taskTime` 作为 fallback 数据在内部保留。

---

## TimelineEntry → CardBlock 映射

| TimelineEntry.kind | CardBlock.type | text | markdown |
|--------------------|---------------|------|----------|
| thinking | `THINK` (1) | 完整内容 | 同 text |
| tool | `TOOL` (2) | 完整内容 | 同 text |
| answer | `ANSWER` (0) | 完整内容 | markdown 原文 |

图片不来自 TimelineEntry，来自 agent 返回的 `mediaUrl`/`mediaPath`，由 reply-strategy-card 在 `deliver()` 中处理。

---

## model 和 effort 采集

通过 OpenClaw runtime 的 `onModelSelected` callback 获取（`GetReplyOptions` 接口）：

```typescript
onModelSelected?: (ctx: {
    provider: string;
    model: string;
    thinkLevel: string | undefined;
}) => void;
```

在 callback 中更新 `SessionState`：

```typescript
onModelSelected: (ctx) => {
  updateSessionState(accountId, conversationId, {
    model: ctx.model,
    effort: ctx.thinkLevel,
  });
}
```

无需自行解析 `/model`、`/think` 命令文本，runtime 在模型选择时自动回调。

## 引用消息处理

- 回复入站消息时：`hasQuote=true`，`quoteContent=inbound.text`
- 主动发送消息时：`hasQuote=false`
- `failedImage` 字段忽略

## 钉钉 API 调用计数（dapi_usage）

计入 `dapi_usage` 的 API：

| API | 计入 |
|-----|------|
| `createAndDeliver`（创建卡片） | yes |
| `PUT /v1.0/card/streaming`（streaming 更新） | yes |
| `sendBySession`（session webhook 发送） | yes |
| `sendMessage`（markdown/text 发送） | yes |
| `getAccessToken`（获取 token） | no |
| `downloadMedia`（入站媒体下载） | no |
| `uploadMedia`（上传图片获取 mediaId） | no |

## 按钮交互（btns）

当前不部署按钮行为，`hasAction=false` 隐藏所有按钮。预留动态部署按钮的能力，等后续 stop button 的 PR 合并后再启用。

## 配置变更

- 移除：`cardTemplateId`、`cardTemplateKey` 配置项
- 新增：`PRESET_CARD_TEMPLATE_ID` 内置常量
- 影响模块：`config.ts`、`onboarding.ts`、`types.ts`

---

## 模块变更清单

| 文件 | 变更内容 |
|------|---------|
| `src/types.ts` | 新增 `CardBlockType` 常量枚举、`CardBlock`（含 type/mediaId）、`CardTaskInfo`、`CardBtn`、`CardStreamPayload` 类型；新增 `PRESET_CARD_TEMPLATE_ID` 常量；移除 `cardTemplateId`/`cardTemplateKey` 配置字段 |
| `src/card/card-template.ts` | `contentKey` 改为 `blockListKey: "blockList"` 或增加 `streamingKey` 字段，支持 v2 流式推送 |
| `src/session-state.ts` **(新)** | `SessionState` 内存 Map 管理 + helper 方法 |
| `src/card-service.ts` | `createAICard` 使用 `PRESET_CARD_TEMPLATE_ID`；`createAndDeliver` 时通过 `cardParamMap` 部署静态参数（含 taskInfo）；`streamAICard` 改为推送 `blockList` key；集成 `dapiCount` 计数 |
| `src/card-draft-controller.ts` | `TimelineEntry[]` → `CardBlock[]`；新增 `getBlockList(): CardBlock[]`；`assemblePayload()` 组装 `CardStreamPayload`；新增 `appendImage(mediaId, text)` 方法 |
| `src/reply-strategy.ts` | `ReplyOptions` 新增 `onModelSelected` callback 类型 |
| `src/reply-strategy-card.ts` | 接入 `onModelSelected` 更新 session state；创建卡片时传递 `hasQuote`/`quoteContent`；`deliver()` 处理 `mediaUrls` 中的图片→uploadMedia→type=3 block；finalize 时组装 `taskInfo` |
| `src/inbound-handler.ts` | 入站消息时初始化/复用 `SessionState`；记录 `taskStartTime` |
| `src/config.ts` | 移除 `cardTemplateId`/`cardTemplateKey` 配置解析 |
| `src/onboarding.ts` | 移除卡片模板配置引导步骤 |
| `src/media-utils.ts` | 无变更，`uploadMedia()` 已满足需求 |

---

## 与 V1 模板的对比

| 维度 | V1 (当前) | V2 (本次重构) |
|------|----------|-------------|
| 流式 key | `"content"` | `"blockList"` |
| 内容格式 | 单一 markdown 字符串 | `CardBlock[]` JSON 数组 |
| Block 类型 | 无区分（全部 markdown） | type 枚举：0/1/2/3/4/5 |
| 渲染方式 | 全部 MarkdownBlock | 条件渲染：MarkdownBlock / BaseText / Image / ButtonGroup |
| think/tool 显示 | markdown 引用块 | BaseText 普通文本（更轻量） |
| 图片支持 | markdown 内嵌 `![](url)`（可能不渲染） | 独立 Image block，mediaId 原生图片 |
| 模板变量 | `content`, `flowStatus` | `blockList`, `taskInfo`, `hasQuote`, `quoteContent`, `btns`, `hasAction` |
| 元数据展示 | 无 | model / effort / taskTime / dapi_usage |
| 引用展示 | 无 | 独立引用区 + 分割线 |
| 配置 | 用户自定义 templateId | 预置固定模板 |

---

## 风险与待定项

### 需要验证

1. **模板条件渲染**：钉钉卡片搭建器是否支持 `type == 0` 这种数字比较表达式作为 visible 条件。如果不支持，可能需要改为布尔字段（如 `isAnswer`, `isThink`, `isTool`, `isImage`）或字符串比较（`type == "0"`）。
2. **Image 组件 mediaId 字段名**：需要确认钉钉卡片 Image 组件接受变量名为 `mediaId` 还是其他字段名（如 `imgUrl`、`picURL`）。可通过搭建器 mock 验证。
3. **blockList 序列化大小**：长对话中 blockList 可能包含大量 block，需要关注 JSON.stringify 后是否超出 streaming API 的 content 长度限制。
4. **Loop 组件多子节点条件渲染性能**：同一 Loop 项内放置 4 个组件（3 个隐藏），钉钉客户端渲染性能是否可接受。

### 已知约束

- 钉钉互动卡片 Image 组件**仅支持 mediaId**，不支持外部 URL
- `media_id` 通过 `POST /media/upload` 获取，已在我们 `uploadMedia()` 中实现
- 图片建议尺寸 600×400px，宽高比 3:2

---

## 向后兼容

- 这是一个 breaking change：使用旧版自定义 `cardTemplateId` 的用户需要迁移到预置模板
- `messageType: "card"` 模式下的用户无感知变化（配置项移除不影响功能）
- `messageType: "markdown"` 模式不受影响
- card degrade 机制（降级到 markdown 发送）继续生效
