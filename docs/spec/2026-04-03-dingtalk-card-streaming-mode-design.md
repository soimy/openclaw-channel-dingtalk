# DingTalk Card Streaming Mode Design

**日期：** 2026-04-03  
**状态：** 已在对话中确认  
**范围：** DingTalk card 模式下的流式配置收敛、timeline 事件治理与 API 调用最小化

## 背景

当前 DingTalk card 链路已经有单 timeline 架构，但卡片流式展示配置正在出现新的职责重叠：

- 旧配置 `cardRealTimeStream`
  - 主要控制 answer partial preview
  - 用户认知上容易被理解为“整张卡是否真流式”
- 新配置 `cardStreamReasoning`
  - 主要控制 reasoning 是否实时进入卡片
  - 进一步引入了“answer 实时”和“reasoning 实时”两个分离布尔语义

这会带来三个问题：

1. 配置认知分裂
   - 用户需要同时理解 answer realtime 与 reasoning realtime 两条轴
   - 配置组合数变多，但大多数用户并不关心内部 lane 细节
2. 代码职责分裂
   - `reply-strategy-card.ts` 同时处理：
     - 配置兼容
     - reasoning/answer/tool 事件判断
     - 卡片更新时间机
   - 后续很难继续做“少调用 DingTalk API”的系统性优化
3. 运行时边界不够清晰
   - `/reasoning on` 下 think 可能混在 block/final 文本里
   - 上游有时会先发 `final`，随后才把迟到的 think/tool 补齐
   - 如果插件过早把 `final` 当作绝对终点，就会丢过程信息

本次设计的目标不是再增加一个局部 patch，而是把：

- 配置模型
- 事件归一化
- timeline 状态机
- DingTalk API 最小化策略

收敛成同一套可解释的规则。

## 设计目标

- 用单一配置 `cardStreamingMode` 取代分裂的布尔语义
- 保持 DingTalk card 的单 timeline 展示模型：
  - `thinking`
  - `tool`
  - `answer`
- 明确 `off | answer | all` 三种模式的真实含义
- 保留 `/reasoning on` 的本地文本拆分兜底，不依赖上游一定提供显式 reasoning lane
- 保留“`final` 先到，但迟到的 think/tool 仍可补进 timeline”的兼容能力
- 明确“最终答案一旦确定，late answer 不再覆盖”的边界
- 尽量减少 DingTalk 服务器 API 调用：
  - 节流
  - latest-wins
  - 内容级去重
  - 边界统一 flush

## 非目标

- 不修改 markdown reply strategy
- 不修改 DingTalk `card-service.ts` 的 create / stream / finish 基础协议
- 不修改上游 OpenClaw runtime 契约
- 不把普通中文 prose 自动识别成 reasoning
- 不把 `tool` 伪装成 token 级实时流
- 不为卡片引入新的模板字段

## 方案选择

本次考虑三种方案：

### 方案 1：兼容包裹

- 新增 `cardStreamingMode`
- 内部继续保留 `cardRealTimeStream + cardStreamReasoning`
- 通过配置映射驱动旧实现

优点：

- 改动最小
- 回归风险低

缺点：

- 内部语义继续分裂
- 后续难统一优化 API 调用次数

### 方案 2：枚举直驱

- 内部直接改成 `cardStreamingMode`
- 仍主要沿用当前零散分支判断

优点：

- 配置层干净
- 代码可读性比双布尔更好

缺点：

- 刷新时机仍然分散在多个入口
- 难以稳定落实“timeline 正确”和“API 最小化”

### 方案 3：枚举驱动 + timeline 策略层

本次选用方案 3。

做法是把 card strategy 分成两层：

1. 事件归一化层
   - 负责把上游 runtime 的各种入口统一翻译成内部 timeline 事件
2. streaming policy 层
   - 负责根据 `cardStreamingMode` 决定：
     - 哪些事件只写入本地 timeline
     - 哪些事件需要触发 DingTalk 卡片更新

选用原因：

- 用户只需要理解 `off | answer | all`
- 插件仍能完整接住 think/tool/answer 三类事件
- “显示语义”与“发送节奏”解耦，后续更容易继续优化

## 配置设计

### 新配置

新增：

- `cardStreamingMode: "off" | "answer" | "all"`

默认值：

- `off`

保留：

- `cardStreamInterval`
  - 作为统一节流间隔
  - 用于所有允许实时刷新的路径

废弃：

- `cardRealTimeStream`
  - 标记 deprecated
  - 仅用于兼容旧配置

移除公开配置：

- `cardStreamReasoning`

### 配置优先级

运行时解析顺序：

1. 若显式设置了 `cardStreamingMode`
   - 永远优先使用它
2. 否则若 `cardRealTimeStream === true`
   - 兼容映射为 `cardStreamingMode = "all"`
3. 其他情况
   - 落到 `cardStreamingMode = "off"`

### 兼容日志

当且仅当：

- 用户未显式设置 `cardStreamingMode`
- 但设置了旧配置 `cardRealTimeStream`

插件输出一次 deprecation warning，提示应迁移到 `cardStreamingMode`。

## 事件归一化

当前上游进入 DingTalk card strategy 的运行时入口主要有：

- `onReasoningStream(...)`
- `onPartialReply(...)`
- `onAssistantMessageStart(...)`
- `deliver(kind="tool")`
- `deliver(kind="block")`
- `deliver(kind="final")`

插件内部不再直接以“入口名字”驱动卡片更新，而是统一转换为以下内部事件：

### 1. `thinking_snapshot`

表示正在增长的 think 快照。

来源：

- `onReasoningStream(...)`
- `deliver(..., isReasoning === true)`
- `deliver(block|final)` 经本地 split 后得到的 reasoning 部分

### 2. `thinking_block`

表示一个完整或边界封口后的 think 块，应该作为稳定 process block 进入 timeline。

来源：

- reasoning assembler 产出完整块
- 或在边界阶段强制 flush pending thinking

### 3. `tool_block`

表示一个独立 tool 结果块。

来源：

- `deliver(kind="tool")`

### 4. `answer_snapshot`

表示当前 answer 的最新快照。

来源：

- `onPartialReply(...)`
- `deliver(block|final)` 经本地 split 后得到的 answer 部分

### 本地 reasoning split 边界

对 `/reasoning on` 的本地拆分仍然保留，且维持保守边界：

- 识别顶层 `Reasoning:` 前缀
- 后面必须跟一行或多行 `_..._`
- 或识别顶层 `<think>` / `<thinking>` 标签

例如：

```md
Reasoning:
_Reason: 先检查当前目录_

最终答案：/tmp
```

会被解释为：

- 一个 `thinking_block`
- 一个 `answer_snapshot`

但以下内容不应自动拆分为 reasoning：

- 只是“分步思考如下”的普通 prose
- 嵌在结构化 markdown 正文里的 `Reasoning:` 小节
- tool 文本

## Timeline 状态机

本次将 card strategy 的内部状态明确为三段：

### `open`

正常接收并处理：

- `thinking_snapshot`
- `thinking_block`
- `tool_block`
- `answer_snapshot`

### `final_seen`

表示已经收到第一个 `deliver(kind="final")`，但尚未真正 `finishAICard(...)`。

这个状态必须保留，原因是实测中上游有时会：

1. 先发 `final`
2. 随后才把迟到的 think/tool 补齐

因此 `final_seen` 阶段的规则是：

- 继续接受 late `thinking_snapshot`
- 继续接受 late `thinking_block`
- 继续接受 late `tool_block`
- 不再接受会修改最终答案的 late `answer_snapshot`
- 继续接受 late `answer` block / final payload，并用它们刷新冻结中的最终答案

也就是说：

- 允许“补过程”
- 不允许“late partial snapshot 改写定稿 answer”
- 允许“late block / final answer 补齐或替换定稿 answer”

### `sealed`

`finishAICard(...)` 成功后进入终态。

后续所有事件均忽略。

## 三种模式的刷新语义

timeline 始终维护完整语义，但 DingTalk 卡片 API 是否立即刷新，取决于 `cardStreamingMode`。

### `off`

- `thinking_snapshot`
  - 只缓存，不发 API
- `thinking_block`
  - 进入 timeline，并刷新一次卡片
- `tool_block`
  - 进入 timeline，并刷新一次卡片
- `answer_snapshot`
  - 只更新本地 answer 快照，不发 API
- `finalize`
  - 统一 flush 后调用 `finishAICard(...)`

用户感知：

- 过程块会在“完整块形成”时出现
- answer 不会以 token/partial 方式持续刷新

### `answer`

- `thinking_snapshot`
  - 只缓存，不发 API
- `thinking_block`
  - 进入 timeline，并刷新一次卡片
- `tool_block`
  - 进入 timeline，并刷新一次卡片
- `answer_snapshot`
  - 允许实时刷新，但要经过统一 throttle
- `finalize`
  - 统一 flush 后调用 `finishAICard(...)`

用户感知：

- 过程块仍以 block 为单位出现
- 最终回答会更快地持续更新

### `all`

- `thinking_snapshot`
  - 允许实时刷新，并经过统一 throttle
- `thinking_block`
  - 作为 sealed process block 进入 timeline
  - 如果封口后的渲染结果与当前 live 内容一致，则不额外发送
- `tool_block`
  - 进入 timeline，并刷新一次卡片
- `answer_snapshot`
  - 允许实时刷新，并经过统一 throttle
- `finalize`
  - 统一 flush 后调用 `finishAICard(...)`

用户感知：

- think 与 answer 都可实时变化
- tool 仍以离散块方式出现

## API 调用最小化策略

本次不以“少收事件”为优化目标，而以“少发无意义卡片更新”为目标。

### 1. 统一节流

- 所有允许实时刷新的路径统一使用 `cardStreamInterval`
- 不再把 reasoning 与 answer 分配到不同公开节流配置

### 2. latest-wins

- 高频 `thinking_snapshot` / `answer_snapshot` 只保留最新内容
- 由现有 draft stream loop 继续承担单飞与 latest-wins 语义

### 3. 内容级去重

新增规则：

- 若本次渲染后的整张卡片内容与“上次已发送内容”相同
- 则直接跳过，不发送 DingTalk stream API

这用于避免：

- 边界 flush 后重复发送相同卡片
- late process merge 后再次生成相同正文

### 4. 边界优先 flush

以下事件到来前，应先强制收口 pending thinking：

- `tool_block`
- 新 assistant turn
- `final`
- `finalize()`

目的：

- 避免悬空 reasoning snapshot 与新块交错
- 让 think/tool/answer 的先后顺序在 timeline 中稳定可解释

### 5. final 前统一收口

在真正 `finishAICard(...)` 前，必须：

1. flush pending thinking
2. flush pending answer snapshot
3. wait for in-flight throttled updates
4. 生成最终 timeline 文本
5. 再调用 `finishAICard(...)`

## 模块改造落点

### `src/config-schema.ts` / `src/types.ts`

- 新增 `cardStreamingMode`
- 标记 `cardRealTimeStream` deprecated
- 删除公开的 `cardStreamReasoning`
- 保留 `cardStreamInterval`
- 增加配置兼容解析辅助逻辑

### `src/reply-strategy-card.ts`

作为本次主改造点，负责：

- 统一解析 streaming policy
- 将上游入口归一化为内部事件
- 落实 `open / final_seen / sealed` 状态机
- 根据 `off | answer | all` 决定刷新时机
- 继续保留本地 reasoning split 兜底

### `src/card-draft-controller.ts`

继续只负责：

- 单 timeline 渲染
- 节流发送
- 最终正文生成

补充：

- 内容级去重保护

不把复杂配置策略继续下沉到 controller。

### `src/card/reasoning-answer-split.ts`

- 保持现有稳定字符特征拆分主体
- 明确其识别边界
- 不扩大为泛化的“智能推理识别器”

## 验证重点

### 配置兼容

- `cardStreamingMode` 显式优先
- 未设置 `cardStreamingMode` 时：
  - `cardRealTimeStream=true -> all`
  - 其他情况 -> off
- deprecation warning 只输出一次

### `reply-strategy-card`

- `off`：
  - think/tool 以 block 为单位更新
  - answer 不做 partial live
- `answer`：
  - answer partial 实时刷新
  - think/tool 保持 block 语义
- `all`：
  - think + answer 都可实时刷新
- `final_seen`：
  - late think/tool 仍可补进 timeline
  - late answer 不再覆盖最终答案
- mixed block/final 仍可拆成 thinking + answer

### `card-draft-controller`

- 相同渲染内容不会重复发送 stream API
- in-flight + throttle 下仍保持 latest-wins

### 集成回归

- `/reasoning stream`
  - 行为不退化
- `/reasoning on`
  - 即使没有显式 reasoning block lane，也能正确恢复 think + answer
- tool 后继续 answer 的多 turn 场景
- file-only final / empty final / fallback finalize 场景
- markdown mode 不受影响

## 结论

本次设计将 DingTalk card 的流式展示从“多布尔开关 + 局部分支”收敛为：

- 一个面向用户的枚举配置
- 一套统一的 timeline 事件模型
- 一个允许 late process、但冻结 late answer 的状态机
- 一组面向 DingTalk API 最小调用的稳定策略

这样既保留当前真机验证中必须的兼容性，又为后续继续优化卡片更新次数和行为一致性打下清晰边界。
