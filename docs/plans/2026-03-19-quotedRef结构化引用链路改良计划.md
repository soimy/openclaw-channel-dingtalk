# `quotedRef` 结构化引用链路改良计划

## Summary
- 将现有“恢复引用原文后直接拼入 `RawBody` / `content.text`”的实现，改为“基于 `quotedRef` 的结构化索引与单跳关联”。
- 入站回复/引用消息记录最小 `quotedRef` 线索；当前 turn 里所有真正发给用户的最终回复默认写入 `quotedRef`，指向当前被回复的 inbound `msgId`。
- 不再把被引用原文注入系统上下文；`RawBody` 保持当前用户正文，runtime 通过独立字段消费 `QuotedRef`。
- 实现需对齐仓库开发标准：以 [`docs/ARCHITECTURE.md`](/Users/sym/.codex/worktrees/bc4f/openclaw-channel-dingtalk/docs/ARCHITECTURE.md) 为准，遵守 [`AGENTS.md`](/Users/sym/.codex/worktrees/bc4f/openclaw-channel-dingtalk/AGENTS.md) 与 [`CONTRIBUTING.md`](/Users/sym/.codex/worktrees/bc4f/openclaw-channel-dingtalk/CONTRIBUTING.md) 的模块边界、测试、日志与兼容性要求。

## Standards Alignment
- 以逻辑域优先、物理迁移次之为原则，不做 repo-wide move；行为改动与大规模文件搬迁分离。
- 保持 `src/channel.ts` 为 assembly root；本次改动只允许最小 wiring 变化，不新增业务逻辑。
- 新增能力归入 messaging 域；新增 helper 采用 `src/messaging/` 目录承载，即使相邻旧文件仍在 `src/` 根部也不反向扩散。
- 禁止重新引入 `quote-journal.ts` / `quoted-msg-cache.ts` 风格兼容包装层；所有短期消息引用/媒体上下文仍统一走 `message-context-store.ts`。
- 保持确定性解析优先：优先 `msgId` / alias key，`createdAt` 仅作 outbound legacy fallback。
- 保持现有日志前缀、token 获取约束、无 `console.log`、无 `@ts-ignore`、无敏感信息泄露。
- 验证标准按贡献规范执行：`npm run type-check`、`npm run lint`、`pnpm test`，并优先补齐与引用恢复相关的 unit/integration 测试。

## Key Changes
### 1. 数据模型与对外上下文字段
- 新增最小结构 `QuotedRef`，字段固定为：
  - `targetDirection`: `"inbound" | "outbound"`
  - `key`: `"msgId" | "processQueryKey" | "messageId" | "outTrackId" | "cardInstanceId"` 可选
  - `value`: `string` 可选
  - `fallbackCreatedAt`: `number` 可选
  - `fallbackMsgId`: `string` 可选
- `MessageRecord` 增加可选 `quotedRef`；`MessageContent` 增加可选 `quotedRef`；发送侧选项增加可选 `quotedRef` 透传。
- `finalizeInboundContext` 新增独立字段 `QuotedRef`；若 runtime 不稳定接收对象字段，则同时写 `QuotedRefJson` 作为兼容镜像。
- `RawBody`、`CommandBody` 不再承载被引用原文。

### 2. 模块落位与职责
- 在 messaging 域新增一个小型 quoted-ref helper 模块，负责：
  - 从 DingTalk inbound payload 归一化生成 `QuotedRef`
  - 通过 `message-context-store` 解析 `QuotedRef`
  - 返回引用命中结果供 `inbound-handler` 做媒体恢复与上下文注入
- `message-utils.ts` 只保留 DingTalk 原始 quoted metadata 提取，不再负责生成 `[引用消息: "..."]` 这类原文前缀。
- `inbound-handler.ts` 保持 orchestrator 角色，只协调：
  - quotedRef 构建
  - quotedRef 解析
  - 引用附件恢复
  - `QuotedRef` 注入 runtime context
- `send-service.ts` / `card-service.ts` 统一负责最终出站消息的 `quotedRef` 落盘，不把持久化散落到 strategy 层。

### 3. 入站行为
- 文本/普通 reply：
  - 若引用普通入站消息，生成 `QuotedRef { targetDirection: "inbound", key: "msgId", value: originalMsgId }`
- 引用机器人出站消息：
  - 优先 `originalProcessQueryKey`
  - 缺稳定 key 时仅记录 `fallbackCreatedAt` 与可得的 `fallbackMsgId`
  - 不再将机器人原回复文本改写进用户正文
- 图片/文件/文档引用：
  - 继续保留现有下载恢复能力
  - 优先通过 `quotedRef` 解析历史 record，再走 `downloadCode` / `spaceId+fileId` / 群文件 API fallback
  - 成功时仅设置 `MediaPath` / `MediaType`
  - 失败时保留现有通用提示，不回填原文
- 删除所有基于引用前缀的 journal 正文清洗逻辑；入站 journal 直接保存当前消息正文。

### 4. 出站行为
- 当前 inbound reply pipeline 中，所有最终发给用户的消息默认带单跳 `quotedRef`，统一指向当前 inbound `msgId`：
  - markdown/text final
  - AI Card final
  - 最终媒体回复
- 明确不写 `quotedRef` 的分支：
  - tool append
  - reasoning/thinking 流
  - ack reaction
  - card 完成后的额外 `@sender` 提醒
  - 真正主动消息/定时消息/独立推送
- 统一补齐“session 媒体回复” journaling 路径，使它与文本/card 一样可写 `quotedRef`。
- `message-context-store` 的 canonical key 选择规则不变；`quotedRef` 仅增加引用关系，不改变 `messageId > processQueryKey > outTrackId` 的出站主索引策略。

### 5. Store 与解析规则
- `message-context-store.ts` 新增 `resolveByQuotedRef(...)`：
  - inbound 仅按 `msgId`
  - outbound 按显式 alias key 查找
  - 只有 outbound 缺稳定 key 时才允许 `resolveByCreatedAtWindow`
- 保持 `createdAt` 是 scoped fallback index，不升级为主键。
- 不做存量数据迁移；`quotedRef` 为可选字段，旧 record 继续可读。
- 不在 store 中保存引用原文、完整链、附件摘录缓存；只保存最小索引结构。

## Test Plan
- `message-context-store`
  - `quotedRef` 可持久化、可读回
  - `resolveByQuotedRef` 命中 inbound `msgId`
  - `resolveByQuotedRef` 命中 outbound `processQueryKey`
  - outbound 缺 key 时仅 createdAt fallback 生效
- `inbound-handler`
  - reply 文本不再把原文拼进 `RawBody`
  - AI Card reply 生成 `QuotedRef`
  - 文件/文档/图片引用恢复成功时只注入媒体
  - 恢复失败时仍输出现有通用提示
  - `finalizeInboundContext` 收到 `QuotedRef` / `QuotedRefJson`
- `send-service` / `card-service`
  - 最终文本回复写 `quotedRef`
  - card final 写 `quotedRef`
  - 最终媒体回复写 `quotedRef`
  - 主动消息、tool append、ack、post-card @ 提醒不写 `quotedRef`
- 回归
  - DM conversationId scope 保持稳定
  - processQueryKey alias 与 group file/doc fallback 不回退
  - attachment extract 与现有 reply strategy 行为不受破坏

## Assumptions
- `quotedRef` 使用最小结构，不存原文、不存完整链、不存富派生元数据。
- 出站引用关系为单跳关联；如需追链，后续由读取方递归解析 record。
- 新 helper 进入 messaging 域目录，不顺带搬迁旧模块。
- 本次是行为改良，不调整公共导出面，除新增类型与 inbound context 字段外不扩散 API。
