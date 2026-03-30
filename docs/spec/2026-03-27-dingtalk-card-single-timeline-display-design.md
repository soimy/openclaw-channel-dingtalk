# DingTalk AI Card 单时间线显示流重构设计

**日期：** 2026-03-27  
**状态：** 已在对话中确认  
**范围：** DingTalk AI Card 模式下的 thinking / tool / answer 显示流  

## 背景

当前 DingTalk AI Card 显示链路混合了三套不同语义：

- `thinking` 通过 `onReasoningStream` 进入 `CardDraftController`，按 replace 语义预览
- `tool` 通过 `deliver(kind: "tool")` 进入 `sendMessage(... cardUpdateMode: "append")`，按 append 语义追加
- `answer` 通过 `onPartialReply` / `deliver(kind: "final")` 进入答案预览与最终收尾逻辑

这会带来几个问题：

- thinking 和 tool 不是同一种显示模型，难以维护
- 工具执行显示依赖单独的 append 支路，容易产生时序竞态和语义分裂
- `verboseRealtimeStream` 这类本地配置与上游 `/verbose on` 的会话级语义冲突
- `cardRealTimeStream` 同时承担“传输节奏”和“部分显示语义”，职责不清
- `ackReaction` 与卡片正文显示流语义纠缠风险增加

## 设计目标

- 将 AI Card 正文统一为单时间线显示
- 将 `thinking` 与 `tool` 统一建模为同级“过程事件”
- 保留最终 `answer` 作为同一时间线中的结果正文，但视觉上弱化过程噪音
- 让 `/reasoning stream` 与 `/verbose on` 继续作为上游会话级显示开关
- 让 `ackReaction` 继续作为独立于正文的外层“处理中状态灯”
- 让 `cardRealTimeStream` 只控制传输节奏，不控制显示语义
- 消除 tool append 专用发送路径，统一由单一控制器重渲染整张卡片

## 非目标

- 不改变 DingTalk `emotion/reply` / `emotion/recall` 的 ackReaction 机制
- 不改变上游 runtime 如何决定是否发出 reasoning/tool 事件
- 不在本次设计中引入新的 UI 模板字段或多列卡片布局
- 不重新设计 markdown 模式下的显示行为

## 用户体验定义

AI Card 正文采用“单时间线 + 两类块”的模型：

- `process` 块：包括 `thinking` 和 `tool`
- `answer` 块：包括最终回复正文

时间线规则：

1. `thinking` 和 `tool` 都按发生顺序进入同一条正文时间线
2. 已进入时间线的过程块在最终收尾时保留，不被抹掉
3. `answer` 始终位于时间线末尾，作为主要可读正文
4. `ackReaction` 独立存在，不受 `/reasoning`、`/verbose` 开关影响

显示格式规则：

- `thinking` 使用标题 `🤔 思考`
- `tool` 使用标题 `🛠 工具`
- `thinking` 与 `tool` 的正文内容逐行渲染为 markdown 引用块
- `answer` 不使用引用块，直接渲染为正常 markdown 正文

示例渲染：

```md
🤔 思考
> 我先检查一下这个分支的改动范围。

🛠 工具
> git diff 显示主要改动集中在 reply strategy 和 draft controller。

这里是最终回复正文。它保留在同一时间线中，但不使用引用块，以便与过程信息区分。
```

## 开关语义

### 会话级显示开关

- `/reasoning stream`
  - 由上游 runtime 决定是否调用 `replyOptions.onReasoningStream`
  - 插件只负责消费事件，不负责解析命令状态

- `/verbose on`
  - 由上游 runtime 决定是否发出 `deliver(..., { kind: "tool" })`
  - 插件只负责消费事件，不负责解析命令状态

### 插件级传输开关

- `cardRealTimeStream`
  - 仅表示 AI Card 流式刷新的节奏与 throttle 策略
  - 不表示是否显示 `thinking`
  - 不表示是否显示 `tool`

### 独立状态灯

- `ackReaction`
  - 继续作为独立于正文的原消息 reaction 指示灯
  - 不参与 AI Card 正文拼装
  - 不受 `/reasoning`、`/verbose` 的正文显示开关影响
  - 在 `emoji` / `kaomoji` 模式下仍可基于 runtime tool 事件动态切换 reaction

### 废弃项

- 删除 `verboseRealtimeStream`
  - 它与 `/verbose on` 的会话级语义冲突
  - 不应在插件内部引入第二套 tool 显示开关

## 事件模型

插件内部统一使用单一时间线事件流：

- `process:thinking`
  - 思考过程快照
  - 同一活跃 thinking 块内为 replace 语义

- `process:tool`
  - 工具执行结果
  - 每个 tool 结果生成一个独立的已完成过程块

- `answer`
  - 回答正文快照
  - 当前 assistant turn 内为 replace 语义

- `assistantTurnStart`
  - 表示新的 assistant 回合开始
  - 常见于 tool 调用后继续输出 answer

## 模块设计

### `reply-strategy-card.ts`

职责调整为“事件接线层”：

- `onReasoningStream` -> `timelineController.updateThinking(text)`
- `deliver(kind: "tool")` -> `timelineController.appendTool(text)`
- `onAssistantMessageStart` -> `timelineController.startAssistantTurn()`
- `onPartialReply` -> `timelineController.updateAnswer(text)`
- `deliver(kind: "final")` -> 记录 fallback 所需原始最终文本或媒体，不再负责 tool append

不再保留：

- verbose 模式下的专用 tool reroute 分支
- `sendMessage(... cardUpdateMode: "append")` 作为 card tool 显示主路径

### `card-draft-controller.ts`

建议逻辑上重构为时间线控制器，可在第一阶段保留现有文件名，避免额外 churn。

控制器职责：

- 接收统一事件
- 维护时间线状态
- 将完整正文重新渲染为单个字符串
- 通过既有 `draft-stream-loop` 做 throttle / single-flight / flush
- 调用 `streamAICard(..., isFull=true)` 全量覆盖更新

### `draft-stream-loop.ts`

保持不变，继续作为底层节流与 single-flight 原语。

### `card-service.ts`

保持发送层职责：

- `streamAICard`
- `finishAICard`

不承担时间线状态管理。

### `send-service.ts`

第一阶段不必立即删掉 card append 支持，但 card reply path 不再调用它。待没有调用点后，再清理 `cardUpdateMode: "append"` 相关分支。

## 时间线状态设计

控制器内部维护以下状态：

- `processBlocks[]`
  - 已定稿的过程块
  - 每项包含：
    - `kind: "thinking" | "tool"`
    - `text: string`

- `liveThinkingBlock`
  - 当前活跃的 thinking 块
  - 后续 reasoning 更新替换其内容

- `answerTurns[]`
  - 多轮 assistant answer 的累积结果
  - 每轮保留最新 answer 快照

- `renderedContent`
  - 最近一次实际发送到 AI Card 的完整正文

## 状态转换规则

### Thinking

- `updateThinking(text)`
  - 若为空则忽略
  - 若当前存在活跃 thinking 块，则替换内容
  - 若当前不存在活跃 thinking 块，则创建新的活跃 thinking 块
  - 不直接追加到 `processBlocks[]`

### Tool

- `appendTool(text)`
  - 若存在活跃 thinking 块，先封口并推入 `processBlocks[]`
  - 将当前 tool 内容作为独立 process block 推入 `processBlocks[]`
  - tool block 为定稿块，不做 replace

### Answer

- `updateAnswer(text)`
  - 若存在活跃 thinking 块，先封口并推入 `processBlocks[]`
  - 更新当前 assistant turn 的 answer 快照
  - 渲染时 answer 总是出现在所有 process blocks 之后

### Assistant turn

- `startAssistantTurn()`
  - 结束当前 answer turn
  - 后续 answer 更新进入新的一轮
  - 已有 answer turn 内容继续保留，用于最终拼接

## 渲染策略

每次事件进入后，控制器都重新渲染完整正文。

渲染顺序：

1. `processBlocks[]`
2. `liveThinkingBlock`（如果存在）
3. 当前累计 answer

格式化规则：

- `thinking`
  - 标题行：`🤔 思考`
  - 内容行：逐行加 `> `

- `tool`
  - 标题行：`🛠 工具`
  - 内容行：逐行加 `> `

- `answer`
  - 正常 markdown 正文
  - 不加引用块

分段规则：

- 块与块之间插入空行
- 空内容块不渲染

## 最终收尾规则

- `finalize()` 使用“完整时间线渲染结果”作为最终卡片内容，而不是仅取最后 answer
- 若存在 `answer`，最终定稿内容为：
  - 全部过程块
  - 最终 answer

- 若是 file-only 等没有 answer 文本的场景：
  - 不建议只保留过程块
  - 不建议直接使用 `✅ Done`
  - 推荐补一个简短 answer，例如“附件已发送，请查收。”

## 错误回退策略

若 AI Card 流式失败并降级到 markdown：

- fallback 文本应使用“当前已渲染的完整时间线”
- 不仅发送最后 answer
- 这样用户在 card 失败时仍能看到已经展示过的过程链

## 兼容与迁移

### 第一阶段

- 保留 `card-draft-controller.ts` 文件名
- 内部改造成时间线控制器
- `reply-strategy-card.ts` 停止调用 card append 专用路径
- 移除 `verboseRealtimeStream` 配置、类型与文档

### 第二阶段

- 清理 `send-service.ts` 中 card append 分支
- 如有必要，再将控制器文件重命名为 `card-timeline-controller.ts`

## 测试策略

### 控制器单测

- thinking 多次更新只替换当前 thinking block
- tool 每次都追加一个独立 process block
- answer 流式更新只替换当前 answer 块
- `assistantTurnStart` 后 answer 多轮累计正确
- 渲染结果中 process 块全部使用引用 block

### Reply strategy 单测

- `deliver(kind: "tool")` 不再调用 `sendMessage(... cardUpdateMode: "append")`
- `onReasoningStream`、`deliver(tool)`、`onPartialReply` 均汇入同一控制器
- finalize 使用完整时间线，而非最后 answer 单值

### Inbound 集成测试

- `/reasoning off` 时没有 thinking block，但 answer 正常
- `/verbose off` 时没有 tool block，但 answer 正常
- `/reasoning off + /verbose off` 时仅显示 answer
- `ackReaction` 仍然独立 attach / recall / dynamic switch

### 回归测试

- file-only response
- multi-turn answer
- card stream fail -> markdown fallback
- group / direct card finalize

## 预期收益

- 消除 thinking / tool / answer 三套显示语义分裂
- 让卡片显示更接近用户对“工作链”的直觉
- 消除 tool append 专用竞态与覆盖问题
- 保持 `ackReaction` 的独立状态灯定位
- 让会话级命令与插件内部职责边界更清晰
