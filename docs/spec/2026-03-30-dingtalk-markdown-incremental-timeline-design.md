# DingTalk Markdown 增量时间线发送设计

**日期：** 2026-03-30  
**状态：** 已在对话中确认  
**范围：** DingTalk markdown 模式下的 thinking / tool / answer 增量段落发送  

## 背景

当前 DingTalk markdown 模式的 reply strategy 非常保守：

- `getReplyOptions()` 只返回 `disableBlockStreaming: true`
- 不注册 `onReasoningStream`
- 不注册 `onPartialReply`
- 不注册 `onAssistantMessageStart`
- 只在 `deliver(kind: "final")` 时发送文本
- `deliver(kind: "tool")` 会被静默忽略

这使得 markdown 模式与 card 模式的显示语义存在明显差异：

- card 模式已经围绕 timeline 语义推进
- markdown 模式仍然只有“最终消息发送”
- `/reasoning stream` 与 `/verbose on` 在 markdown 模式下没有稳定、明确的可见行为

上一轮分析已经确认当前实现边界：

- markdown 模式下，插件本身不保证 `thinking/tool` 的独立可见输出
- 若同一个 final payload 同时带媒体和文本，当前顺序为“先媒体、后文本”
- 上游 runtime 是否在 `disableBlockStreaming=true` 时聚合 `thinking/tool` 到最终文本，在本仓库内不可见

参考：

- `docs/plans/2026-03-29-markdown-thinking-tool-answer-order-analysis.md`

## 设计目标

- 让 markdown 模式消费 `thinking / tool / answer` 事件
- 用户看到的是“新增段落消息”，不是完整 timeline 快照反复重发
- `thinking` 与 `tool` 沿用 card timeline 的显示语义：
  - 过程块使用 markdown 引用块
  - `answer` 使用普通正文
- `answer` 在 partial 与 final 阶段都按增量尾巴发送
- `deliver(final)` 只补发尚未发送的尾巴，不重复整段 answer
- 仅最小化修改 markdown 链路，不改 card 相关模块

## 非目标

- 不改动 `src/card-draft-controller.ts`
- 不改动 `src/reply-strategy-card.ts`
- 不改动 `src/card-service.ts`
- 不抽取 card / markdown 共享 timeline core
- 不让 markdown 模式模拟 card 的整卡全量重渲染
- 不改变当前媒体发送链路的能力模型
- 不重新定义 ackReaction

## 用户体验定义

markdown 模式下，用户看到的是按事件逐步发出的独立消息：

1. `thinking` 增量段落
2. `tool` 独立过程块
3. `answer` 增量段落

这里的“时间线”是语义上的，而不是单条消息内的完整重渲染。

### thinking

- 以引用块发送
- 仅发送相对上次已发送 thinking 的新增尾巴
- 如果 runtime 后续给出的是覆盖改写而不是前缀增长，不补发“修正版旧内容”

示例：

```md
> 我先检查一下当前分支的改动范围。
```

### tool

- 每个 tool 结果独立发送一条新消息
- 使用引用块
- 不做 diff，不尝试与历史 tool 结果合并

示例：

```md
> git diff --stat
```

### answer

- partial reply 使用普通正文发送新增尾巴
- final reply 只补发还未发送的新增尾巴
- 不在 final 阶段重复补发完整 answer

示例：

```md
先看结论：
```

随后：

```md
主要改动集中在 reply strategy 和测试。
```

### mixed text + media

保持现状：

1. 先发送媒体
2. 再发送文本尾巴

原因是：

- 当前 webhook 媒体发送链路已经稳定
- 本次设计只改 markdown 文本增量发送语义，不改媒体发送能力模型

## 开关语义

### 事件来源

- `/reasoning stream`
  - 仍由上游 runtime 决定是否触发 `onReasoningStream`
  - 插件只消费事件

- `/verbose on`
  - 仍由上游 runtime 决定是否触发 `deliver(..., { kind: "tool" })`
  - 插件只消费事件

### markdown reply strategy

- markdown 模式不再只消费 `final`
- markdown 模式需要注册：
  - `onReasoningStream`
  - `onPartialReply`
  - `onAssistantMessageStart`

### `disableBlockStreaming`

本设计不把 markdown 模式建立在 runtime 缓冲所有中间事件再输出 final 的假设上。

因此 markdown strategy 应允许插件直接接收 reasoning / partial / tool 事件，而不是继续保持“只在 final 时发送文本”的封闭模型。

实现上，`disableBlockStreaming` 应调整为支持上述增量事件流的配置值；具体值以 runtime dispatcher 的契约为准，但目标语义必须是：

- `thinking/tool/partial answer` 能够到达 markdown strategy
- 插件侧自己决定如何把这些事件发送为独立 markdown 消息

## 事件模型

markdown strategy 内部沿用 card timeline 的语义分类，但不复用 card 模块实现：

- `process:thinking`
  - replace 语义
  - 只追踪当前活跃 thinking 文本

- `process:tool`
  - append 语义
  - 每次事件对应一条独立发送消息

- `answer`
  - replace 语义
  - 当前 assistant turn 内只发送新增尾巴

- `assistantTurnStart`
  - 清空当前 turn answer 的发送游标
  - 用于 tool 后继续回答的多轮场景

## 模块设计

### `reply-strategy-markdown.ts`

本次改造只在 markdown strategy 内部新增轻量状态，不新建共享模块。

职责：

- 注册 markdown 模式所需的流式回调
- 维护最小 timeline 状态
- 计算每类事件的“可发送增量段落”
- 通过现有 `sendMessage(..., { sessionWebhook })` 逐条发新消息

建议内部状态：

- `activeThinkingText`
- `lastSentThinkingText`
- `activeAnswerText`
- `lastSentAnswerText`
- `finalText`

建议内部辅助函数：

- `renderProcessSegment(kind, text): string`
- `computeIncrementalSuffix(previous, next): string`
- `sendMarkdownSegment(text): Promise<void>`

### `send-service.ts`

保持不变。

原因：

- 现有 `sendMessage` / `sendBySession` 已经能发送 markdown 文本
- 本次只改变“何时调用发送”，不改变“如何发送”

### `card-*` 模块

全部保持不变。

原因：

- 用户已明确要求仅最小修改 markdown 链路
- card timeline 正在独立演进，不应为了 markdown 复用而引入额外 churn

## 状态规则

### Thinking

- `onReasoningStream(text)`
  - 空文本忽略
  - 更新 `activeThinkingText`
  - 计算相对 `lastSentThinkingText` 的新增尾巴
  - 若存在新增尾巴，则发送一条引用块消息
  - 更新 `lastSentThinkingText`

约束：

- 仅当 `next` 以前缀增长方式包含 `previous` 时才发送尾巴
- 若是非前缀重写，返回空字符串，不补发旧内容修正版

### Tool

- `deliver(kind: "tool")`
  - 空文本忽略
  - 将文本作为独立过程块直接发送
  - thinking 视为封口
  - answer 当前 turn 视为结束前的独立阶段，但不强制追加额外汇总文本

### Answer

- `onPartialReply(text)`
  - 空文本忽略
  - 更新 `activeAnswerText`
  - 计算相对 `lastSentAnswerText` 的新增尾巴
  - 若存在尾巴，则发送普通正文消息
  - 更新 `lastSentAnswerText`

- `deliver(kind: "final")`
  - 记录 `finalText`
  - 若 final 比 `lastSentAnswerText` 多出尾巴，则只发送这一段
  - 若 final 与已发送 answer 等价，则不重复发送

### Assistant Turn

- `onAssistantMessageStart()`
  - 重置：
    - `activeAnswerText`
    - `lastSentAnswerText`
  - 不回收已发送消息
  - 使 tool 后的下一轮 answer 从空白重新开始增量

## 增量算法

核心规则：

- 仅支持“前缀增长”型增量
- 不支持编辑历史消息

推荐算法：

```ts
function computeIncrementalSuffix(previous: string, next: string): string {
  const prev = previous || "";
  const current = next || "";
  if (!current.trim()) {
    return "";
  }
  if (!prev) {
    return current;
  }
  if (!current.startsWith(prev)) {
    return "";
  }
  return current.slice(prev.length).trimStart();
}
```

说明：

- 这是一个保守策略
- 它优先避免重复和回写噪音
- 代价是 runtime 若发生“中间改写”，markdown 模式不会尝试修正先前已发消息

## 错误处理

- 任一增量段落发送失败，应中断本次 reply 流程并抛出错误
- 错误继续沿用当前 markdown strategy 的 `sendMessage(...).ok` 判定
- `abort()` 仍保持 no-op

这样可以保持 markdown 与当前错误语义一致：

- 发送失败即视为 reply 失败
- 不额外引入 markdown 模式专用恢复逻辑

## 测试策略

### `tests/unit/reply-strategy-markdown.test.ts`

新增或更新以下覆盖：

- `getReplyOptions()` 注册：
  - `onReasoningStream`
  - `onPartialReply`
  - `onAssistantMessageStart`
- thinking 连续增长时只发送新增尾巴
- thinking 非前缀重写时不重复补发
- tool 每次发送独立引用块
- partial answer 连续增长时只发送新增尾巴
- final 只补未发送尾巴
- final 与已发送 answer 相同则不重复发送
- `onAssistantMessageStart()` 后下一轮 answer 从头开始增量
- mixed media + final 仍保持先媒体后文本

### `tests/unit/inbound-handler.test.ts`

补最少量的端到端断言：

- markdown 模式下 reasoning / tool / partial / final 会触发多次 `sendMessage`
- 多轮 assistant turn 下第二轮 answer 会重新从头发送增量

## 兼容性与风险

### 优点

- 只改 markdown strategy，范围小
- 不影响 card 单时间线改造
- `/reasoning stream` 与 `/verbose on` 在 markdown 模式下获得明确可见语义

### 风险

- webhook 只能发新消息，不能改历史消息
- 若 runtime partial 文本不是前缀增长，用户看到的增量可能不完全等价于最终文本
- markdown 模式会比现在产生更多消息

### 取舍

这是一个刻意保守的最小改动方案：

- 优先获得稳定、可解释的增量发送行为
- 不尝试为 markdown 链路重建 card 那套完整控制器
- 不为了抽象复用去打扰 card 模块

## 实施边界

本次实现预计只触及：

- `src/reply-strategy-markdown.ts`
- `tests/unit/reply-strategy-markdown.test.ts`
- `tests/unit/inbound-handler.test.ts`
- `docs/spec/2026-03-30-dingtalk-markdown-incremental-timeline-design.md`
- 后续对应 plan 文档

明确不触及：

- `src/card-draft-controller.ts`
- `src/reply-strategy-card.ts`
- `src/card-service.ts`
- `src/draft-stream-loop.ts`

## 成功标准

满足以下条件即可视为完成：

1. markdown 模式能够消费 `thinking/tool/answer` 事件
2. 用户看到的是增量段落，而不是完整 timeline 快照重发
3. `deliver(final)` 不重复发送已经由 partial 发出的 answer 内容
4. process block 使用引用块，answer 使用普通正文
5. card 相关模块没有修改
