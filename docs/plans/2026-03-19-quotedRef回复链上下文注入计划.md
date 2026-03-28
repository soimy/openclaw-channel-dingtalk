## DingTalk 插件侧 `quotedRef` 回复链上下文注入计划

### Summary
在不修改上游 `openclaw` 的前提下，继续保留 `QuotedRef` 作为底层索引，但在 DingTalk 插件入站阶段把可解析的引用链翻译成上游已支持的上下文字段。
V1 默认开启，覆盖“单跳原文 + 有上限的多跳链”：第一跳注入 `ReplyToId` / `ReplyToBody` / `ReplyToSender` / `ReplyToIsQuote`，多跳链以单个 `UntrustedContext` JSON 块注入给 agent；`RawBody` / `CommandBody` 继续只保留当前用户正文。

### Key Changes
- 在 messaging 域新增一个内部 helper（建议 `src/messaging/quoted-context.ts`），负责两件事：
  - 单跳解析：基于现有 `resolveQuotedRecord()` / `message-context-store`，把当前 inbound 的 `quotedRef` 解析成第一跳 reply context。
  - 有限递归解析：沿 `record.quotedRef` 继续追链，生成 bounded chain；默认 `maxDepth = 3`，单跳正文截断上限 `1200` 字符，总链正文上限 `3600` 字符，命中循环或缺 record 即停止。
- 在 `src/inbound-handler.ts` 中，在 `finalizeInboundContext()` 之前补充 reply-context 注入：
  - `ReplyToId`：第一跳 canonical 标识。inbound 优先 `msgId`；outbound 优先 `processQueryKey`，其次 `messageId` / `outTrackId` / `cardInstanceId`。
  - `ReplyToBody`：第一跳 `record.text`；若无文本则生成稳定占位文案，如 `[Quoted <messageType>]`。
  - `ReplyToSender`：第一跳为 outbound 时固定 `"assistant"`；inbound 暂不猜测展示名，缺失时不填。
  - `ReplyToIsQuote`：命中第一跳时恒为 `true`。
  - `UntrustedContext`：仅当链深度大于 1 时追加一条 JSON 块，内容从第 2 跳开始，避免与 `ReplyToBody` 重复。
- `QuotedRef` / `QuotedRefJson` 保持继续透传，作为未来上游正式消费时的兼容面；`RawBody`、`CommandBody`、`Body`、媒体恢复逻辑保持现状，不重新拼回引用原文。
- 递归链的单跳结构固定为最小只读上下文：
  - `depth`
  - `direction`
  - `messageType`
  - `sender`（仅 outbound 固定为 `"assistant"`，其余可省略）
  - `body`
  - `createdAt`
  - `quotedRef` 不继续暴露给 agent，只用于插件内追链
- 循环检测使用“当前 record 的稳定 canonical 标识”优先，其次使用规范化后的 `quotedRef` 指纹；任一命中即停止追链并不报错。

### APIs / Types
- 不改插件对外公共导出面；本次仅新增内部 helper 与内部类型。
- 新增内部类型即可，不需要扩散到 `src/channel.ts` 公共 API：
  - `ResolvedQuotedRuntimeContext`
  - `QuotedChainEntry`
- `finalizeInboundContext()` 调用新增的字段仅使用上游已存在字段名：
  - `ReplyToId`
  - `ReplyToBody`
  - `ReplyToSender`
  - `ReplyToIsQuote`
  - `UntrustedContext`

### Test Plan
- `inbound-handler`：
  - 回复普通 inbound 文本时，`ReplyToBody` 命中原文，`RawBody` 仍只等于当前消息。
  - 回复机器人 outbound card 时，`ReplyToBody` 通过 `processQueryKey` 命中。
  - 第一跳无 `text` 时，`ReplyToBody` 使用占位文案而不是空值。
  - 仅单跳场景不写链式 `UntrustedContext`。
  - 多跳场景会写一条 `UntrustedContext`，且内容从第 2 跳开始。
  - 循环链会在检测后安全停止，不抛错。
  - unresolved `quotedRef` 时，不写 `ReplyTo*` 字段，也不写链块。
- quoted-context helper：
  - inbound -> outbound -> inbound 三跳链按顺序生成。
  - 超过 `maxDepth` 时截断。
  - 超过字符预算时截断正文并保留结构可解析性。
  - 当前 record 缺 `quotedRef` 时正常终止。
- 回归：
  - 现有 quoted media/file/doc 恢复测试全部保持通过。
  - DM 和群聊都继续只按稳定 `conversationId` scope 解析，不回退旧 `manager####` scope。
  - 现有 `QuotedRef` / `QuotedRefJson` 注入断言保持通过。

### Assumptions
- V1 默认开启，不新增配置开关。
- V1 只做“插件预翻译成上游旧字段”，不尝试在插件侧模拟上游 memory/历史机制。
- `ReplyToBody` 只承载第一跳；更长链路统一走 `UntrustedContext`。
- 多跳链块使用 JSON 文本而不是自然语言摘要，优先保证 agent 可解析和实现稳定。
- 旧历史数据若缺 `record.text` 或缺后续 `quotedRef`，允许降级为单跳或占位文案，不做迁移。
