# DingTalk Reasoning 链路、`disableBlockStreaming` 契约与 Telegram 对齐记录

**日期：** 2026-04-02  
**状态：** 讨论结论沉淀，供后续实现与 review 使用  
**范围：**

- 当前 DingTalk 插件在 `/reasoning off|on|stream` 下的消息链路
- `disableBlockStreaming` 向上游 runtime 传递的契约语义
- 与上游 `openclaw` 仓库 Telegram 通道消息链路的对齐关系
- 后续收口方向：继续缩小插件边界，避免 transcript 型兜底

## 1. 本文目的

这份文档用于回答三个问题：

1. DingTalk 当前到底怎样消费上游 reply-runtime 的 partial / block / final / reasoning 事件
2. `disableBlockStreaming=true` 什么时候需要传给上游，原因是什么
3. 如果要和上游 Telegram 通道对齐，应该对齐到哪一层，哪些实现细节不应该照搬

本文只总结当前确认过的代码事实与讨论结论，不把未实现方案写成既定行为。

## 2. DingTalk 当前链路总览

### 2.1 入口与模式选择

在 `src/inbound-handler.ts` 中，DingTalk 会先根据是否启用卡片决定 reply mode：

- `markdown`
- `card`

然后读取当前 session 的 `reasoningLevel`，再调用：

- `shouldDisableBlockStreamingForReplyMode(...)`

当前规则是：

- `markdown`
  - `/reasoning on` 或 `/reasoning stream` 时，`disableBlockStreaming=true`
- `card`
  - 只有 `/reasoning on` 时，`disableBlockStreaming=false`
  - 其他情况都是 `true`

对应当前仓库代码：

- `src/inbound-handler.ts`
- `src/reply-strategy.ts`
- `src/reply-strategy-markdown.ts`
- `src/reply-strategy-card.ts`

### 2.2 当前 PR 的 reasoning 边界

当前 follow-up PR 的核心收口是：

- 插件不再根据“文本长得像 reasoning”来猜测 think
- 只承认两类显式 reasoning 信号：
  - `onReasoningStream(...)`
  - `payload.isReasoning === true`

这意味着：

- `partial` 文本如果没有显式 reasoning 信号，就按 answer 处理
- `block/final` 文本如果没有显式 reasoning 信号，也按 answer 处理
- `Reasoning:`、`分步思考过程`、`推理过程如下` 这类文本外观，不再自动触发 reasoning lane

这条边界是本次 PR 的主线，后续收口不应破坏它。

### 2.3 Card 模式当前链路

在 `src/reply-strategy-card.ts` 里，当前逻辑可以概括为：

1. `onPartialReply`
   - 仅在 `cardRealTimeStream=true` 时注册
   - 用来更新 answer draft
2. `onReasoningStream`
   - 进入 `reasoning-block-assembler`
   - 只消费显式 reasoning stream
3. `deliver(kind="block", isReasoning=true)`
   - 也进入 reasoning assembler
4. `deliver(kind="block" | "final", isReasoning!=true)`
   - 作为 answer 文本处理
5. `finalize()`
   - 以当前 card timeline 为基础出最终卡片内容
   - 不再依赖 transcript 型 final-answer fallback

### 2.4 Markdown 模式当前链路

`src/reply-strategy-markdown.ts` 侧更简单：

- 只关心最终要发出去的 answer / tool / media
- 不维护独立 reasoning draft lane
- `disableBlockStreaming` 更多是在告诉上游 runtime：
  - 不要把一串零碎 block 直接推给当前 markdown 通路
  - 尽量由上游缓冲/聚合，再以更稳定的形式下发

## 3. `disableBlockStreaming` 的契约语义

### 3.1 它不等于“不要流式”

`disableBlockStreaming` 不是一个“全局禁止流式输出”的总开关。

它表达的是更具体的契约：

- 当前下游通路不希望把 generic block lane 当作主交付面
- 如果上游有更适合的 callback 通道，应优先走专用通道
- 如果上游可以缓冲/聚合 block，再变成稳定结果交给下游，那更符合当前通路的消费模型

换句话说，它控制的是：

- generic `block` 事件流是否应被当作主要 reply delivery 形态

而不是：

- answer 是否允许有 draft
- reasoning 是否允许有专用 stream
- final 是否允许正常下发

### 3.2 当前 DingTalk 为什么要向上游传这个契约

### Markdown 模式

`markdown` 模式下，插件没有 Telegram 那种专用 preview lane，也没有本地 reasoning draft 控制器。

因此当 session 在：

- `/reasoning on`
- `/reasoning stream`

时，向上游传 `disableBlockStreaming=true` 的目的，是避免：

- 零碎 block 直接映射成多条钉钉 markdown 消息
- answer / tool / reasoning 顺序和聚合边界变得不可控

这里本质上是在告诉 runtime：

- 当前通路不适合把 generic block 逐块直接外露

### Card 模式

`card` 模式下情况更细：

- answer draft 由 `onPartialReply` 承担
- reasoning stream 由 `onReasoningStream` 承担
- 显式 reasoning block 由 `deliver(..., isReasoning=true)` 承担

所以在这些场景里，generic block lane 并不是主链路。

只有 `card + /reasoning on` 是例外：

- 这个模式需要接住上游显式 reasoning block
- 所以这里会把 `disableBlockStreaming` 放开为 `false`

当前 DingTalk 的意图不是“尽量多收 block”，而是：

- 只在确实需要显式 reasoning block 的模式下，允许上游按 block lane 发下来

### 3.3 后续语义收口点

当前讨论后的最终结论是：

- `disableBlockStreaming=true` 既然已经向上游表达了“generic block lane 不是主交付面”
- 插件本地应该继续优先依赖更明确的 callback / final 链路

但这不等于本次 PR 要取消 answer block 的兜底。

本轮已确认的边界是：

- 保持“只承认显式 reasoning 信号”的主线不变
- 保留现有 answer block 兜底行为
- 不在这次 follow-up 中继续收紧 answer block 的实时消费语义

原因是：

- 这个兜底行为处理的是 answer 可见性，不是 reasoning 扩大化识别
- 当前更优先要解决的是插件继续越界依赖 transcript 与私有 debug sink 的问题
- answer block 是否进一步改成“只聚合、不实时展示”，留到后续单独 PR 再讨论

## 4. 上游 runtime 契约位置

以下路径相对上游 `openclaw` 仓库根目录：

- `src/auto-reply/reply/get-reply-directives.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`
- `src/auto-reply/reply/provider-dispatcher.ts`

### 4.1 `disableBlockStreaming` 如何进入 runtime

`provider-dispatcher.ts` 本身只是转发层，真正决定 block streaming 的地方在：

- `get-reply-directives.ts`

当前可确认的行为：

- `opts.disableBlockStreaming === true` 时，runtime 把 `resolvedBlockStreaming` 视为 `off`
- `opts.disableBlockStreaming === false` 时，runtime 把 `resolvedBlockStreaming` 视为 `on`

这说明：

- DingTalk 插件传的不是“建议值”
- 而是一个会改变 reply-runtime block streaming 解析结果的明确契约

### 4.2 runtime 如何把事件下放给通道

在 `agent-runner-execution.ts` 中，上游会把不同通道下放到 reply options：

- `onPartialReply`
- `onAssistantMessageStart`
- `onReasoningStream`

这意味着当前设计上，reply-runtime 已经把：

- answer partial
- assistant turn boundary
- reasoning stream

拆成了不同 callback。

因此从契约层看，DingTalk 后续要继续收口，最合理的方向是：

- 优先消费这些“语义明确”的 callback
- 少依赖 generic block lane 和 transcript 外部状态

## 5. 与上游 Telegram 链路的对齐

以下路径相对上游 `openclaw` 仓库根目录：

- `extensions/telegram/src/bot-message-dispatch.ts`
- `extensions/telegram/src/reasoning-lane-coordinator.ts`
- `extensions/telegram/src/draft-stream.ts`

### 5.1 Telegram 的核心特点

Telegram 通道与 DingTalk 当前最大的不同是：

- 它有更完整的 preview / draft lane 体系
- answer lane 与 reasoning lane 是分开的
- 会在通道内做 lane 级别的状态协调

从 `bot-message-dispatch.ts` 可确认：

1. Telegram 会解析当前 `reasoningLevel`
   - `off`
   - `on`
   - `stream`
2. 它会分别决定：
   - `canStreamAnswerDraft`
   - `canStreamReasoningDraft`
3. 它会计算自己的 `disableBlockStreaming`
4. 它会同时注册：
   - `onPartialReply`
   - `onReasoningStream`
   - `onAssistantMessageStart`
   - `onReasoningEnd`

也就是说，Telegram 对齐的是一个“多 lane + 多 callback + 本地协调器”的模型。

### 5.2 Telegram 为什么仍然会做文本拆分

Telegram 的 `reasoning-lane-coordinator.ts` 里有一层文本拆分：

- `splitTelegramReasoningText(...)`

它会把一段文本拆成：

- `reasoningText`
- `answerText`

这里之所以还保留文本拆分，是因为 Telegram 自己有 dedicated reasoning lane / draft lane，需要把 reasoning preview 和 answer preview 分流到不同可视化通道。

这和当前 DingTalk follow-up PR 的目标不同：

- Telegram 的重点是“如何把 reasoning/answer 预览分别放进两个 lane”
- DingTalk 当前 PR 的重点是“插件不要越界猜测 reasoning 语义”

因此 Telegram 的文本拆分实现可以作为“能力上限”参考，但不应直接迁移到 DingTalk 当前 PR。

### 5.3 Telegram 当前对 `disableBlockStreaming` 的处理

Telegram 在 `bot-message-dispatch.ts` 中对 `disableBlockStreaming` 的决策更动态：

- 没有 preview streaming 时，直接 `true`
- `/reasoning on` 需要 block reasoning 时，转成 `false`
- 其他情况根据 account block streaming 和 draft lane 能力再决定

这和 DingTalk 当前讨论的契约意图是对齐的：

- 是否开放 generic block lane，取决于通道是否已经有更合适的专用 lane

### 5.4 对齐应发生在哪一层

后续与 Telegram 对齐，建议对齐在“契约层”和“lane 职责层”，而不是直接照搬实现细节。

更准确地说：

### 应该对齐的部分

- `disableBlockStreaming` 是对上游 runtime 的明确契约，而不是无意义布尔值
- answer partial、reasoning stream、assistant turn boundary 应优先走独立 callback
- 通道本地应该尽量少用 generic block 充当主交付面

### 不应直接照搬的部分

- Telegram 的文本式 reasoning 拆分器
- Telegram 的 preview draft lane 细节
- Telegram 为 lane 可视化而保留的缓冲/延迟策略

原因很简单：

- Telegram 有原生 preview/draft 交付形态
- DingTalk 当前没有对应的原生 reasoning draft lane
- 当前 DingTalk PR 的主线是“收紧插件边界”，不是“补齐一个 Telegram 等价的本地 lane 协调器”

## 6. transcript fallback 的最终结论

此前 DingTalk `card` 曾保留一个临时 fallback：

- 当已经出现 process block
- 但插件最终拿不到任何 answer 文本
- 会尝试从 transcript 里读取“最后一条 assistant text”作为 final answer 兜底

这条 fallback 不属于 reasoning 扩大化识别。

它解决的是另一个问题：

- 上游 runtime 某些情况下没有把 final answer 正常送到插件

但经过这轮讨论，当前更倾向的后续方向是：

- 如果没有稳定的“本轮 transcript 锚点”，插件不应继续依赖 transcript 兜底
- 插件应继续收紧边界，相信上游真实送达的消息链路
- 因此这次 follow-up 的实现决策是：删除 transcript final-answer fallback
- 后续如仍需兜底，应优先讨论 answer 聚合方式，而不是重新引入 transcript 读取

同时，本轮还确认：

- `plugin-debug` 属于临时诊断能力，不再继续留在这个 PR 中
- 插件侧全局 debug 能力稳定化，后续单独做一个 PR 处理

## 7. 当前讨论后的最终收口方向

以下是本轮讨论后已经确认的实现方向：

1. 保持 reasoning 边界不变

- 只承认：
  - `onReasoningStream`
  - `payload.isReasoning === true`
- 不恢复基于文本模式的 reasoning 猜测

2. 重新定义 answer 兜底方式

- 删除 transcript final-answer fallback
- 继续相信 runtime 真实送到插件的：
  - `partial`
  - `block`
  - `final`
- 保留现有 answer block 兜底行为，不在本轮继续收紧

3. 本地语义要和 `disableBlockStreaming` 契约更一致

- `disableBlockStreaming` 仍然作为向上游表达 generic block lane 语义的明确契约
- 但本轮不继续改变 answer block 的兜底实现
- 后续若要进一步收紧这部分行为，应单独开题，不与“显式 reasoning 边界”混做一轮

4. 删除 plugin-local `plugin-debug`

- 本轮删除 repo 内部的 `plugin-debug` 文件写入与 stdout 输出
- 后续插件侧全局 debug 能力稳定化单独做 PR

5. 与 Telegram 对齐时，对齐契约，不照搬实现

- 对齐：
  - multi-callback 语义分层
  - block streaming 契约
  - lane 职责边界
- 不直接照搬：
  - Telegram 的文本拆分 heuristics
  - Telegram 的 preview draft transport 细节

## 8. 供下一次跟进时优先重读的文件

### 本仓库

- `src/inbound-handler.ts`
- `src/reply-strategy-card.ts`
- `src/reply-strategy-markdown.ts`
- `src/card-draft-controller.ts`
- `docs/plans/2026-04-01-dingtalk-card-reasoning-on-handoff.md`

### 上游 `openclaw`

- `src/auto-reply/reply/get-reply-directives.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`
- `extensions/telegram/src/bot-message-dispatch.ts`
- `extensions/telegram/src/reasoning-lane-coordinator.ts`
- `extensions/telegram/src/draft-stream.ts`

## 9. 一句话结论

当前 DingTalk follow-up PR 的正确方向，不是把插件做得更“聪明”，而是把插件做得更“守边界”：

- reasoning 只信显式信号
- `disableBlockStreaming` 继续作为上游 runtime 契约
- answer block 兜底暂时保留，不和 reasoning 边界收口混在一轮改
- 不再继续向 transcript 这种外部状态借 final answer
- `plugin-debug` 从当前 PR 中移除，后续单独治理
- 与 Telegram 的对齐应发生在契约层，而不是直接复制其文本拆分与 draft lane 实现
