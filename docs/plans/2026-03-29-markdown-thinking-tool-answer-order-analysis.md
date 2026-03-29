# Markdown 模式下 thinking/tool/answer 消息发送顺序评估

**日期：** 2026-03-29  
**分支：** `fix/verbose-stream-reroute`  
**目的：** 补齐当前 verbose stream / 单时间线工作中，对 markdown 模式下 `thinking` / `tool` / `answer` 可见发送顺序的评估。

## 结论摘要

当前插件实现里，markdown 模式没有自己的 `thinking/tool/answer` 时间线。

- 插件层只会在 `final` 阶段发送文本消息。
- `thinking` 不会被插件主动发送成独立消息。
- `tool` 文本不会被插件主动发送成独立消息。
- 如果同一个 `final` payload 里既有文本又有媒体，当前顺序是“先媒体，后文本”。
- 如果最终文本过长被分片，`send-service` 会按分片顺序依次发送。

因此，就插件本身可确认的行为而言，markdown 模式下用户最终看到的顺序通常不是：

1. thinking
2. tool
3. answer

而是更接近：

1. 可选的媒体消息
2. 最终 answer 文本

如果上游 runtime 在 `disableBlockStreaming=true` 时会把 earlier `thinking/tool` 聚合进最终 `payload.text`，那它们只会以内嵌文本形式出现在最终 answer 里，而不是由插件按事件顺序单独发三条消息。这个聚合行为在本仓库内不可见，所以这里只能标注为推断边界，不能当成已确认事实。

## 已确认的插件层事实

### 1. `inbound-handler` 只是把 runtime payload 转交给 strategy

`src/inbound-handler.ts` 中，所有 reply payload 都统一进入 `strategy.deliver(...)`，并把 `info.kind` 映射为 `block | tool | final`。

这意味着 markdown/card 的差异，不在 `inbound-handler`，而在 reply strategy 自身。  
见：`src/inbound-handler.ts:1831-1872`

### 2. markdown strategy 明确关闭 block streaming，且不注册任何流式回调

`createMarkdownReplyStrategy()` 的 `getReplyOptions()` 只返回：

```ts
{ disableBlockStreaming: true }
```

没有：

- `onPartialReply`
- `onReasoningStream`
- `onAssistantMessageStart`

这说明 markdown 模式不会像 card 模式那样消费 reasoning stream，也不会在插件侧维护多轮 answer 流。  
见：`src/reply-strategy-markdown.ts:17-18`  
也被单测锁定：`tests/unit/reply-strategy-markdown.test.ts:36-42`

### 3. markdown strategy 只在 `deliver(final)` 发送文本

`createMarkdownReplyStrategy().deliver(...)` 的行为非常直接：

- 先处理 `payload.mediaUrls`
- 只有 `payload.kind === "final"` 且 `payload.text` 非空时才调用 `sendMessage(...)`
- `block` 和 `tool` 文本都被静默忽略

见：`src/reply-strategy-markdown.ts:21-40`

对应单测：

- `deliver(block) is silently ignored`
- `deliver(tool) is silently ignored`
- `deliver(final) sends text via sendMessage`

见：`tests/unit/reply-strategy-markdown.test.ts:45-83`

### 4. markdown 模式下如果同一个 final payload 里同时带文本和媒体，会先发媒体再发文本

`reply-strategy-markdown.ts` 里先执行：

```ts
await ctx.deliverMedia(payload.mediaUrls);
```

然后才可能执行：

```ts
await sendMessage(...payload.text...)
```

因此只要同一个 `deliver(final)` 同时带文本和媒体，顺序就是“媒体优先”。  
这点也被 `inbound-handler` 集成测试锁定。测试期望先有一条空文本的媒体发送，再有一条 `"final output"` 文本发送。  
见：`tests/unit/inbound-handler.test.ts:3692-3752`

### 5. 真正通过 session webhook 发文本时，会顺序发送 markdown 分片

`sendBySession()` 在文本分支会：

- 对最终文本做 markdown/title 判定
- 按 `splitMarkdownChunks(...)` 分片
- 按数组顺序逐片发送

也就是说，如果最终 answer 很长，用户看到的是：

1. 第 1 片
2. 第 2 片
3. ...

而不是一次性单条。  
见：`src/send-service.ts:533-564`

## 对 `thinking/tool/answer` 顺序的具体评估

### 场景 A：runtime 真的逐事件吐出 `thinking -> tool -> final`

如果 runtime 像 card 模式测试里那样，依次触发：

1. `onReasoningStream({ text: ... })`
2. `deliver(..., { kind: "tool" })`
3. `deliver(..., { kind: "final" })`

那么在 markdown strategy 下：

- 第 1 步没有对应回调，插件不会发送 thinking 文本
- 第 2 步会进入 `deliver(tool)`，但被静默忽略
- 第 3 步才会真正发最终文本

所以用户可见顺序仍然只有最终消息。

这也是为什么当前实现下，markdown 模式并不存在 card 那种“过程块时间线”。

### 场景 B：runtime 在 `disableBlockStreaming=true` 时自行缓冲，再只给一个 final text

这是另一个可能路径，也是最值得注意的边界：

- 由于 markdown strategy 把 `disableBlockStreaming` 设为 `true`
- 上游 runtime 可能因此把 thinking/tool/partial answer 在内部聚合
- 最后只吐一个 `deliver(final)` 的 `payload.text`

如果真是这样，那么用户看到的顺序仍然不是三条独立消息，而是“一条最终文本”，其内部是否包含 thinking/tool 文本完全取决于 runtime 的拼装规则。

本仓库里没有 `dispatchReplyWithBufferedBlockDispatcher` 的真实实现，只有 mock，因此这里不能把聚合格式当成已确认事实。

### 场景 C：final payload 同时带文本和附件

当前插件会先发附件，再发最终文本。  
所以用户可见顺序是：

1. 文件/图片/音视频
2. answer 文本

这与 card 模式“正文先持续更新、附件独立发送”的体验不同。  
见：`tests/unit/inbound-handler.test.ts:3692-3752`

### 场景 D：只有 tool，没有 final text

markdown strategy 不会发送 tool 文本，也没有 finalize 阶段补发兜底文本。

所以如果 runtime 最终没有给出可发送的 `final.text`，而只有 `tool` 事件：

- 插件不会为 markdown 模式补一条“工具执行结果”
- 最终用户可能什么文本都看不到，只可能看到独立媒体发送

这和 card 模式明显不同。card 模式会在 finalize 时用渲染时间线或 file-only 占位收尾。  
见对比：`src/reply-strategy-card.ts:67-169`

## 现有测试里的一个命名陷阱

`tests/unit/inbound-handler.test.ts` 里有一个测试名叫：

`handleDingTalkMessage runs non-card flow and sends thinking + final outputs`

但这个测试实际上只断言“最终确实调用了 `sendMessage`”，并没有证明 markdown 模式会把 thinking 和 final 作为两条独立可见消息发出去。  
见：`tests/unit/inbound-handler.test.ts:1913-1954`

所以这个测试名称容易让人误读成“markdown 模式也有 thinking 可见输出”，但当前实现并不支持这个语义。

## 对后续设计的含义

如果这条分支的目标只是把 card 模式改成单时间线，那么 markdown 模式当前可以维持现状，因为两者本来就不是同一种显示模型。

但如果目标是让 `/verbose on` 在 markdown 模式下也具备稳定、可预期的可见顺序，就需要单独做一层设计，至少在下面三种方案里选一个：

### 方案 1：维持现状

- markdown 继续只发最终 answer
- thinking/tool 是否出现在最终文本里，完全依赖 runtime 聚合

优点：

- 改动最小
- 不会把 markdown 发送链路复杂化

缺点：

- `/reasoning stream`、`/verbose on` 在 markdown 模式下的可见语义不清晰
- card 与 markdown 的行为差异大

### 方案 2：在插件侧为 markdown 新增轻量时间线缓冲

- 像 card controller 一样在插件侧接 reasoning/tool/final
- 最终把时间线渲染成单条 markdown 文本再发送

优点：

- card / markdown 的语义更接近
- thinking/tool/answer 顺序可由插件显式定义

缺点：

- 会把 markdown mode 从“单次 final send”升级成“显式缓冲器”
- 要重新确认与 runtime `disableBlockStreaming` 的职责边界

### 方案 3：明确依赖 runtime 聚合，并把 contract 文档化

- 插件继续保持简单
- 在文档中明确：markdown 模式下，thinking/tool 是否进入最终文本由 runtime 决定

优点：

- 责任边界最清晰
- 插件改动最小

缺点：

- 需要上游 contract 足够稳定
- 当前本仓库内无法自证这一行为

## 当前更稳妥的建议

对这条 `fix/verbose-stream-reroute` 分支，建议先把 markdown 模式定义成：

- **插件不保证 thinking/tool 逐条可见发送**
- **插件只保证 final answer 的最终发送**
- **如果 final 同时带媒体，则顺序为先媒体、后文本**

也就是说，这条分支当前更适合把“卡片时间线一致性”作为主目标，而不要顺手把 markdown 模式也默认为“天然具备同样时间线语义”。

如果后续确实需要 markdown 模式对齐 card 的 thinking/tool/answer 体验，再开一个单独设计，把“是否由插件缓冲时间线”这个问题讲清楚会更稳。
