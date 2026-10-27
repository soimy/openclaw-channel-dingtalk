# 评价 HTTP 上报接口对接手册

面向接收服务、数据库及平台开发人员。协议版本 `1`，核对日期 2026-10-25。**这是社区钉钉插件主动调用公司服务的 HTTP 接口，不是钉钉开放平台回调，不是 DWS 接口，也不是 OceanBase 的 HTTP 接口。** 接收服务由公司实现；插件不连接数据库、不调用 Agent/LLM 完成上报。

## 1. 调用方向、触发时机与双方职责

### 1.1 谁调用谁

**插件是 HTTP 客户端，你们的接收服务是 HTTP 服务端。接收服务开发人员实现 POST 路由即可，不需要反向调用插件，也不需要定时访问员工 Pod 拉取评价。**

```text
员工点击评价
  → 员工 Pod 内的社区钉钉插件：先保存本地评价并响应卡片
  → 插件后台 Worker：向 feedbackReporting.endpoint 发出 HTTP POST
  → 公司接收服务：认证、校验版本、幂等写入 OceanBase、COMMIT
  ← 公司接收服务返回 HTTP 200 + 协议 ACK
  ← 插件记录确认；失败或确认不完整时保留待发状态
```

部署时，公司提供接收服务完整 URL，例如 `https://feedback.example.com/v1/feedback/snapshots`，管理员将其填入每个实例的 `channels.dingtalk.feedbackReporting.endpoint`。这个地址属于公司接收服务，不是员工 OpenClaw 的访问地址。仅因本功能，无须向接收服务开放 15,000 个 Pod 的入站接口。

正常发送以**有效评价事件**触发；延迟发送、失败重试、正文复查和重启恢复均由插件内部调度。无须为此配置 OpenClaw cron、PowerJob 或接收端轮询任务。插件的内部定时器用于处理待办，不是定时上传全部会话。

### 1.2 什么时机发送或补传

以下均以渠道和评价功能已启用、`feedbackReporting.enabled=true` 且配置有效为前提。

| 触发情况 | 插件发送端的行为与默认时间 | 接收服务需要做什么 |
| --- | --- | --- |
| 原提问者有效点赞、点踩、提交原因或撤销 | 本地保存后登记待办；等待前台空闲窗口，默认约 5 秒，再异步发送 | 正常接收 POST；不主动拉取或要求员工再次确认 |
| 正在聊天、处理卡片，或 CPU/内存等资源紧张 | 暂停/中止后台 Worker，前台结束并满足空闲及资源条件后继续 | 允许晚到和重复请求，不按“点击后 5 秒未到”判定丢失 |
| 网络错误、请求超时、非 200 或非法 ACK | 保留待发数据并自动退避重试，详见第 1.3 节 | 提交后才确认；对重发请求幂等处理 |
| OpenClaw / gateway 重启，状态卷中仍有待办 | 启动后随机延迟约 30～90 秒开始恢复发现，再按空闲、资源及已有退避时间发送 | 服务保持可用即可，不需要发出“恢复拉取”请求 |
| 正文以 pending 获得合法 ACK | 默认约 5 分钟再尝试采集；若补齐则用更高 revision 发送，即使评价没有再次变化 | 接受元数据先到、正文后到，并按版本更新 |
| 已确认 available/missing/unverified，且没有新评价 | 该正文结果已结束重试，不定时重发；无其他待办时调度器休眠 | 保留已提交结果，无须维持长连接 |

约 5 秒是 `idleMs` 的默认空闲门槛，不是交付 SLA；排队、前台活动、资源压力及网络耗时都会影响实际到达时间。30～90 秒针对重启后的持久待办恢复发现，不表示重启后所有新评价都要等待这段时间。正文 pending 的约 5 分钟复查也受前台与资源条件约束；新评价可提前唤醒该记录的处理。

回答生成完成本身不会触发正文上报。未评价卡片、被拒绝的非本人操作，以及已经去重的同一钉钉回调，不作为新的有效评价发送。开启上报不会自动导入全部历史。短时间内先赞后撤销，尚未发送的变化可以合并成最终 none；接收端不应期待每次点击必有一条 HTTP 请求。

### 1.3 重试与停止条件

- 单次 HTTP 请求默认最多 5 秒（`requestTimeoutMs`），超时不阻塞卡片响应或前台对话。
- HTTP 失败或确认无效时，重试基准依次为 5、10、20、40、80、160、300 秒，此后维持 300 秒；每次加 ±20% 抖动。前台活动和资源压力可能使实际间隔更长。当前不读取 `Retry-After`。
- 只有 HTTP **200** 且 schemaVersion、recordId、acceptedRevision、status 校验通过，才接受 ACK。`200 {"ok":true}`、202、204、3xx、4xx、5xx 都不会被当作已确认；4xx 持续出现需要管理员修复配置/授权/冲突，插件仍会退避。
- 已提交但响应丢失时可能收到重发；相同 recordId/revision/原请求应返回 duplicate，不能再次累计票数。新评价可以取代尚未发送的旧状态，版本允许跳号。
- 合法 applied/duplicate 会停止该版本的网络失败重试；正文 pending 仍保留后续复查。合法 stale 则终止被更高版本取代的旧快照，不自动抬高旧版本去覆盖中心新值。
- 关闭上报会停止投递但保留本地数据；重新启用后按仍有效的持久待办恢复。补传受保留期约束，超过保留期限可以清理，不是无限离线保证。

HTTP 失败重试与正文 pending 复查是两种机制：前者表示未取得可靠确认，后者表示评价已可靠接收、正文暂时未齐。接收服务不应自行再定时调用员工实例来“补问答”。

发送端用最多 1024 项的内存索引直接调度已知重试，避免每次到期重扫历史文件；该索引不占用 128 项就绪队列，也不保存正文。重启或索引溢出时仍按 receipt 做节流恢复；索引不是新的持久化协议，接收服务无需适配。前台活动、资源压力和排队仍可延后实际请求。

### 1.4 双方实现边界

| 插件发送端（已实现） | 公司接收端（需对接） |
| --- | --- |
| 仅接受原提问者的有效评价，关联对应一问一答 | 验证凭据绑定的企业与实例，控制数据库及报表访问权限 |
| 保存本地最新状态与待发版本，空闲时异步发送 | 按记录主键和版本幂等覆盖最新状态，不按请求次数计票 |
| 解析/核对精确消息 ID 和回答指纹；缺失时明确表达 | 保存可用正文或缺失状态，按 preserve 指令保留原正文 |
| 失败退避、重启补传、前台活动或压力时退让 | 数据库 COMMIT 后才确认；重复请求、超时及并发安全处理 |

这是受本地保留期约束的最终状态同步，不是逐次点击审计，也不是全量会话备份。未评价回答不上传；同一张卡片待发送期间的多次操作可合并。开启功能不自动导入全部历史，不能用 HTTP 请求次数计算评价数。

阅读顺序：调用方向和调度（第 1 节）→ 字段（第 3 节）→ 示例（第 6 节）→ 接收端事务（第 7 节）→ 联调（第 9 节）。配套文件：

- [部署配置与性能边界](../features/feedback-http-reporting.md)，[完整升级指引](../getting-started/card-feedback-deployment.md)。
- [OpenAPI 3.1 定义](./feedback-reporting.openapi.json)：每个字段均有 description、必填与类型说明。
- [完整示例集合](./feedback-reporting-examples.json)：7 份完整请求、3 种成功 ACK，ID 和哈希均实际计算。
- 随包 `docs/user/reference/feedback-reporting-oceanbase.sql`：OceanBase 4.2.5.7 MySQL 模式参考 DDL 和事务步骤，尚未在公司数据库执行。
- 随包 `scripts/feedback-reporting-receiver.mjs`：本机文件接收器，仅用于协议联调，不是生产接收服务。

## 2. 地址、认证与编码

| 项目 | 约定 |
| --- | --- |
| Method | `POST`，一请求一张卡片，不支持批量数组 |
| 推荐路径 | `/v1/feedback/snapshots` |
| 实际地址 | 向 `feedbackReporting.endpoint` 的完整 URL 请求，不自动补路径；公司可自行选择路径 |
| Content-Type | `application/json`；请求及响应采用 UTF-8 JSON，不压缩 |
| Authorization | `Bearer <接收服务凭据>`；由公司签发，绑定 tenantId/instanceId，**不是钉钉 accessToken** |
| Idempotency-Key | `<recordId>:<revision>`；例如下面示例会给出实际值 |
| 请求大小 | 最大 307200 字节（300 KiB），含全部字段和 JSON 编码开销 |
| ACK 大小 | 最大 8192 字节（8 KiB），HTTP 状态必须恰为 200 |
| 超时 | 默认 5000ms，覆盖 DNS、TCP、TLS、响应全过程；可配 500～10000ms |

默认 HTTPS，本机 loopback 可用 HTTP；其他 HTTP 地址需显式启用 `allowInsecureHttp`。不接受 URL 内嵌凭据、query 或 fragment，不跟随重定向。直接使用 Node HTTP(S) 请求；不要假定自动读取系统代理、HTTP_PROXY 或复用公司代理连接池。生产应验证 Pod 到接收端的 DNS、证书链、网络出口和路由。

接收端应先认证再进行昂贵解析/数据库操作；限制请求大小。不信任请求体自报的企业身份，不将问答、token 或错误堆栈写入普通访问日志。所有 ID 保持原大小写；不要 trim、转小写、转为数字或根据显示名称替换。可选字段**省略**，不传 `null`；未知结构/协议版本应拒绝并记录固定诊断码。

## 3. 请求字段逐项说明

所有时间字段为 Unix **毫秒**整数，不是秒或日期字符串。`revision` 用 JSON 整数，不要转换为浮点小数或使用 32 位数据库整数。表中嵌套字段的必填性仅在父对象存在时生效；额外条件见正文。

### 3.1 顶层字段

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `schemaVersion` | integer | 是 | 协议版本，固定整数 1；不是插件或数据库版本。 |
| `type` | string | 是 | 消息类型，固定 dingtalk.feedback.snapshot。 |
| `recordId` | string | 是 | 稳定记录主键：SHA-256(UTF-8 JSON.stringify([tenantId,instanceId,accountId,cardId]))，64 位小写十六进制。 |
| `revision` | integer | 是 | 本记录的持久化传输版本，1..9007199254740990；不要求连续，不是点击次数、时间戳或本地源版本。 |
| `source` | object | 是 | 来自管理员配置和当前钉钉账号的来源身份；接收方必须与 Bearer 授权绑定。 |
| `cardId` | string | 是 | 钉钉 AI 回答卡片 outTrackId，保留原大小写；不是消息 ID。 |
| `questionerUserId` | string | 是 | 原提问者的企业 UserId，也是唯一有权评价该卡片的人；群聊中可不同于 Pod 所属员工。 |
| `feedback` | object | 是 | 此版本的最新评价状态，不是累加事件。 |
| `conversation` | object | 是 | 原问答的渠道与宿主定位信息；不包含全会话历史或本地文件路径。 |
| `answerHash` | string | 否 / 条件见说明 | 回答完成时可见文本的 SHA-256（UTF-8、小写 hex），可选；available 正文时必须存在并匹配。 |
| `createdAt` | integer | 是 | 卡片归属记录创建时间，Unix 毫秒整数；不是模型开始时间。 |
| `completedAt` | integer | 否 / 条件见说明 | 回答正常完成时间，Unix 毫秒整数；旧数据可省略。 |
| `content` | object | 是 | 当前正文结果或保留指令；必须结合 mode 与 status 解读。 |

`recordId` 算法必须完全一致：取 `[tenantId, instanceId, accountId, cardId]`，按此顺序生成紧凑 JSON 数组，编码 UTF-8 后算 SHA-256，输出小写十六进制。不要拼冒号字符串，不加空格/BOM，不对 Unicode 另做规范化。跨语言实现应与 JS `JSON.stringify` 输出一致。

```js
import { createHash } from 'node:crypto';
const recordId = createHash('sha256')
  .update(JSON.stringify(['example-company', 'employee-001', 'default', 'card_api_example_001']), 'utf8')
  .digest('hex');
```

`answerHash` = SHA-256(UTF-8 `content.answer`)，针对 JSON 解码后的**原样字符串**，不能先 trim、改换行、移除 Markdown 或将 HTML 渲染结果拿来计算。它用于一致性校验，不是加密，也不能还原正文；两次相同回答可以有同一指纹，所以不能用它代替 `recordId` 或消息 ID。

### 3.2 来源 source

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `source.tenantId` | string | 是 | 管理员配置的企业/租户标识，1..128 字符，跨实例稳定。 |
| `source.instanceId` | string | 是 | 管理员配发的逻辑员工实例标识，1..128 字符，跨 Pod 重建保持不变；不是易变化的 Pod UID。 |
| `source.accountId` | string | 是 | OpenClaw 钉钉 channel 账号 ID，如 default；不等于员工 UserId 或机器人应用 ID。 |
| `source.channel` | string | 是 | 渠道类型，固定 dingtalk。 |

15,000 个 Pod 很可能全用 `accountId=default`，这不是全局唯一员工身份。实例标识必须跨 Pod 重建稳定；`questionerUserId` 则是具体问答的提问者，群聊时可能是其他员工。

### 3.3 评价 feedback

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `feedback.vote` | string | 是 | like=赞，dislike=踩，none=撤销/当前无有效评价；按覆盖而非累加统计。 |
| `feedback.reasons` | array | 是 | 点踩原因字符串代码，去重，0..6 项；非点踩应为空数组。[] 不能区分尚未选择与关闭原因面板。 |
| `feedback.updatedAt` | integer | 是 | 最近被接受的钉钉评价事件时间，Unix 毫秒；不是 HTTP 到达时间，不用于替代 revision 排序。 |

| reasons 元素 | 含义 |
| --- | --- |
| `"1"` | 内容不匹配 |
| `"2"` | 内容不完整 |
| `"3"` | 表达不合逻辑 |
| `"4"` | 存在事实偏差 |
| `"5"` | 有敏感词或观点 |
| `"6"` | 回答不是我想要的 |

理由用字符串数组，不是数字数组或逗号文本。最多 6 个，不重复；`like/none` 的 reasons 应为 `[]`。点踩但尚未选择原因也可以为 `[]`；HTTP 不发送本地的 `reasonsSubmitted`，接收方不能区分“未选”与“关闭面板”。

### 3.4 问答定位 conversation

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `conversation.agentId` | string | 是 | 生成原回答的实际 OpenClaw Agent ID，不一定等于 accountId。 |
| `conversation.sessionKey` | string | 是 | 回答所属宿主路由会话键；可能在 reset 后指向新会话，不能单独精确定位消息。 |
| `conversation.conversationId` | string | 是 | 钉钉原单聊/群聊会话 ID，保持大小写，不是会话显示名称。 |
| `conversation.sourceMsgId` | string | 否 / 条件见说明 | 可选：钉钉入站原消息 ID；不是转录 userMessageId。 |
| `conversation.transcript` | object | 否 / 条件见说明 | 可选：回答完成时记录的转录关联。linked 表示保存了精确 ID，不保证原转录现在仍存在；旧记录可整体省略。 |

`transcript` 可以整体省略（历史记录从未保存引用），或为以下两种结构之一，不允许混用。

**已关联：**

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `conversation.transcript.status` | string | 是 | 固定 linked：已保存当时的精确消息引用。 |
| `conversation.transcript.source` | string | 是 | 固定 runtime-events：从可信宿主事件捕获，不由 LLM 推断。 |
| `conversation.transcript.sessionId` | string | 是 | 当时实际会话实例 ID；会话重置后仍指旧 SID。 |
| `conversation.transcript.userMessageId` | string | 是 | 原问题的转录消息 ID，与 sourceMsgId 不同。 |
| `conversation.transcript.assistantMessageId` | string | 是 | 最终回答的转录消息 ID，与 cardId 不同。 |

**未能关联：**

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `conversation.transcript.status` | string | 是 | 固定 unavailable：回答完成时无法唯一捕获引用。 |
| `conversation.transcript.reason` | string | 是 | 捕获失败原因：events-unavailable、question-not-observed、answer-not-observed、session-id-missing、ambiguous-turn、content-mismatch、capture-limit。与 content.reason 是两个命名空间。 |

捕获失败原因逐项解释：

| transcript.reason | 含义 |
| --- | --- |
| `events-unavailable` | 宿主无所需事件能力 |
| `question-not-observed` | 未观察到可确定的原问题 |
| `answer-not-observed` | 未观察到候选最终回答 |
| `session-id-missing` | 缺少实际会话 ID |
| `ambiguous-turn` | 存在多个候选、会话 ID 冲突等歧义 |
| `content-mismatch` | 最终卡片文本与捕获的候选回答不一致 |
| `capture-limit` | 文本或候选数量超出捕获上限 |

`transcript.status=linked` 只说明完成时取得引用，后来转录被清理仍可保持 linked；本次能否上传正文由 `content.status` 表示。`sourceMsgId`、`cardId`、`userMessageId`、`assistantMessageId` 是不同系统的 ID，不能互换。不会上传 `localFile`、状态目录、访问凭据、完整会话、思考或工具块。

### 3.5 正文 content

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `content.mode` | string | 是 | replace=应用本次正文结果；preserve=保留中心已确认正文，不得用省略字段清空。 |
| `content.status` | string | 是 | available=已验证问答；missing=不存在或无精确引用；unverified=校验不通过；pending=暂缓采集。 |
| `content.reason` | string | 否 / 条件见说明 | 可选固定原因码；非 available 时解释正文状态，不能当作 HTTP 错误或自由文本。 |
| `content.question` | string | 否 / 条件见说明 | 仅 replace+available 携带的原问题可见文本，可包含 Markdown；不是整个会话。 |
| `content.answer` | string | 否 / 条件见说明 | 仅 replace+available 携带的最终回答可见文本；无思考/工具块，不是 HTML。 |
| `content.answerHash` | string | 否 / 条件见说明 | 可选可见回答 SHA-256；replace+available 必填并与顶层 answerHash 及 UTF-8 answer 的哈希相同。 |

| 组合 | 请求内容 | 接收端处理 |
| --- | --- | --- |
| replace + available | 必须有 question、answer、content.answerHash、顶层 answerHash | 两个 hash 必须相等且与 answer 校验一致，保存原问答 |
| replace + missing | 不含 question/answer，通常有 reason | 保存缺失原因；并不等于一定是转录被删除 |
| replace + unverified | 不含 question/answer | 保存校验失败状态，不能猜测/补填其他消息 |
| replace + pending | 不含 question/answer | 接受当前评价及暂缓状态；稍后可收到新版本的 available |
| preserve + 已确认状态 | 不含 question/answer；可含已确认的 hash/reason | 保持已有正文/正文状态；无中心记录时返回 409，不能当成功 |

当前发送端在 available、missing、unverified 获 applied/duplicate 确认后均视为正文终态；之后的评价变化使用 preserve，**不是每点一次重新查转录**。只有 pending 按默认约 5 分钟继续检查。stale 只确认中心有更高版本，不能证明本地正文已入库；本地释放旧正文，后续真实评价重新核验后发送 replace。恢复被清理的转录不会自动重采已确认的 missing；本版无通用强制重放 API，管理员需协调恢复流程，不能通过随意删除 outbox 实现补采。

针对旧版长行误判，本次升级会对已确认的 `unverified/invalid_transcript` 做一次有界复核；如需纠正状态，使用更高 revision。尚未确认的旧请求先原样重试，不改变同一幂等键的内容。此为一次兼容维护，不是周期性重采所有终态记录。

正文是转录中的目标消息可见 text 内容；多 text 块以换行连接，保留 Markdown 和文本中已有的引用/上下文包装，**不保证等于钉钉客户端原始输入的纯净副本**。图片/文件等非文本块不上传附件二进制；这不是完整多模态归档。正文超出预算时 pending，不静默截断。后台报表展示应转义 HTML，限制 Markdown 外链/图片加载，避免把来信文本作为可执行内容。

### 3.6 content.reason 原因码

此字段与 transcript.reason、HTTP 错误是三个独立概念。保留未知原因码用于未来兼容，不按中文提示分支判断。

| 原因码 | status | 含义 / 处理 |
| --- | --- | --- |
| `reference_not_recorded` | missing | 未保存精确引用，包括历史省略或 unavailable；不能据此认定文件已删除 |
| `transcript_not_found` | missing | 精确目标转录路径不存在 |
| `message_not_found` | missing | 转录中找不到一条或两条目标消息 |
| `invalid_transcript` | unverified | 文件结构、会话头、重复/异常记录等无法可靠验证 |
| `content_verification_failed` | unverified | 消息存在，但角色、来源、顺序、身份或回答指纹核对失败 |
| `resource_budget` | pending | 转录、索引、工作线程资源或读取预算不足 |
| `content_budget` | pending | 一问一答的编码大小超过 maxContentBytes |
| `bounded_reader_unavailable` | pending | 宿主没有当前适配器需要的有界读取能力 |
| `store_unavailable` | pending | 会话索引不可用 |
| `session_target_unavailable` | pending | 无法可靠定位当时的目标会话，禁止猜测当前会话 |
| `read_failed` | pending | 读取、路径/SDK 解析等暂时失败 |
| `transcript_changed` | pending | 读取期间文件发生变化，稍后重试 |

## 4. 响应字段与 HTTP 状态

### 4.1 成功确认 ACK

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `schemaVersion` | integer | 是 | 确认协议版本，固定整数 1。 |
| `recordId` | string | 是 | 必须精确等于请求的 recordId。 |
| `acceptedRevision` | integer | 是 | 已持久化版本：applied/duplicate 必须等于请求；stale 必须严格大于请求。 |
| `status` | string | 是 | applied 已提交新版本；duplicate 同版本同内容已存在；stale 中心已有更高版本。均需持久化后返回。 |

- `applied`：本次新版本已经持久提交。
- `duplicate`：相同 recordId/revision、相同原请求已提交；无需二次写入。
- `stale`：相同记录在中心已存在更高版本。发送端将旧快照标为 superseded，不把旧赞自动抬高版本覆盖较新的撤销；后续真实评价变化才产生更高版本。

同一 `likeAvailable` 请求可分别收到以下 ACK（stale 示例假设中心已经保存到第 3 版）：

```json
{
  "schemaVersion": 1,
  "recordId": "cd7489ccdc42454e1fb795286dde7254ca1b9ed2b3f78ef299b4f89533fb97e6",
  "acceptedRevision": 1,
  "status": "applied"
}
```
```json
{
  "schemaVersion": 1,
  "recordId": "cd7489ccdc42454e1fb795286dde7254ca1b9ed2b3f78ef299b4f89533fb97e6",
  "acceptedRevision": 1,
  "status": "duplicate"
}
```
```json
{
  "schemaVersion": 1,
  "recordId": "cd7489ccdc42454e1fb795286dde7254ca1b9ed2b3f78ef299b4f89533fb97e6",
  "acceptedRevision": 3,
  "status": "stale"
}
```

**COMMIT 之后才能回应 200 ACK。** `200 {"ok":true}`、不匹配 recordId、错误版本、非法 JSON、超过 8 KiB 都不被确认。HTTP 202/204 也不表示成功；若接收端要先进入内部队列，必须自行保障“已可靠受理且后续不丢失”的协议设计，不能在本协议下随意提前确认数据库已提交。

### 4.2 非 200 与发送端反应

| 状态 / 故障 | 接收端含义 | 当前发送端 |
| --- | --- | --- |
| 400 | 请求/哈希/字段非法 | 保留并退避；管理员修复 |
| 401 / 403 | 凭据或身份绑定失败 | 保留并退避，清理本次凭据缓存后重读；需处理授权 |
| 404 | endpoint 路径错误 | 保留并退避；修配置后重启 |
| 409 | 同版本不同内容、身份冲突、preserve 无原记录 | 不确认；人工协调源数据/中心库恢复，不能盲目改为 200 |
| 413 | 大小超限 | 不自动截断正文；核对客户端及网关限制 |
| 429 | 服务繁忙 | 自身指数退避；当前**不解析 Retry-After** |
| 500 / 503 / 504 | 服务失败、不可用或超时 | 退避重试，接收端处理“已提交但 ACK 丢失”的幂等性 |
| 3xx | 地址重定向 | 不跳转，不转发凭据；重试原 endpoint |
| 网络错误、超时、非法 ACK | 送达状态不确定 | 保留待发状态，允许重复请求 |

建议失败体示例：`{"error":"revision_conflict"}`。发送端不依据 error 文本改变行为，也不把服务端原始错误输出给员工。重试基准从 5 秒指数增长至 300 秒，带 ±20% 抖动（最高基准对应约 240～360 秒）；高负载/前台活动会进一步推迟，不是实时上报 SLA。

## 5. 版本与正文状态的处理规则

1. 所有接收请求先校验来源身份、稳定主键、不可变关联与字段合法性，再比较版本。
2. 无原记录：replace 可插入；preserve 必须返回 409 `content_required`。
3. 同版本：原始请求相同返回 duplicate；不同返回 409 `revision_conflict`。
4. 小于中心版本：返回 stale 和中心的更高版本，不能把旧值覆盖进去。
5. 大于中心版本：覆盖最新评价/原因/时间；按 content.mode 处理正文；COMMIT 后 applied。
6. preserve 保留原正文，缺省字段不等于清空。即使 incoming replace 是 pending/missing/unverified，也不能覆盖中心已经 available 的问答。

排序按 revision，不按 HTTP 到达顺序、updatedAt、数据库时间或点击次数。版本允许跳号，也允许正文补齐时评价时间不变而版本增加。不会传输本地 sourceRevision、destinationKey、retainUntil、history、seen 或 outbox 内容。

参考接收器用 **SHA-256(原始 UTF-8 HTTP body 字节)** 作为 request_hash，以识别同版本是否原样重试。该 hash 与 answerHash 是不同用途，不是请求字段。JSON 属性顺序或空白变化会影响 request_hash；代理不得重写请求 JSON。生产如选择规范化哈希，应定义统一算法并做双方契约测试，不能各节点使用不同规则。

## 6. 完整请求示例

以下均为合成数据，可在本机接收器使用。示例 JSON 中没有省略号；真实 ID 的对应关系及哈希按实际算法生成。

### 6.1 首次点赞：保存一问一答

请求头 `Idempotency-Key: cd7489ccdc42454e1fb795286dde7254ca1b9ed2b3f78ef299b4f89533fb97e6:1`：

```json
{
  "schemaVersion": 1,
  "type": "dingtalk.feedback.snapshot",
  "recordId": "cd7489ccdc42454e1fb795286dde7254ca1b9ed2b3f78ef299b4f89533fb97e6",
  "revision": 1,
  "source": {
    "tenantId": "example-company",
    "instanceId": "employee-001",
    "accountId": "default",
    "channel": "dingtalk"
  },
  "cardId": "card_api_example_001",
  "questionerUserId": "user-001",
  "feedback": {
    "vote": "like",
    "reasons": [],
    "updatedAt": 1792886460000
  },
  "conversation": {
    "agentId": "main",
    "sessionKey": "agent:main:dingtalk:direct:user-001",
    "conversationId": "cid-example-dm-001",
    "sourceMsgId": "msg-example-001",
    "transcript": {
      "status": "linked",
      "source": "runtime-events",
      "sessionId": "11111111-1111-4111-8111-111111111111",
      "userMessageId": "question-message-001",
      "assistantMessageId": "answer-message-001"
    }
  },
  "answerHash": "af524e11317a949999cb8643f5045107ae6b631d56c3fb59545d9ce5f126a8cc",
  "createdAt": 1792886400000,
  "completedAt": 1792886410000,
  "content": {
    "mode": "replace",
    "status": "available",
    "question": "如何将在线文档导出为 PDF？",
    "answer": "打开文档，点击右上角“更多”，选择“导出为 PDF”。",
    "answerHash": "af524e11317a949999cb8643f5045107ae6b631d56c3fb59545d9ce5f126a8cc"
  }
}
```

### 6.2 撤销：同一记录更新为 none，保留原问答

先成功接收上例；实际中间可有点踩第 2 版（完整例在示例集合），第 3 版撤销如下。第 1 版后直接收到第 3 版也合法，不要求连续收齐。

```json
{
  "schemaVersion": 1,
  "type": "dingtalk.feedback.snapshot",
  "recordId": "cd7489ccdc42454e1fb795286dde7254ca1b9ed2b3f78ef299b4f89533fb97e6",
  "revision": 3,
  "source": {
    "tenantId": "example-company",
    "instanceId": "employee-001",
    "accountId": "default",
    "channel": "dingtalk"
  },
  "cardId": "card_api_example_001",
  "questionerUserId": "user-001",
  "feedback": {
    "vote": "none",
    "reasons": [],
    "updatedAt": 1792886580000
  },
  "conversation": {
    "agentId": "main",
    "sessionKey": "agent:main:dingtalk:direct:user-001",
    "conversationId": "cid-example-dm-001",
    "sourceMsgId": "msg-example-001",
    "transcript": {
      "status": "linked",
      "source": "runtime-events",
      "sessionId": "11111111-1111-4111-8111-111111111111",
      "userMessageId": "question-message-001",
      "assistantMessageId": "answer-message-001"
    }
  },
  "answerHash": "af524e11317a949999cb8643f5045107ae6b631d56c3fb59545d9ce5f126a8cc",
  "createdAt": 1792886400000,
  "completedAt": 1792886410000,
  "content": {
    "mode": "preserve",
    "status": "available",
    "answerHash": "af524e11317a949999cb8643f5045107ae6b631d56c3fb59545d9ce5f126a8cc"
  }
}
```

### 6.3 无精确引用：评价仍可入库

另一张卡片，不上传猜测正文。这里的 missing 指没有精确引用，不是文件一定被删除。

```json
{
  "schemaVersion": 1,
  "type": "dingtalk.feedback.snapshot",
  "recordId": "adb00b06c76754718d55ece6b38a51106bd54bd2b005b4de41690ea4888d8480",
  "revision": 1,
  "source": {
    "tenantId": "example-company",
    "instanceId": "employee-001",
    "accountId": "default",
    "channel": "dingtalk"
  },
  "cardId": "card_api_example_002",
  "questionerUserId": "user-001",
  "feedback": {
    "vote": "like",
    "reasons": [],
    "updatedAt": 1792886460000
  },
  "conversation": {
    "agentId": "main",
    "sessionKey": "agent:main:dingtalk:direct:user-001",
    "conversationId": "cid-example-dm-001",
    "sourceMsgId": "msg-example-002",
    "transcript": {
      "status": "unavailable",
      "reason": "events-unavailable"
    }
  },
  "answerHash": "af524e11317a949999cb8643f5045107ae6b631d56c3fb59545d9ce5f126a8cc",
  "createdAt": 1792886400000,
  "completedAt": 1792886410000,
  "content": {
    "mode": "replace",
    "status": "missing",
    "reason": "reference_not_recorded",
    "answerHash": "af524e11317a949999cb8643f5045107ae6b631d56c3fb59545d9ce5f126a8cc"
  }
}
```

### 6.4 预算不足：先报 pending

另一张卡片的评价先保存；稍后同卡以 revision=2、replace+available 补齐正文。完整补齐请求见示例集合的 `pendingResolved`，其 feedback.updatedAt 与此例相同。

```json
{
  "schemaVersion": 1,
  "type": "dingtalk.feedback.snapshot",
  "recordId": "1a9eee3f57a53222dafb2865173c1e91dcbd1c69216c86ed7b193caa8739b647",
  "revision": 1,
  "source": {
    "tenantId": "example-company",
    "instanceId": "employee-001",
    "accountId": "default",
    "channel": "dingtalk"
  },
  "cardId": "card_api_example_003",
  "questionerUserId": "user-001",
  "feedback": {
    "vote": "like",
    "reasons": [],
    "updatedAt": 1792886460000
  },
  "conversation": {
    "agentId": "main",
    "sessionKey": "agent:main:dingtalk:direct:user-001",
    "conversationId": "cid-example-dm-001",
    "sourceMsgId": "msg-example-003",
    "transcript": {
      "status": "linked",
      "source": "runtime-events",
      "sessionId": "11111111-1111-4111-8111-111111111111",
      "userMessageId": "question-message-003",
      "assistantMessageId": "answer-message-003"
    }
  },
  "answerHash": "af524e11317a949999cb8643f5045107ae6b631d56c3fb59545d9ce5f126a8cc",
  "createdAt": 1792886400000,
  "completedAt": 1792886410000,
  "content": {
    "mode": "replace",
    "status": "pending",
    "reason": "resource_budget"
  }
}
```

完整点踩及原因示例为 `dislikePreserve`；校验失败示例为 `unverifiedContent`。所有示例也嵌入 OpenAPI 的 requestBody.examples，可直接导入接口调试工具。

## 7. 接收端与 OceanBase 入库

### 7.1 原子处理顺序

```text
认证凭据 → 请求大小/Schema/主键/哈希校验
  → BEGIN → SELECT record_id FOR UPDATE
  → 核对不可变身份、比较 revision
  → INSERT / UPDATE / 判定重复或过期
  → COMMIT → 200 + 严格 ACK
```

无记录时并发 INSERT 可能冲突，必须依靠主键/唯一键，并回滚重试事务；不能只做无锁“先查后插”。所有 SQL 参数化。网络超时或客户端断开后，数据库可能已经提交；后续相同请求应 duplicate，不重复计票。

不可变关联包括 source 四项、cardId、questionerUserId、conversation 的 Agent/会话/原消息定位、已保存 transcript 的状态和具体消息 ID、answerHash、createdAt、completedAt；不能因收到更高版本就把同一记录改绑成另一问答。身份不一致返回 409。生产可进一步验证 transcript.source/reason 的一致性。

### 7.2 参考表字段映射

| SQL 列 | 数据来源 / 处理 |
| --- | --- |
| record_id | recordId 主键 |
| tenant_id / instance_id / account_id / card_id | source.tenantId / source.instanceId / source.accountId / cardId；联合唯一 |
| questioner_user_id | questionerUserId，不自动等同 Pod 所属员工 |
| revision / request_hash | 已提交的传输版本 / 原始请求字节 SHA-256 |
| vote / reasons_json | feedback.vote / JSON 序列化后的 feedback.reasons |
| agent_id / session_key | conversation.agentId / sessionKey |
| session_id / question_message_id / answer_message_id | linked 时的 transcript 三个精确 ID；无引用置 NULL |
| conversation_json | 整个 conversation JSON，包括原钉钉会话/消息 ID 和引用状态；不保留路径 |
| answer_hash | 顶层 answerHash；不存在时 NULL |
| content_status / content_reason | 已应用的正文状态/原因；preserve 时保留原值 |
| question_text / answer_text | 已核实 question/answer；preserve 或较弱状态不得清空已有 available 内容 |
| created_at_ms / completed_at_ms | createdAt / completedAt；后者可 NULL |
| feedback_at_ms | feedback.updatedAt |
| received_at_ms | 接收服务生成的本次提交时间，不冒充客户端字段 |

DDL 为参考宽度，不是所有上游 ID 的永久长度保证。接收方应校验部署中的 ID 长度与字符集，超限需扩表/明确拒绝，不可静默截断；保留 `utf8mb4_bin` 等区分大小写比较。revision 与毫秒时间用 BIGINT，避免 32 位溢出。

中心报表按 `vote IN ('like','dislike')` 统计最新有效票，none 为撤销。原因多选，不能把原因数量总和当点踩数。中心没有收到未评价卡片，因此**不能仅用上报表计算“全部回答中的评价率”**；本地 `/feedback stats` 与中心数据集/保留期也不完全相同。

## 8. 运维与注意事项

- 配置改变后重启加载。开启开关不会自动回填旧卡片；旧卡片下一次有效操作可能纳入同步，但没有引用的仍 missing。
- Pod 状态卷需持久化；同一目录单网关写入。Pod 重建后 tenantId、instanceId、accountId 保持稳定，不能两个实例克隆同一身份并各自写状态。
- endpoint/tenantId/instanceId 变化不会自动迁移已有待发记录；下一次真实评价会按当前目的地重新登记。迁移中心库时先规划身份、版本及待办，不能简单换 URL 后宣称历史全部已同步。
- token 在本地内存最多缓存 10 分钟；报告失败会清理本次缓存后重读。env 来源读取的是网关进程环境，修改 Kubernetes Secret 的环境变量不会改变已运行进程，需滚动重启；file 来源还受宿主 secret provider 行为影响。轮换凭据应保留合理重叠期并验收。
- 原数据保留到卡片到期与最后同步相关变更后 7 天的较晚者；不是无限重试保证。正文仅存在本地时若在采集前清理，中心只能收到缺失状态；已确认 available 正文按中心策略保留，插件不会因本地到期主动删除中心行。
- 首次获 ACK 前 outbox 可暂存被评价的一问一答；确认正文终态后移除本地待发正文。状态卷、接收库和备份按公司数据权限管理，不能把“只上传被评价问答”理解成“内容一定不敏感”。
- 高负载优先前台、推迟上报；每实例最多一个按需 Worker，不是常驻子进程或数据库连接池。默认内存/字节预算、实测及 SQLite 限制见功能文档。
- `/feedback stats` 是本地评价统计，不是 HTTP 投递状态。排查 `[DingTalk][FeedbackReport] saved/pending/superseded` 日志和 outbox/receipt，生产告警由运维接入；本版没有另一个员工上报管理页面。
- 中心丢库后收到 preserve 应 409；不要空建一行后确认。用备份恢复或规划明确重放工具，本版未交付通用重放入口。
- 联调接收器只做关键路径检查，不能替代生产认证、完整 Schema 校验、DB 事务、审计、限流与备份。不要把测试用 control.json 故障注入放进生产。

## 9. 最小端到端联调

1. 阅读 OpenAPI 并实现接收服务，或在本机启动随包接收器。使用纯测试凭据和合成数据。
2. 本机接收器的 `--tenant example-company --instance employee-001` 必须与示例一致；`FEEDBACK_REPORT_TOKEN` 通过环境注入，不能写进仓库。
3. 在源码根目录启动：

```bash
node scripts/feedback-reporting-receiver.mjs \
  --state-dir /tmp/feedback-api-contract \
  --tenant example-company --instance employee-001 --port 19071
```

4. 另一个终端使用相同测试 token 的环境，发送示例（不把 token 放在 URL 或命令参数中）：

```bash
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
const { requests } = JSON.parse(await readFile('docs/user/reference/feedback-reporting-examples.json', 'utf8'));
const request = requests.likeAvailable;
const response = await fetch('http://127.0.0.1:19071/v1/feedback/snapshots', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'authorization': `Bearer ${process.env.FEEDBACK_REPORT_TOKEN}`,
    'idempotency-key': `${request.recordId}:${request.revision}`,
  },
  body: JSON.stringify(request),
  signal: AbortSignal.timeout(5000),
});
console.log(response.status, await response.json());
JS
```

5. 先 applied，原样再发 duplicate；依次将变量 request 改为 dislikePreserve、withdrawPreserve，核对最终 none、正文保留。再发旧 likeAvailable，应 stale 且 acceptedRevision=3。
6. 在另一张独立卡测试 pendingBudget → pendingResolved，核对评价时间不变、版本递增、正文补齐。测试 missingReference、unverifiedContent 不含正文。
7. 同版本改正文/状态、身份不匹配、无原记录的 preserve、503/超时与 ACK 丢失、并发请求均要验证。生产 OceanBase 必须在公司测试环境执行事务与故障验收。
8. 最后用灰度插件真实提问、点赞、点踩、撤销，核对精确问答、无重复计票、正常聊天不等待网络。停止本机接收器并按测试数据策略清理。

新增接收服务不需要改变当前已支持 feedback_vote 的卡片模板，也不需要修改 Agent Gateway 或代回复助手。

本文基于 OpenClaw DingTalk Channel Plugin，YM Shen and contributors，MIT：<https://github.com/soimy/openclaw-channel-dingtalk>。
