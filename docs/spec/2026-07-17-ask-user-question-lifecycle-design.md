# Ask User Question 生命周期加固设计

## 状态

- 日期：2026-07-17
- 目标仓库：`soimy/openclaw-channel-dingtalk`
- 基线：`v3.6.6`（`a0eb1c1d6affa3fbc8d207107c136748bbbeacc1`）
- 目标范围：钉钉 `dingtalk_ask_user_question` 卡片生命周期
- 设计状态：方案已确认，等待书面规格复核

## 背景

当前 Ask User 链路会在 Agent 调用 `dingtalk_ask_user_question` 后创建钉钉表单卡片，将问题登记到进程内 Map，再通过 targeted `/stop` 尝试结束当前 Agent Run。用户提交、取消或等待超时后，插件把卡片结果伪造成一条新的钉钉入站消息，重新进入同一会话的 Agent 处理链路。

已有实现具备以下保护：

- `questionScopeKey = accountId + sessionKey + senderId`，用于隔离不同账号、会话和用户的问题卡片。
- 同一 scope 创建新问题卡片时，旧问题被 supersede。
- 回调校验卡片 owner，非 owner 点击按 handled-but-ignored 处理。
- 已提交、取消、超时或被替代的问题会生成短期 tombstone，阻止旧回调再次进入业务处理。
- 问题卡片接管回复后，普通 AI Card 回复和 finalize 会被抑制。

这些保护仍未覆盖真实用户继续对话、进程重启、回调竞态和暂停失败等生命周期事件。

## 当前风险

### 用户继续发送普通消息后，旧卡片仍可提交

当前仅在“新问题卡片替代旧问题卡片”时清理同 scope pending。用户收到问题卡片后，如果先发送普通消息继续对话，旧问题仍保持 pending。用户稍后点击旧卡片时，答案会被伪造成新的入站消息，进入已经继续发展的同一 Session，造成回答与当前上下文错配。

### 回调与普通消息缺少统一的竞争规则

回调处理会在若干异步卡片更新前后修改 `submitted`、pending Map 和 tombstone。普通消息当前不参与同一状态机。两类事件接近同时到达时，没有明确的“第一个事件获胜”规则。

### targeted stop 失败后仍保留 pending 卡片

问题卡片发送成功后，`onQuestionCardSent` 会调用 targeted `/stop`。失败时当前实现只记录 warning，问题卡片仍然可提交，而当前 Agent Run 可能继续执行、持有 Session Lock 或继续产生被抑制的输出。

### 进程重启后 pending 和 tombstone 丢失

pending question、scope index 和 tombstone 都是进程内 Map。Gateway 重启后，用户仍能看到并点击旧卡片，但插件无法匹配原问题；旧 tombstone 也无法阻止迟到回调。

### 卡片发送与 pending 登记之间存在窗口

当前实现先等待钉钉 `createAndDeliver` 成功，再登记 pending。若进程在两者之间退出，用户会收到一张插件永远无法匹配的孤儿卡片。

### 回答投递失败可能表现为静默丢失

回调在卡片显示已提交后通过 `setImmediate` 启动 synthetic inbound。若启动或后续处理失败，当前行为主要是记录日志，用户缺少明确的可见失败状态。

## 目标

1. 用户发送任意新的真实消息后，同一 scope 的旧问题卡片立即失效并显示原因。
2. 卡片回调、真实消息、新问题、TTL、暂停失败和重启通过一个明确的生命周期状态机竞争。
3. 同一问题的有效后续事件只能有一个获胜者。
4. 进程重启后不保留看似可操作、实际无法处理的旧卡片。
5. targeted stop 失败时问题卡片 fail closed，正常回复链路不被错误抑制。
6. synthetic answer 失败时给用户可见提示，避免只写日志。
7. 保留现有 owner 校验、scope 隔离、AI Card recall、TTL 和新问题替代语义。
8. 不持久化凭证、`sessionWebhook`、运行时配置或用户表单答案正文。

## 非目标

- 不在本次改动中修改 OpenClaw 或新增通用 `awaiting_user` API。
- 不用模型驱动的第二次 `sessions_yield` 调用替代确定性的插件控制流。
- 不实现多实例分布式锁或外部数据库一致性；部署前提仍是每个机器人只有一个活跃 DingTalk Stream 消费者。
- 不保证 synthetic inbound 在进程崩溃边界上的 exactly-once；本设计优先保证状态可解释、失败可见且不会自动重复提交。
- 不恢复重启前的 pending 问题为可继续回答状态。
- 不在同一个 PR 中大规模移动现有 Card 或 Gateway 文件。

## 方案选择

### 方案 A：只在新消息时删除内存 pending

优点是改动小。缺点是无法处理重启、卡片发送窗口、暂停失败和事件竞态，且继续依赖分散的 Map 操作。

### 方案 B：插件内持久化生命周期状态机

为 Ask User 增加独立的 Card 领域状态模块，统一管理问题记录、scope index、状态转换、TTL、tombstone 和重启清理。真实消息与回调先完成无异步间隙的状态转换，再执行卡片更新或 Agent 调度。

这是本设计采用的方案。

### 方案 C：先扩展 OpenClaw `yieldTurn`

长期方向是让普通插件原子请求宿主结束当前 Turn，但当前 OpenClaw 插件 Tool Context 没有该接口。先改宿主会扩大到两个仓库和新的最低版本要求，不适合作为当前插件风险的及时修复。

## 架构

### 新模块：`src/card/ask-user-question-store.ts`

新模块属于 Card 领域，负责：

- 问题记录的内存索引。
- `questionId`、`outTrackId` 和 `questionScopeKey` 查询。
- 不包含网络等待的原子状态转换。
- 通过 `persistence-store` 保存最小生命周期记录。
- 使用绝对 `expiresAt` 恢复 TTL 判断。
- Gateway 启动时将遗留 active 状态转为明确的重启终态。
- terminal record 在 tombstone TTL 到期后清理。

`ask-user-question.ts` 继续负责：

- Tool schema 和表单字段转换。
- 钉钉卡片创建与变量更新。
- 卡片回调 payload 解析。
- 根据 store 的 claim 结果编排 synthetic inbound。

`inbound-handler.ts` 继续负责：

- 解析真实消息、授权、路由与 Session。
- 在路由完成后调用 scope invalidation。
- 只有 targeted stop 成功时确认 question card takeover。

`gateway/channel-gateway.ts` 继续负责：

- 计算 account store path。
- 启动时触发遗留 Ask User 状态恢复和卡片失效更新。
- Card callback 时把 account store path 传入 Card 领域。

### 持久化 namespace

```text
cards.ask-user.lifecycle
```

使用 account store path，并显式应用：

```ts
{
  accountId;
}
```

状态文件包含：

```ts
type AskUserLifecycleStateFile = {
  version: 1;
  updatedAt: number;
  records: AskUserLifecycleRecord[];
};
```

单条记录只保存生命周期所需的最小数据：

```ts
type AskUserLifecycleRecord = {
  accountId: string;
  questionId: string;
  outTrackId: string;
  questionScopeKey: string;
  ownerUserId?: string;
  title: string;
  createdAt: number;
  expiresAt: number;
  status: AskUserLifecycleStatus;
  terminalReason?: AskUserTerminalReason;
  tombstoneExpiresAt?: number;
};
```

明确不保存：

- `sessionWebhook`
- access token、client secret 或其他凭证
- OpenClaw `cfg`
- `DingTalkConfig`
- logger 或函数引用
- 用户表单答案正文

当前进程内仍可由 `ask-user-question.ts` 维护仅用于 synthetic inbound 的 ephemeral context。该 context 丢失时，持久化状态只负责使旧卡片失效和拦截迟到回调，不负责恢复旧 Agent 上下文。

## 生命周期状态

### Active 状态

- `reserved`：生成 question/outTrack ID 后、调用钉钉发卡 API 前已经登记。
- `pending`：钉钉确认发卡成功，等待用户事件。
- `dispatching`：卡片回调已原子 claim，synthetic inbound 正在后台处理。

### Terminal 状态

Terminal record 同时承担 tombstone 作用。主要原因包括：

- `delivery_failed`
- `superseded_by_question`
- `superseded_by_message`
- `expired`
- `cancelled`
- `empty`
- `submitted`
- `pause_failed`
- `restart_invalidated`
- `restart_during_dispatch`
- `dispatch_failed`

### 合法转换

```text
reserved -> pending
reserved -> terminal(delivery_failed)

pending -> dispatching
pending -> terminal(superseded_by_question)
pending -> terminal(superseded_by_message)
pending -> terminal(expired)
pending -> terminal(pause_failed)
pending -> terminal(restart_invalidated)

dispatching -> terminal(submitted|cancelled|empty)
dispatching -> terminal(dispatch_failed)
dispatching -> terminal(restart_during_dispatch)
```

terminal 状态不允许回到 active。任何 terminal record 对应的 callback 都返回 `handled: true`，不得继续进入 stop button 或其他 Card Action 处理。

## 事件竞争规则

所有 claim/invalidate 操作必须满足：

1. 同步完成状态校验、状态修改、scope index 修改和持久化写入。
2. 状态转换函数内不进行钉钉 API、Agent Dispatch 或其他 Promise 等待。
3. 网络更新发生在转换成功之后。

因此，同一 Node.js 进程内最先完成状态转换的事件获胜：

- 真实消息先转换为 `superseded_by_message`，之后的卡片回调只命中 terminal record。
- 卡片回调先转换为 `dispatching`，随后到达的真实消息不会再失效这个问题；它按用户回答后的普通后续消息处理。
- 新问题卡片只有在新卡确认发送成功后才将旧 pending 转为 `superseded_by_question`，避免新卡发送失败却提前废弃旧卡。

## 真实消息失效语义

### 调用位置

失效操作位于：

1. 访问控制通过之后。
2. Agent Route 和 `questionScopeKey` 计算完成之后。
3. 命令分发、Session Lock 和 Agent Dispatch 之前。

这使 `/new`、`/stop` 等真实用户命令也符合“新消息使旧卡失效”的规则。

### Synthetic origin

`HandleDingTalkMessageParams` 增加内部来源标记。默认 Stream 入站视为真实消息；Ask User callback、cancel、empty 和 expiry 触发的 synthetic inbound 显式标记为 Ask User 来源。

只有非 synthetic、非 recursive sub-agent 的真实入站消息执行 scope invalidation。

### 用户文案

`superseded_by_message`：

> 你在问题卡片发出后发送了新消息，此卡已失效。请重新发起需要填写的问题。

`superseded_by_question`：

> 已有新的问题卡片，请回答最新卡片。

卡片按钮统一显示“已失效”。

即使卡片变量更新失败，本地状态仍保持 terminal，防止迟到 callback 重新进入业务处理。

## 发卡窗口处理

Tool 在调用钉钉 `createAndDeliver` 前创建 `reserved` 记录。此时不替代旧 pending。

- 发卡失败：`reserved -> terminal(delivery_failed)`，不影响旧 pending。
- 发卡成功：`reserved -> pending`，然后将同 scope 的旧 pending 转为 `superseded_by_question`。

这关闭“卡片已送达但本地从未登记”的主要进程崩溃窗口，同时避免新卡失败导致旧卡误失效。

## Agent Run 暂停与 takeover

本次改动保留 targeted `/stop`，因为当前 OpenClaw 没有供普通插件 Tool 原子调用的 `yieldTurn` 接口。

`onQuestionCardSent` 改为返回结构化 takeover 结果：

- targeted stop 成功：确认 `questionCardTookOver=true`，继续 recall 空 AI Card，并抑制普通回复。
- targeted stop 失败：将问题转为 `terminal(pause_failed)`，更新卡片原因，保持 `questionCardTookOver=false`，允许当前 Agent 继续正常回复。

`pause_failed` 文案：

> 当前任务未能暂停，此卡已失效，请重新发起。

AI Card recall 失败不恢复普通回复，因为 targeted stop 已成功；保留现有“记录 warning 并继续 suppress”的行为。

## Callback 与 synthetic inbound

### Callback claim

Callback 先完成以下只读校验：

- callback 是否能匹配 lifecycle record。
- record 是否已经 terminal。
- clicker 是否为 owner。
- 是否包含业务 payload。
- form payload 是否可解析。

得到可执行的 submit/cancel/empty 结果后，调用 store 原子 claim：

```text
pending -> dispatching
```

claim 失败表示另一个事件已经获胜，当前 callback 返回 `handled: true`。

### 后台处理

claim 成功后：

1. 将卡片显示为“已提交，处理中”。
2. 立即启动后台 synthetic inbound，不再增加单独的 `setImmediate` 调度窗口。
3. callback 及时返回并 ack，不等待完整 Agent Run。
4. synthetic inbound 成功后转为对应 terminal reason。
5. synthetic inbound 抛错时转为 `dispatch_failed` 并更新卡片提示。

`dispatch_failed` 文案：

> 回答已收到，但未能继续会话，请发送一条普通消息继续。

因为答案正文不落盘，进程在 dispatching 中重启时不自动重试。启动恢复会把该记录转为 `restart_during_dispatch`。

## 重启恢复

Gateway account 启动并取得 access token 后，对持久化状态执行：

- `reserved`、`pending` -> `terminal(restart_invalidated)`
- `dispatching` -> `terminal(restart_during_dispatch)`
- 已过 tombstone TTL 的 terminal record 删除
- 未过 tombstone TTL 的 terminal record 重新加载到查询索引

然后 best-effort 更新仍可定位的钉钉卡片。

`restart_invalidated` 文案：

> 服务已重启，原问题上下文已失效，请重新发起。

`restart_during_dispatch` 文案：

> 服务在处理回答期间重启，本次处理结果可能未完成，请发送新消息继续。

重启恢复不发 synthetic timeout/restart 消息，不主动创建新的 Agent Run。

## TTL

- pending 问题 TTL 保持 5 分钟。
- terminal/tombstone TTL 保持 30 分钟。
- 持久化保存绝对 `expiresAt` 和 `tombstoneExpiresAt`，而不是 timer 剩余毫秒数。
- 运行时 timer 只负责按绝对时间触发转换；启动时通过当前时间判断过期。

正常运行期间的 pending TTL 超时保持现有行为：卡片显示超时，并可按现有产品语义触发 synthetic expired message。重启恢复只更新卡片，不补发重启期间错过的 timeout synthetic message。

## 错误处理

- 状态转换和持久化错误使用 `[DingTalk][AskUser][Store]` 前缀。
- 卡片变量更新失败记录 warning，但不回滚 terminal 状态。
- 持久化文件缺失返回空状态。
- JSON 损坏或 schema 不合法时 fail closed：记录 warning，不恢复记录；不抛出阻断 Gateway 启动。
- 同一 question 的重复 callback 始终返回 handled，避免落入其他 Card Action。
- 状态文件写入沿用 `writeNamespaceJsonAtomic`。

## 测试设计

### Store 单元测试

- reserved 成功转 pending。
- delivery failure 不替代旧 pending。
- 新卡成功后只替代相同 scope 的旧 pending。
- 不同账号、Session 和 sender 互不影响。
- callback 和新消息分别先到时，第一个状态转换获胜。
- terminal record 不可恢复到 active。
- terminal callback 始终 handled。
- 绝对 TTL 和 tombstone 清理正确。
- 损坏 JSON 返回空状态并记录 warning。
- 持久化 JSON 不包含 webhook、token、配置或答案正文。

### Callback 单元测试

- 正常 submit、cancel、empty 保持原有消息格式。
- 非 owner callback 仍 handled-but-ignored。
- callback claim 之前不执行卡片网络更新。
- claim 失败不启动 synthetic inbound。
- dispatch 成功和失败分别产生正确 terminal reason 与卡片文案。
- late callback 在进程内和模拟重启后都命中 terminal record。

### Inbound 单元测试

- 真实普通消息在 Agent Dispatch 前失效旧卡。
- `/new`、`/stop` 同样失效旧卡。
- Ask User synthetic inbound 不触发 scope invalidation。
- recursive sub-agent 调用不重复失效父 scope。
- targeted stop 成功才 suppress normal replies。
- targeted stop 失败恢复正常 reply/finalize，并使问题卡片失效。

### Gateway 恢复测试

- 启动时 pending 转为 restart invalidated。
- dispatching 转为 restart during dispatch。
- terminal tombstone 可在重启后拦截 callback。
- 恢复失败不阻止 Stream account 启动。

### 真机验证

- 正常回答进入原 Session。
- 发卡后发送普通消息，旧卡立即显示失效原因。
- 再点击旧卡不会产生 synthetic answer。
- 连续创建两张问题卡时，旧卡提示回答最新卡片。
- Gateway 重启后，旧卡显示重启失效原因。
- 非 owner 点击仍被拒绝。
- TTL 超时行为无回归。
- `session.jsonl` 中不存在失效旧卡答案串入后续上下文。
- Gateway 日志不存在同一 question 的重复 Agent continuation。

真机验证前必须运行 `pnpm run build:runtime`、重启 Gateway，并确认 `channels.dingtalk.running=true` 和目标账号 `connected=true`。

## 测试文件拆分

当前 `tests/unit/ask-user-question.test.ts` 已超过仓库建议上限。实施时按职责拆分：

- 原文件保留 Tool schema 和 form 构造测试。
- `ask-user-question-lifecycle.test.ts` 覆盖状态转换和竞态。
- `ask-user-question-recovery.test.ts` 覆盖持久化与重启。
- 从 `inbound-handler-card.test.ts` 抽取 Ask User takeover 用例到 `inbound-handler-ask-user.test.ts`。

测试拆分与行为改动在同一 PR 中完成，但不做其他 inbound/card 测试的无关重排。

## 文档更新

更新 `docs/user/features/form-interactive-card.md`，明确：

- 普通新消息会使旧问题卡片失效。
- 新问题卡片会替代旧问题卡片。
- 超时和重启后的可见状态。
- 失效卡片点击不会继续 Agent 会话。
- 回答处理失败时用户如何继续。

设计和实施计划存放于 `docs/spec/` 与 `docs/plans/`，不扩展 README。

## Issue 与 PR

Issue 使用仓库“问题反馈”模板，中文描述风险、复现、期望、实际行为、环境和脱敏证据。建议标题：

> `[问题反馈] Ask User 旧卡片可能在后续消息或进程重启后继续提交`

PR 使用英文 Conventional-style 标题：

> `fix(card): harden ask-user question lifecycle`

PR 描述使用简体中文，并包含仓库要求的 `背景`、`目标`、`实现`、`实现 TODO` 和 `验证 TODO` 标签。创建时先保持 Draft，自动化和真机验证完成后再转 Ready。

## 回滚策略

- 代码回滚以整个 Ask User lifecycle PR 为单位。
- 新 namespace 是附加状态，不替换 session JSONL 或其他既有 namespace。
- 回滚旧版本后，新 namespace 文件会被忽略，不影响旧逻辑启动。
- 不在回滚过程中自动删除持久化文件，避免破坏正在调查的证据；后续版本可按 namespace TTL 清理。

## 完成标准

- 新真实消息一定使同 scope 旧卡片进入 terminal。
- 失效原因在钉钉卡片中可见。
- callback 与新消息只有一个事件能从 pending 成功转换。
- 重启后不存在仍显示 pending 的旧 Ask User 卡片。
- targeted stop 失败不会留下可提交的 pending 卡片，也不会错误 suppress 正常回复。
- owner 校验、TTL、新问题替代、AI Card recall 和 normal finalize 无回归。
- 持久化状态不包含凭证、webhook、运行时配置和答案正文。
- 相关单测、全量测试、类型检查、lint、runtime build、文档构建、CI 和真机关键场景全部通过。
