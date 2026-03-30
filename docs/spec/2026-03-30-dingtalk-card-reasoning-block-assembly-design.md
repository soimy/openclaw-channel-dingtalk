# DingTalk Card Reasoning Block Assembly Design

**日期：** 2026-03-30  
**状态：** 已在对话中确认  
**范围：** DingTalk card 模式下 `/reasoning on` 与 `/reasoning stream` 的 think 展示收敛

## 背景

当前 DingTalk card 链路对 reasoning 的处理存在两个明显问题：

- `/reasoning on`
  - 上游 OpenClaw 会把 reasoning 作为独立 block reply 下发，并带 `isReasoning: true`
  - 但 DingTalk card strategy 当前固定 `disableBlockStreaming: true`
  - 即使后续能收到 block，`deliver(kind: "block")` 也只处理 media，不消费文本 block
  - 结果是 `/reasoning on` 的 think 在 card 模式下实际上没有稳定展示路径

- `/reasoning stream`
  - 当前 card strategy 直接把 `onReasoningStream` 的 thinking 文本送进 `CardDraftController.updateThinking()`
  - 上游 reasoning stream 频率可能很高，容易造成卡片 API 过快消耗
  - 结合 `draft-stream-loop` throttle 与钉钉卡片控件的渲染节奏，用户可能看到残缺、不完整的思考块

同时，产品目标也已经在对话中明确：

- `/reasoning on` 需要成为 card 下主要可见的 think 展示路径之一
- `/reasoning on` 与 `/reasoning stream` 在 card 下应尽量统一为同一种展示语义
- `/reasoning stream` 不应因为是 stream 就更早展示半截内容
- reasoning / tool 的主要价值是给用户工作进程反馈，但 answer 仍然更重要

## 设计目标

- 让 card 模式稳定覆盖 `/reasoning on` 的 think 展示
- 将 `/reasoning on` 与 `/reasoning stream` 收敛到同一种“think block”时间线语义
- 不再按上游原始 reasoning stream 频率直接刷新卡片
- 仅在识别到完整 think block 时推进卡片流式更新
- 当 tool / answer / finalize 边界到来时，将尚未封口的 pending think 作为最后一个块落入时间线，避免直接丢失接近完成的进度反馈
- 保持 answer 仍然是时间线中的最重要正文，不为 think 展示牺牲最终答复稳定性

## 非目标

- 不改 markdown reply strategy
- 不改 DingTalk `send-service.ts` 发送协议
- 不改 `card-service.ts` 的 create / stream / finish API
- 不追求对所有未来 reasoning 文本格式做通用解析器
- 不在本次设计中引入新的卡片模板字段
- 不改变 `/verbose on` 的 tool 事件来源与语义

## 用户体验定义

### 统一展示语义

无论来源是 `/reasoning on` 还是 `/reasoning stream`，card 模式下的 think 展示都统一为：

- 以完整 think block 为单位进入卡片时间线
- 一个 think block 一旦进入时间线，就视为 sealed process block
- 后续 reasoning 更新不回写或替换已经发出的旧 block
- tool / answer 继续沿用现有单时间线展示模型

这意味着：

- `/reasoning stream` 不再表现为“每个 token 都推一次卡片”
- `/reasoning on` 也不再依赖最终 answer 兜底才能让用户看到过程信息

### think block 触发时机

正常流式阶段：

- 只有当缓存中的 reasoning 文本被识别为“完整 think block”时，才触发一次卡片更新

边界阶段：

- 当 `tool`、`answer partial`、`answer final` 或 `finalize()` 到来时
- 如果此前仍有尚未封口的 pending reasoning
- 则将其作为“最后一个 think block”强制落入时间线后，再继续后续 tool / answer

这个规则的目的不是保留每一个半成品 token，而是避免在明显的流程边界前把接近完整的 thinking 全部丢掉。

### 边界强制落块的显示策略

边界强制落块时，采用“最小清洗”：

- 去掉顶层 `Reasoning:` 前缀
- 尽量去掉明显未闭合的 `_` 包裹痕迹
- 不凭空补写内容
- 不重排语义

如果无法可靠恢复结构，则保留尽可能接近原文的正文文本，而不是尝试智能重写。

## 输入格式与完整块识别

根据当前真实数据特征，本次实现第一版只基于两类稳定信号识别 think block：

1. `Reason:` 段头
2. reasoning 正文被 `_..._` 包裹

### 当前数据形态

OpenClaw 现有 `formatReasoningMessage()` 会把 reasoning 格式化为：

```md
Reasoning:
_Reason: ..._
_..._
```

因此 assembler 的职责不是重新定义 reasoning 文本，而是：

- 把来自上游的 formatted reasoning 文本规范化
- 从中提取出一个或多个完整 think block
- 生成更适合 card timeline 消费的“纯正文块”

### 第一版完整块规则

assembler 对单个 snapshot 使用保守规则：

- 必须先出现一个 `Reason:` 起始行
- 从该 `Reason:` 开始，连续收集被 `_` 包裹的 reasoning 行
- 只有当该块形成完整、可闭合的 reasoning 区段时，才视为完整块
- 完整块之间按顺序依次发出

如果 snapshot 中只出现了：

- 裸的 `Reason:` 但正文还未闭合
- 只有 `_` 开头但未闭合
- 前缀漂移导致当前块无法稳定切分

则正常流式阶段先继续缓存，不立即更新卡片。

## 事件模型

### reasoning 输入来源

两种 reasoning 来源都先进入统一 assembler：

- `onReasoningStream(payload.text)`
  - 来源于 `/reasoning stream`
  - 输入通常是截至当前的完整 formatted reasoning snapshot，而不是纯增量 token

- `deliver(kind: "block", isReasoning: true, text)`
  - 来源于 `/reasoning on`
  - 输入是一个 reasoning block reply

### assembler 输出

assembler 只向 card strategy 暴露两类动作：

- `ingestSnapshot(text)`：
  - 输入新的 reasoning snapshot
  - 返回零个或多个新完成的 think blocks

- `flushPendingAtBoundary()`：
  - 在 tool / answer / finalize 边界调用
  - 若 pending 中存在可展示正文，则作为最后一个 think block 返回
  - 同时清空 pending

### 卡片时间线消费

card strategy 不再直接把 reasoning stream 文本喂给 `updateThinking(replace)`。

改为：

1. reasoning 输入先交给 assembler
2. assembler 一旦产出完整 think block
3. card strategy 再把该 block 交给 controller 作为 sealed thinking block 追加到时间线

这样可以把“高频 stream token”与“卡片可见块更新”解耦。

## 模块设计

### `src/card/reasoning-block-assembler.ts`

新增 card 领域模块。

职责：

- 接收 reasoning snapshots
- 维护已消费游标与 pending 文本
- 规范化 `Reasoning:` / `_..._` 格式
- 识别完整 think blocks
- 在边界阶段强制落出 pending block

不负责：

- 卡片发送
- 时间线渲染
- tool / answer 的顺序决策

### `src/reply-strategy-card.ts`

职责调整为：

- 注册并接收两种 reasoning 来源
- 把 reasoning 输入交给 assembler
- 将 assembler 产出的 think blocks 追加到 controller
- 在 tool / answer / final 边界调用 assembler 的 flush 接口

同时需要补足两个现有缺口：

- 接住 `/reasoning on` 的 reasoning block
- 停止把 `/reasoning stream` 原始频率直接映射到卡片刷新

### `src/card-draft-controller.ts`

controller 继续负责：

- 单时间线状态维护
- 节流与单飞发送
- 最终卡片渲染

但 reasoning 入口语义要收紧：

- 保留现有 `updateReasoning / updateThinking` 兼容 API
- 新增一个更明确的“sealed thinking block append”入口
- reply strategy 在新的主路径里优先使用 sealed block append，而不是 live replace

这样 controller 就不用负责理解 `Reason:`、`_..._` 等来源格式。

### `src/inbound-handler.ts` 与 `src/reply-strategy.ts`

需要把上游 reasoning block 元信息透传下来。

当前 `DeliverPayload` 只有：

- `text`
- `mediaUrls`
- `kind`

本次需要补充 reasoning 标识，例如：

- `isReasoning?: boolean`

使得 card strategy 能区分：

- 普通 `block` 文本
- `/reasoning on` 的 reasoning block

## 状态规则

### 正常 reasoning 输入

- 新 snapshot 到来时：
  - 先规范化输入文本
  - 再从未消费区域扫描完整 think blocks
  - 每识别出一个完整块就立即交给 controller 追加
  - 仍未构成完整块的尾部继续保留为 pending

### tool 边界

- `deliver(kind: "tool")` 到来前：
  - 先调用 `flushPendingAtBoundary()`
  - 若返回 think block，则先追加到时间线
  - 再追加 tool block

### answer 边界

- `onPartialReply` 或 `deliver(kind: "final")` 到来前：
  - 同样先 flush pending reasoning
  - 再进入 answer 路径

### finalize 边界

- `finalize()` 前：
  - 先 flush 一次 pending reasoning
  - 再按既有规则完成卡片收尾

## 风险与折中

### 1. 完整块规则可能与真机格式不完全一致

这是可接受的第一版折中。

原因：

- 当前目标是先把明显错误的高频卡片刷写收紧
- 以及补齐 `/reasoning on` 缺失的显示路径
- 规则以当前真机可观察的 `Reason:` 与 `_..._` 结构为基准，后续可以通过真机验证继续收敛

### 2. 边界强制落块仍可能出现“非完美格式”

这是有意识的选择。

原因：

- 用户已明确表示，边界前的信息若未封口，直接发送比完全丢弃更好
- 但不应该为了“看起来更完整”去伪造 reasoning 内容

因此本次只做最小清洗，不做内容补写。

### 3. 旧的 reasoning replace 语义会被弱化

这也是有意识的收紧。

card 下 reasoning 的目标不再是“token 级实时草稿”，而是“块级过程反馈”。

## 测试策略

本次实现至少需要三层测试：

### 1. assembler 单测

覆盖：

- `/reasoning stream` snapshot 连续增长时，只有完整块才 emit
- 一个 snapshot 含多个 think blocks 时按顺序 emit
- `/reasoning on` 的 block reasoning 也走同一组装路径
- tool / answer / finalize 边界会把 pending 块强制落出
- 已消费区域不会重复 emit

### 2. card strategy 单测

覆盖：

- `onReasoningStream` 不再每次直接驱动卡片更新
- `deliver(block, isReasoning=true)` 能进入 reasoning assembler
- tool / answer / final 到来时先 flush reasoning，再继续后续时间线

### 3. inbound-handler 端到端回归

覆盖：

- `/reasoning on` card 路径最终可见 think + answer
- `/reasoning stream` card 路径按块更新，而不是按每次 stream 回调更新
- `cardRealTimeStream=false` 时，finalize 仍保留完整时间线

## 预期结果

完成后，DingTalk card 模式下的 reasoning 表现将变为：

- `/reasoning on`：稳定显示 think blocks
- `/reasoning stream`：仍然可以更早提供过程反馈，但只在完整块级别更新，不再推高频半成品
- tool / answer 继续维持现有单时间线结构
- 卡片 API 消耗与渲染抖动风险都低于当前实现
