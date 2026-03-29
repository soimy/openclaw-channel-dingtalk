# DingTalk `quotedRef` 回溯与文档附件理解对齐 Discord 的落地方案

## Summary
在不修改上游 `openclaw` 的前提下，分两条链路收敛行为：

- 回复回溯对齐 Discord：DingTalk 入站优先使用当前事件自带的 `repliedMsg/quoteMessage` 作为“平台原生首跳 preview”，再结合本地 `message-context-store` 做稳定 ID 命中与多跳追链。这样首跳 `ReplyToBody` 不再完全依赖本地落盘命中，行为更接近 Discord 的 `referencedMessage`。
- 文档附件理解修正：当前轮用户直接发送的 PDF/DOCX 采用“上游优先”策略。插件侧不再把抽取全文拼进 `RawBody/CommandBody`，而是保留附件路径交给上游 `applyMediaUnderstanding()`；插件本地抽取只用于 quoted/history 回溯缓存与 fallback。

## Key Changes
### 1. Reply 回溯改为“事件 preview + 本地 store”双层解析
- 在消息提取层新增内部 `quotedPreview` 概念，从 `text.repliedMsg` / `quoteMessage` 生成首跳可读摘要。
- `quotedPreview` 的生成规则向 Discord `resolveDiscordMessageText()` 对齐：
  - 文本优先用正文。
  - `richText` 保留文字、`@name`、图片占位。
  - `picture/audio/video/file` 生成稳定占位，文件保留文件名。
  - `interactiveCard` 区分机器人卡片与文档卡，给出稳定可读占位。
  - 没有可读正文时才退回 `[Quoted <messageType>]`。
- `resolveQuotedRuntimeContext()` 的首跳正文优先级固定为：
  1. 本地 record 的最佳可读正文
  2. 当前入站事件的 `quotedPreview`
  3. 稳定占位文案
- 当本地 store 未命中但当前事件存在 `quotedPreview` 且 `quotedRef` 有稳定 `key/value` 时，仍然注入单跳 `ReplyToId` / `ReplyToBody` / `ReplyToSender` / `ReplyToIsQuote`。
- 多跳链继续仅依赖本地 `message-context-store`，不尝试从当前事件递归补链；`UntrustedContext` 仍只在链深度大于 1 时输出。
- `QuotedRef` / `QuotedRefJson` 继续透传，不改兼容面。

### 2. 本地消息记录补充“附件可读摘录”，用于 quoted/history，不用于当前轮正文
- 在内部消息记录中新增附件摘录元数据，建议最小结构为：
  - `attachmentText`
  - `attachmentTextSource`
  - `attachmentTextTruncated`
  - `attachmentFileName`
- 入站文件/文档消息下载成功后，继续调用本地 `extractAttachmentText()`，但结果不再拼入 `RawBody/CommandBody`；只写入消息记录，供之后引用回溯使用。
- 对 outbound 文档/文件类消息，持久化文本继续保留轻量摘要；如果未来插件侧能拿到文件名或抽取结果，也只进入消息记录，不进入当前轮正文。
- `resolveQuotedRuntimeContext()` 构造 hop body 时，正文来源统一改为“最佳可读正文”：
  - 普通文本记录用 `record.text`
  - 文档/文件记录优先使用 `attachmentText` 的 bounded excerpt
  - 都没有时才回退占位
- 第一跳 `ReplyToBody` 只保留单跳摘要；多跳里的文档 excerpt 仍进入链式 `UntrustedContext`。

### 3. 当前轮文档附件理解切到“上游优先”，去掉插件侧重复注入
- 直接收到 PDF/DOCX/文本类附件时：
  - 保留 `MediaPath` / `MediaType` / 文件名信息，让上游 `applyMediaUnderstanding()` 负责抽取正文并拼 `<file ...>` block。
  - `RawBody` / `CommandBody` 只保留当前用户正文与轻量附件占位，不再追加 `[附件内容摘录]` 全文。
- 插件侧本地抽取仅作为以下场景使用：
  - quoted 文档消息回溯
  - 历史链多跳回溯
  - 上游无法重新访问该旧附件时的 fallback
- 不改上游 runtime 的接口与字段名；修正点全部留在 DingTalk 插件内部。

### 4. 内部类型与边界
- 不改公共导出面；只扩展内部类型。
- `QuotedInfo` 可新增内部 preview 字段，建议包括：
  - `previewText`
  - `previewMessageType`
  - `previewFileName`
  - `previewSenderId`
- `MessageRecord` 扩展附件摘录字段，但不扩散到 `src/channel.ts` 的公共 API。
- 默认继续使用现有链路限制：
  - `maxDepth = 3`
  - 单 hop 正文上限 `1200`
  - 总链正文上限 `3600`
- 当前轮文档本地抽取仍沿用现有提取上限；只是存储到 record，不再进入用户正文。

## Test Plan
- Reply 回溯：
  - store 命中时，普通 inbound 文本回复仍写 `ReplyToBody`，`RawBody` 只等于当前消息。
  - store 未命中但 `repliedMsg` 有文本 preview 时，仍能写单跳 `ReplyTo*`，且不写链式 `UntrustedContext`。
  - `richText` preview 会保留 `@name` 与图片占位。
  - 回复 outbound 卡片时，`ReplyToId` 仍优先 `processQueryKey`，`ReplyToSender = "assistant"`。
  - `quotedRef` 只有 `fallbackCreatedAt` 且 store miss 时，不伪造 `ReplyToId`。
- 文档/文件回溯：
  - 文档消息下载并抽取成功时，摘录写入消息记录，但当前轮 `RawBody/CommandBody` 不含 `[附件内容摘录]`。
  - 引用已缓存的 PDF/DOCX 消息时，`ReplyToBody` 使用附件摘录摘要而不是泛化占位。
  - 多跳链中遇到文档节点时，`quotedChain[*].body` 使用 bounded excerpt。
- 当前轮附件理解：
  - 直接发送 PDF/DOCX 时，`MediaPath` / `MediaType` 继续传给上游，`RawBody/CommandBody` 不重复拼全文。
  - 现有 quoted media/file/doc 恢复测试继续通过。
  - 群聊与 DM 都继续只按稳定 `conversationId` scope 解析，不回退旧 `manager####` scope。
- 回归：
  - 现有 `QuotedRef` / `QuotedRefJson` 注入断言保持通过。
  - 循环链、深度截断、字符预算截断维持现有行为。

## Assumptions
- 当前轮文档附件策略采用“上游优先”：插件不再把抽取全文直接注入 `RawBody/CommandBody`。
- V1 不修改上游 `openclaw`，只在 DingTalk 插件侧完成 preview 翻译、回溯增强与文档摘录缓存。
- 首跳 preview 只解决“当前事件能看到的一跳”；多跳链仍然依赖本地 `message-context-store`。
- 若 quoted 首跳既没有 store record，也没有 `repliedMsg/quoteMessage` preview，则维持现有占位降级。
