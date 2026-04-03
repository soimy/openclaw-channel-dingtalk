# DingTalk Card Reasoning and Answer Split Design

**日期：** 2026-04-02  
**状态：** 已在对话中确认  
**范围：** DingTalk card 模式下 `/reasoning on` 的真实 answer 获取与 timeline 对齐

## 背景

当前 DingTalk card 链路已经有单 timeline 架构：

- `thinking`
- `tool`
- `answer`

但 `/reasoning on` 在真机下仍然拿不到稳定的真实 answer。现象是：

- 只能在 `deliver(kind="block")` 中看到原始 `Reasoning:` / `Reason:` 文本
- 无法像 Telegram 那样把 reasoning 与 answer 分成两条明确 lane
- 当上游没有显式 `isReasoning` 元信息时，DingTalk 会把整段文本当成 answer 或直接错过 answer

根因不是钉钉 transport，而是当前 DingTalk 插件对 OpenClaw reasoning 合同的假设不成立：

- `/reasoning on`
  - 主要依赖消息结束时的 reasoning block 与 final answer
  - generic dispatch path 会 suppress `isReasoning === true` 的 reasoning block
  - 并不保证 reasoning 一定通过 `onReasoningStream(...)` 进入下游
- `/reasoning stream`
  - 才稳定走 `onReasoningStream(...)`

因此 DingTalk 不能像 Feishu 那样只依赖 reasoning callback，也不能像当前实现这样假设 reasoning-on 会稳定下发显式 reasoning block。

## 设计目标

- 让 DingTalk card timeline 能在 `/reasoning on` 下稳定恢复真实 answer
- 保持当前 card timeline 的语义边界：
  - `thinking` 进入 thinking block
  - `tool` 进入 tool block
  - `answer` 进入 answer block
- 优先信任显式 reasoning 信号：
  - `onReasoningStream(...)`
  - `payload.isReasoning === true`
- 当上游没有显式 reasoning 元信息，但 delivered text 本身带有明确 `Reasoning:` / thinking tag 时，做插件内文本拆分兜底
- 不把 DingTalk 变成 Telegram 完整双-lane preview 架构

## 非目标

- 不改 markdown reply strategy 的 reasoning 展示策略
- 不复制 Telegram 的 draft stream / preview lifecycle
- 不修改上游 OpenClaw runtime 契约
- 不把所有“长得像推理”的中文过程文本都自动识别成 reasoning
- 不新增新的卡片模板字段

## 方案选择

本次选用：

- **显式 callback / metadata 优先**
- **Telegram 式文本拆分作为 DingTalk card 本地兜底**

不选纯 Feishu 式方案，原因是：

- `onReasoningStream(...)` 只稳定覆盖 `/reasoning stream`
- `/reasoning on` 在 generic dispatch path 下并不保证 reasoning block 能完整穿透到插件
- 仅靠 callback 无法解释当前真机里只看到 `Reason:` block、拿不到真实 answer 的现象

不选完整 Telegram lane 方案，原因是：

- DingTalk 当前没有 Telegram 那套双 preview lane 交付能力
- 当前仓库已经有一条单 timeline controller，继续复用更稳

## 核心设计

### 1. 在 card strategy 中增加“reasoning/answer split”适配层

新增一个 DingTalk card 本地拆分器，职责是把单段 delivered text 解释成：

- `reasoningText`
- `answerText`

拆分规则分三档：

1. 显式 reasoning metadata
   - `payload.isReasoning === true`
   - 全量进入 thinking lane
2. 显式 reasoning callback
   - `onReasoningStream(...)`
   - 继续走现有 reasoning assembler
3. 文本兜底拆分
   - 当 block/final 文本内包含：
     - `Reasoning:\n...`
     - `<think>...</think>` / `<thinking>...</thinking>`
   - 参考 Telegram 的 `splitTelegramReasoningText(...)` 做保守拆分
   - reasoning 部分进入 thinking lane
   - 剩余正文进入 answer lane

只有在能稳定识别顶层 reasoning 包装时才拆分。无法稳定判断时，保持原样作为 answer。

### 2. 保持 card timeline controller 不变，只喂语义化输入

`CardDraftController` 继续作为唯一 timeline 聚合器，不新增第二套 answer 缓冲区。

strategy 只负责把事件翻译成 controller 可消费的语义操作：

- `appendThinkingBlock(...)`
- `appendTool(...)`
- `updateAnswer(...)`

这样能够保持现有单 timeline 渲染、节流与 finalize 行为不变。

### 3. `deliver(block)` 和 `deliver(final)` 都做 split

这是本次修复的关键。

当前问题并不只发生在 block 阶段，final 阶段也可能收到：

- reasoning-only final
- reasoning + answer mixed final
- answer-only final

因此策略应统一为：

- `block`
  - 先按显式 metadata / callback / 文本兜底拆分
  - reasoning 落 thinking
  - answer 落 answer
- `final`
  - 先 flush pending reasoning
  - 再对 final text 做同样的 split
  - 仅将 answer 部分记为 final answer fallback

这样即使 `/reasoning on` 的真实 answer 只出现在 final 里，或 reasoning/answer 混在一段文本里，也能进入正确 timeline。

### 4. 拆分器边界

拆分器只识别两类稳定形态：

- `Reasoning:\n_..._`
- 顶层 thinking tags

它不负责：

- 把“分步思考如下”这种普通 prose 强行提升为 reasoning
- 解析 tool 文本
- 重写 markdown 结构

这条边界与当前仓库“显式 reasoning 优先”的方向一致，只是补一个对 `/reasoning on` 真机形态必需的兜底层。

## 预期数据流

### `/reasoning stream`

1. `onReasoningStream(...)`
2. `reasoning-block-assembler`
3. `appendThinkingBlock(...)`
4. `onPartialReply(...)`
5. `updateAnswer(...)`
6. `deliver(final)`
7. final answer 覆盖最后一个 answer snapshot

### `/reasoning on`

1. runtime deliver `block` / `final`
2. DingTalk card strategy 对 delivered text 做 split
3. reasoning 部分进入 thinking lane
4. answer 部分进入 answer lane
5. finalize 基于 timeline 输出最终卡片

## 兼容性

- 保持 markdown strategy 现状不变
- 保持现有 `reasoning-block-assembler` 对显式 reasoning stream 的消费不变
- 保持 `cardRealTimeStream` 仅控制 answer partial preview，不让它成为 reasoning-on 的必要条件
- 保持现有 `deliver(block)` answer fallback 能力，但把 mixed reasoning/answer 情况纠正到语义正确的 timeline

## 验证重点

- `reply-strategy-card`：
  - mixed block/final 文本能拆成 thinking + answer
  - reasoning-only 文本不会污染 answer lane
  - answer-only 文本保持现有行为
- `inbound-handler`：
  - card + `/reasoning on` 下，即使没有 `onReasoningStream(...)`，仍能从 delivered text 恢复真实 answer
- 回归：
  - `/reasoning stream` 现有 assembler 行为不退化
  - markdown mode 行为不变
