# Backlog / Prioritized TODO

用于持续跟踪 `openclaw-channel-dingtalk` 的任务优先级、推进顺序和治理项。

---

## P0

### 1. 消息接收稳定性 / 长时间待机可靠性
相关 Issues：

任务：
- [ ] （拟完成，请评估）复核现有稳定性问题是否仍可复现
  - [x] [#96 fix(dingtalk): harden inbound message handling](https://github.com/soimy/openclaw-channel-dingtalk/pull/96)（状态：合并）
  - [x] [#167 fix(dingtalk): clean up heartbeat timer on reconnect](https://github.com/soimy/openclaw-channel-dingtalk/pull/167)（状态：合并）
  - [x] [#183 fix(dingtalk): add stale lock cleanup on send path](https://github.com/soimy/openclaw-channel-dingtalk/pull/183)（状态：合并）
  - [x] [#249 improve DingTalk connection troubleshooting](https://github.com/soimy/openclaw-channel-dingtalk/pull/249)（状态：合并）
- [ ] 明确各已合并 PR 的覆盖范围与遗漏场景
- [ ] 建立最小回归用例：常规收发、长待机后收发、断线恢复、连接失败排障
- [ ] 形成“已收敛 / 未收敛 / 需新增 issue”结论
- [x] 验证 `#313` 在“冷启动后立即主动发送”场景的稳定性
  - [x] [#313 fix: lazy-preload peer ID registry to fix 400 errors in delivery queue](https://github.com/soimy/openclaw-channel-dingtalk/pull/313)（状态：合并）
- [ ] 收敛 `#302/#303` 的复现路径与排障步骤
- [x] 验证 `#323/#325` 后长待机与恢复窗口是否仍出现“间歇性收不到消息”（关联 `#104` 新增反馈）
  - [x] [#323 fix: increase health check interval/grace to prevent reconnect storm](https://github.com/soimy/openclaw-channel-dingtalk/pull/323)（状态：合并）
  - [x] [#325 test(connection-manager): align health check timings with new 60s/30s constants](https://github.com/soimy/openclaw-channel-dingtalk/pull/325)（状态：合并）
- [ ] 结合 `#104` 新评论（指向 stream-sdk-nodejs#13）补充“连接存活但收不到入站事件”的链路级排查与可观测性
- [ ] 复核 `#336` 在低流量静默群聊下是否消除“空闲误重连”，并确认不影响真实断链恢复
  - [ ] [#336 fix: avoid idle reconnects on quiet DingTalk stream connections](https://github.com/soimy/openclaw-channel-dingtalk/pull/336)（状态：要求修改，已关闭未合并）
- [ ] 合并核对 `#345` 新反馈（markdown 模式也出现间歇性丢回复），确认是否与连接层问题同源
- [ ] 汇总 `#104` 最新反馈中“群聊需 @ 才稳定触发”的现象，区分上游丢消息与群聊触发条件导致的假阳性
- [ ] 跟进 `#373` 的版本升级回归（3.2 -> 3.4.0）与日志采样，新增“连接到内网地址”证据，确认是否与 `#104/#345` 同源
- [x] 跟进 `#390` 的 callback ack 时序修复方案，补齐 `no-dedupKey` 与 in-flight 分支 ACK 行为一致性回归
  - [x] [#392 fix: acknowledge DingTalk callback immediately to prevent redelivery](https://github.com/soimy/openclaw-channel-dingtalk/pull/392)（状态：合并）
- [x] 跟进终态 FAILED 后 `waitForStop` 卡死导致无法自动恢复的问题，并确认修复已落地
  - [x] [#399 fix: resolve waitForStop on terminal FAILED state](https://github.com/soimy/openclaw-channel-dingtalk/pull/399)（状态：合并）
- [x] 同步 `#400` 已关闭结论（关联 `#399`），后续仅保留旧版本存量告警观察

### 2. AI Card 发送链路一致性
相关 Issues：

任务：
- [ ] 回归 Done 提前结束问题
- [ ] 回归空回复问题
- [ ] 回归主动通知内容异常问题
- [ ] 回归重复输出问题
- [ ] 判断剩余问题是否需要拆出新的修复任务
- [ ] 回归 `sessionWebhook` 过期后的 fallback 发送路径（#319）
- [x] 回归媒体消息 `仅媒体/仅文本/媒体+文本` 的 deliver 组合行为（#321/#311）
  - [x] [#311 fix: deliver MEDIA attachments in inbound reply handler](https://github.com/soimy/openclaw-channel-dingtalk/pull/311)（状态：合并）
- [ ] 评估并实现 `card.stream` 节流/合并策略，降低限流风险（#318）
  - [ ] [#179 hardening send path](https://github.com/soimy/openclaw-channel-dingtalk/pull/179)（状态：要求修改，已关闭未合并）
  - [x] [#191 serialize send pipeline with session-scoped dispatch lock](https://github.com/soimy/openclaw-channel-dingtalk/pull/191)（状态：合并）
- [x] 复核 reasoning 重复堆叠修复是否稳定（#290/#291）
  - [x] [#291 fix(card): use replace mode for reasoning stream to prevent content duplication](https://github.com/soimy/openclaw-channel-dingtalk/pull/291)（状态：合并）
- [x] 回归“多个 final chunk + 工具报错”场景，确认最终输出不会被吞（#326）
  - [x] [#326 feat: support multiple final chunk](https://github.com/soimy/openclaw-channel-dingtalk/pull/326)（状态：合并）
- [x] 复核 `#327` 恢复后的 reply-stream 契约是否完整（`cardUpdateMode=replace`、`payload.text` 路径）
  - [x] [#327 fix(dingtalk): restore non-session inbound logic regressed by #307](https://github.com/soimy/openclaw-channel-dingtalk/pull/327)（状态：合并）
- [x] 复核 `#231` 合并后的真实净变更与 `#208` 关闭结论是否一致，避免“状态已关闭但用户侧仍无错误提示”
  - [x] [#231 fix: don't suppress stop reason](https://github.com/soimy/openclaw-channel-dingtalk/pull/231)（状态：合并）
- [x] 跟进 `#311` 的 review blocking 项，基于已 rebase 分支复核 deliver MEDIA 边界（入站回包/主动回复/卡片并行）
  - [x] [#311 fix: deliver MEDIA attachments in inbound reply handler](https://github.com/soimy/openclaw-channel-dingtalk/pull/311)（状态：合并）
- [x] 复盘 `#334` 对 `#295` 的回滚影响，明确 async ack 是否保留为后续可选能力
  - [x] [#295 feat(dingtalk): 增加异步回执模式](https://github.com/soimy/openclaw-channel-dingtalk/pull/295)（状态：合并）
  - [x] [#334 Revert "feat(dingtalk): 增加异步回执模式"](https://github.com/soimy/openclaw-channel-dingtalk/pull/334)（状态：合并）
- [x] 校验 `#300/#335` 的 markdown 表格兼容策略与默认值，避免不同钉钉客户端表现分叉
  - [x] [#300 feat(dingtalk): 优化 Markdown 表格发送兼容性](https://github.com/soimy/openclaw-channel-dingtalk/pull/300)（状态：合并）
  - [x] [#335 feat: add convertMarkdownTables config option](https://github.com/soimy/openclaw-channel-dingtalk/pull/335)（状态：合并）
- [ ] 基于 `#198/#292` 复核“工具流发送失败不应中断后续正文回复”的错误分级与降级路径
- [ ] 跟进 `#396` 内置卡片模板与停止按钮方案，复核其与 `message-context-store` 主路径的一致性后再决定合入
  - [ ] [#396 feat(card): built-in AI card template with stop button support](https://github.com/soimy/openclaw-channel-dingtalk/pull/396)（状态：已关闭未合并）
- [x] 跟进 `#444` 重提的内置卡片模板 + 停止按钮方案，当前已合并入 `main`，后续重点转向与 v2 草稿方案的重叠收敛
  - [x] [#444 feat(card): built-in AI card template with stop button support](https://github.com/soimy/openclaw-channel-dingtalk/pull/444)（状态：合并）
- [ ] 跟进 `#448/#480` 的 AI Card v2 结构化 `CardBlock[]` 草稿方案，评估其与 `#444` 的重叠/替代关系后再决定推进路径
  - [ ] [#448 refactor: AI Card v2 — structured CardBlock[] with preset template](https://github.com/soimy/openclaw-channel-dingtalk/pull/448)（状态：新（草稿））
  - [ ] [#480 feat(card): implement card template v2 with rich block content and action btns](https://github.com/soimy/openclaw-channel-dingtalk/pull/480)（状态：审核中（review follow-up 已补，待复核；CI 通过））
- [x] 跟进 `#427` 文本停止指令 pre-lock bypass 方案，补“空确认文本兜底 + 多次 deliver 文本选取”回归后再评估合入
  - [x] [#427 feat: bypass session lock for real-time stop command support](https://github.com/soimy/openclaw-channel-dingtalk/pull/427)（状态：合并）
- [x] 跟进 AI Card finalize 收尾修复并回归“多轮 tool + final chunk + 首行重复”组合场景（#348/#350/#352）
  - [x] [#348 fix(card): use accumulated content for AI Card finalization](https://github.com/soimy/openclaw-channel-dingtalk/pull/348)（状态：合并）
  - [x] [#350 fix(card): fix AI Card streaming finalization bugs](https://github.com/soimy/openclaw-channel-dingtalk/pull/350)（状态：合并）
  - [x] [#352 fix(card): fix AI Card streaming finalization bugs](https://github.com/soimy/openclaw-channel-dingtalk/pull/352)（状态：合并）
- [x] 回归 Markdown 模式分块回复被拆分问题，确认非卡片模式走单次投递（#360）
  - [x] [#361 fix(markdown): disable block streaming in markdown mode to prevent split messages](https://github.com/soimy/openclaw-channel-dingtalk/pull/361)（状态：合并）
- [x] 复核 `#368` reply strategy 重构后 card/markdown 投递行为与动态 reaction 装饰器兼容性
  - [x] [#368 refactor: extract ReplyStrategy interface for streaming reply dispatch](https://github.com/soimy/openclaw-channel-dingtalk/pull/368)（状态：合并）
- [ ] 复盘 `#363` 关闭未合并方案与当前主线差异，确认其风险点已被后续修复覆盖
  - [ ] [#363 fix(card): prevent duplicate cards and disable unused block streaming](https://github.com/soimy/openclaw-channel-dingtalk/pull/363)（状态：已关闭未合并）
- [ ] 跟进 `#357` 升级后“卡片仅处理中”反馈，核对 `cardRealTimeStream` 默认值与迁移提示
- [ ] 跟进 `#358` 的表格转换后续（是否移除历史 `convertMarkdownTablesToPlainText` 路径）并补跨端渲染回归
- [ ] 跟进 `#379` 的“上游返回 0 字节时钉钉前端无错误反馈”场景，明确插件侧兜底提示与日志建议（`/verbose on`）边界
- [ ] 跟进 `#407` 的“card 模式下无回复 + ackReaction 不显示”现场，区分卡片发送链路异常与 thinking 反馈配置问题
- [ ] （拟完成，请评估）跟进 `#513` 的 session-recovery 卡片冻结问题：当前已补 markdown fallback 兜底，仍需在 Anthropic thinking recovery 实机路径确认第二轮恢复后的最终用户观感
  - [x] [#518 fix(card): deliver markdown fallback when session-recovery updates a finished card](https://github.com/soimy/openclaw-channel-dingtalk/pull/518)（状态：合并）
- [ ] 跟进 `#457` 对 `/reasoning on` 与 `/reasoning stream` 的统一交付方案，确认多轮 assistant turn 与 finalize 边界在 card 模式稳定
  - [ ] [#457 fix(card): unify reasoning-on and reasoning-stream block delivery](https://github.com/soimy/openclaw-channel-dingtalk/pull/457)（状态：审核中）
- [ ] 跟进 `#543` 的同会话并发建卡 guard：复核“单卡片 + markdown 降级”路径、P2 review 建议与真机快速连发验证
  - [ ] [#543 fix(card): prevent duplicate card creation via synchronous in-flight guard](https://github.com/soimy/openclaw-channel-dingtalk/pull/543)（状态：审核中（CI 通过，Greptile 仅 P2 风格建议））
- [ ] 复核 `#419` 关闭结论：确认“会话锁外提前建卡/空 Done 卡片”修复是否已入 `main`；若未落地，按最小补丁重提
  - [ ] [#418 fix: use dispatch counts to prevent empty "Done" card finalize](https://github.com/soimy/openclaw-channel-dingtalk/pull/418)（状态：已关闭未合并）

### 3. 文件上传 / 文件读取 / 文件预览 / 大文件链路
相关 Issues：
- [#422 机器人无法发送文件的问题](https://github.com/soimy/openclaw-channel-dingtalk/issues/422)（状态：已关闭（2026-04-25 自动关闭，可重开））
- [#430 群聊怎么给openclaw发文件呢?](https://github.com/soimy/openclaw-channel-dingtalk/issues/430)（状态：已关闭（2026-04-26 自动关闭，可重开））
- [#482 [Bug] v3.5.1 发送文件到钉钉时文件名显示为 #fileName# 而非实际文件名](https://github.com/soimy/openclaw-channel-dingtalk/issues/482)（状态：已关闭（2026-04-26 自动关闭，可重开））

任务：
- [ ] 核对基础文件发送能力的当前边界
- [ ] 拆分文件上传、读取、预览、扩展名处理、大文件、钉盘访问子任务
- [ ] 为每个子任务补最小复现和验收标准
- [ ] 明确哪些属于补尾，哪些需要新增开发
- [ ] 复核 `#315` 场景在当前版本中的行为与诊断提示是否一致
  - [ ] [#68 feat(dingtalk): implement file uploading with send image, video and file support](https://github.com/soimy/openclaw-channel-dingtalk/pull/68)（状态：要求修改，已关闭未合并）
- [x] 评估 `#298` 的附件正文抽取边界（类型/长度/失败回退）与现有文件链路兼容性
  - [x] [#298 feat(dingtalk): 支持入站附件正文抽取](https://github.com/soimy/openclaw-channel-dingtalk/pull/298)（状态：合并）
- [ ] 跟进 `#207` 新增进展：`robotCode` 已配置仍失败，补充“企业认证/权限付费门槛”前置条件说明
- [ ] 将 `#366` 的“文本正常但文件发送失败”场景补充到文件链路最小复现矩阵，并对齐与 `#207/#315` 的同源性判断
- [ ] 合并 `#270` 的“仅文件占位符”现场日志，补齐“下载成功但提取失败”与“未落盘”两类分流排障步骤
- [ ] 跟进 `#391` 的钉盘自然语言检索诉求，明确“仅引用直发/文件名模糊搜索/全量语义搜索”分级能力与前置权限
- [x] 跟进 `#505/#482` 的“原始文件名透传 / 文件名显示异常”回归，确认原始文件名已透传到 `saveMediaBuffer` 与消息上下文链路，并区分插件侧透传与钉钉落地文件重命名
  - [x] [#506 fix: forward original filename to saveMediaBuffer (#505)](https://github.com/soimy/openclaw-channel-dingtalk/pull/506)（状态：合并）
- [x] 跟进 `#397` 的 sandbox 路径兼容缺口，`sendMedia -> uploadMedia` 已补齐 `loadWebMedia` 桥接能力
  - [x] [#398 fix: sandbox sendMedia fails for workspace files](https://github.com/soimy/openclaw-channel-dingtalk/pull/398)（状态：合并）
- [x] 跟进 `#411` 恢复“附件抽取文本注入 inbound body”修复并确认 quotedRef 链路已补齐（file/audio/video + Step 0 下载）
  - [x] [#411 fix: 修复引用文件/音频/视频消息下载及附件文本注入](https://github.com/soimy/openclaw-channel-dingtalk/pull/411)（状态：合并）
- [ ] 补充 `#415` 单聊收文件失败最小复现：区分“单聊附件入站限制”与“提取/落盘链路异常”
- [ ] 跟进 `#422` 的“模型不会触发文件发送动作”反馈，补充提示词/动作能力边界说明与可复现样例
- [ ] 跟进 `#430` 群聊文件读取反馈：确认 `#411` 发布版本已覆盖“引用文件 + @Bot”路径，并补权限/时效性说明与版本提示
- [x] 跟进 `#442` 入站附件下载超时阻塞问题，补“第二跳下载 timeout + host 日志”回归
  - [x] [#443 fix: add timeout and host logging for inbound media download](https://github.com/soimy/openclaw-channel-dingtalk/pull/443)（状态：合并）
- [ ] 跟进 `#452/#454` 的 messaging 分域迁移 PR，确认 `quoted-file-service` 与 `attachment-text-extractor` 搬迁后文件链路回归覆盖完整
  - [ ] [#452 refactor(messaging): move quoted file helpers into messaging](https://github.com/soimy/openclaw-channel-dingtalk/pull/452)（状态：通过）
  - [ ] [#454 refactor(messaging): move attachment text extraction into messaging](https://github.com/soimy/openclaw-channel-dingtalk/pull/454)（状态：通过）

### 4. 图片 / 语音 / 媒体链路补强
相关 Issues：
- [#542 单条消息多张图片只收到第一张，mediaPaths 未处理](https://github.com/soimy/openclaw-channel-dingtalk/issues/542)（状态：开启）

任务：
- [ ] 回归本地图片发送
- [ ] 跟进 `#542` 的富文本多图片入站链路：确认 `message-utils.ts` 已提取 `mediaPaths` 后，补 `inbound-handler.ts` 多媒体下载、上下文注入与回归用例
- [ ] 回归语音消息发送
- [ ] （拟完成，请评估）跟进 `#516` 的媒体类型判定回归：`.mp3` 默认按附件发送的修复已合入，仍需补一次 v3.5.3 升级后的文件/语音分流实机回归
  - [x] [#517 fix(media): default audio files to attachment instead of voice message](https://github.com/soimy/openclaw-channel-dingtalk/pull/517)（状态：合并）
- [ ] 回归入站媒体大小限制覆盖配置
- [ ] （拟完成，请评估）评估 AI Card 内媒体一体化展示是否值得推进
  - [x] [#181 add mediaMaxMb override for inbound media size limit](https://github.com/soimy/openclaw-channel-dingtalk/pull/181)（状态：合并）
  - [x] [#182 support local image sending](https://github.com/soimy/openclaw-channel-dingtalk/pull/182)（状态：合并）
  - [x] [#200 support asVoice for media messages](https://github.com/soimy/openclaw-channel-dingtalk/pull/200)（状态：合并）
  - [x] [#311 fix: deliver MEDIA attachments in inbound reply handler](https://github.com/soimy/openclaw-channel-dingtalk/pull/311)（状态：合并）
- [ ] 明确哪些项已完成、哪些项仍待开发
- [ ] 回归 Windows 绝对路径/相对路径下图片与文件发送（#316, #241）
- [x] 跟进 `#248` 的 `mediaUrl` 路径归一化修复，并在 rebase 到最新 `main` 后回归远端 URL/本地路径分流
  - [x] [#248 fix(dingtalk): prepare mediaUrl in action send before upload](https://github.com/soimy/openclaw-channel-dingtalk/pull/248)（状态：合并）
- [ ] 针对 `#333` 增补 `robotCode` 缺失/错误时的启动校验与日志提示，避免仅出现 `<media:image>` 占位文本
- [ ] 明确 `#351` 的能力边界说明（客户端压缩 / API 不支持原图参数），在文档中补“可控项与不可控项”说明
- [ ] 跟进 `#365` 的图片占位符问题，修复 `sampleImageMsg` 参数与上传 `mediaId` 语义不匹配
- [ ] 将 `#394` 纳入图片入站回归矩阵，补充“仅识别为 [图片] 占位符”场景的格式/大小/日志采样
- [ ] 合并 `#394` 最新评论，补充“模型是否支持多模态”的前置检查与提示路径
- [ ] 跟进 `#408` 的 DM TTS 附件链路：区分 `deliverMediaAttachments` 与 `sendMedia` 路径，补“回复型语音附件”回归与降级提示
- [x] 同步 `#429` 关闭结论：移除 `[media_path:]` 注入后，sandbox 模式媒体读取回归
  - [x] [#432 fix: remove [media_path:] body injection to fix sandbox media access](https://github.com/soimy/openclaw-channel-dingtalk/pull/432)（状态：合并）

---

## P1

### 5. 引用消息 / chatRecord / 转发记录解析收口
相关 Issues：

任务：
- [ ] 梳理各 PR 的前后替代关系
  - [x] [#128 feat(dingtalk): support quoted messages](https://github.com/soimy/openclaw-channel-dingtalk/pull/128)（状态：合并）
  - [ ] [#202 fix(dingtalk): improve quote and forward handling](https://github.com/soimy/openclaw-channel-dingtalk/pull/202)（状态：要求修改，已关闭未合并）
  - [ ] [#209 fix(dingtalk): handle empty forward payload](https://github.com/soimy/openclaw-channel-dingtalk/pull/209)（状态：要求修改，已关闭未合并）
  - [ ] [#210 fix(dingtalk): improve quote journal compatibility](https://github.com/soimy/openclaw-channel-dingtalk/pull/210)（状态：要求修改，已关闭未合并）
  - [ ] [#233 quote/chatRecord/stream-card hardening](https://github.com/soimy/openclaw-channel-dingtalk/pull/233)（状态：要求修改，已关闭未合并）
  - [x] [#257 clarify empty chatRecord payload behavior](https://github.com/soimy/openclaw-channel-dingtalk/pull/257)（状态：合并）
- [ ] 明确引用消息解析的最终行为
- [ ] 明确 chatRecord 空内容提示策略
- [ ] 明确转发记录展示策略
- [ ] 做一次集中回归并沉淀结论
- [ ] 补充富文本 markdown/代码块引用场景回归，确认引用内容传递边界（#286）
- [x] 跟进 `#507` 的 chatRecord 引用摘要修复，确认 `repliedMsg.content.summary/title` 会进入 quoted preview
  - [x] [#507 fix: parse chatRecord summary from repliedMsg content](https://github.com/soimy/openclaw-channel-dingtalk/pull/507)（状态：合并）
- [x] 跟进 `#503` 的 quote visibility follow-up，确认群聊 quoted sender allowlist 不再串用 DM `allowFrom`，并统一布尔解析 helper
  - [x] [#503 fix(inbound): follow-up(#499) harden helper warning and quote visibility](https://github.com/soimy/openclaw-channel-dingtalk/pull/503)（状态：合并）
- [x] 评估 `#364/#371` 的消息上下文持久化统一方案对 quote/chatRecord 的迁移兼容与回归面
  - [x] [#364 feat: unify message context persistence](https://github.com/soimy/openclaw-channel-dingtalk/pull/364)（状态：合并）
  - [x] [#371 fix: unify message context journaling scope](https://github.com/soimy/openclaw-channel-dingtalk/pull/371)（状态：合并）
- [x] 落地 `quotedRef` 引用链并对齐 runtime reply context（#375/#377/#378）
  - [x] [#375 feat: add quotedRef-based reply reference chain](https://github.com/soimy/openclaw-channel-dingtalk/pull/375)（状态：合并）
  - [x] [#377 feat: translate quotedRef chain into runtime reply context](https://github.com/soimy/openclaw-channel-dingtalk/pull/377)（状态：合并）
  - [x] [#378 fix: remove undefined quotedPrefix in text message extraction](https://github.com/soimy/openclaw-channel-dingtalk/pull/378)（状态：合并）
- [x] 跟进 `#389` 对 `#377` 的后续补丁（preview fallback/attachment excerpt/TTL），确认与现有 `message-context-store` 语义一致并已合入
  - [x] [#389 feat: inject quoted reply context for agent runtime](https://github.com/soimy/openclaw-channel-dingtalk/pull/389)（状态：合并）
- [ ] （拟完成，请评估）跟进 `#401` quoted-only 回归修复的后续项：补 handler 层回归测试，并评估 QuotedRef-first 输入策略
  - [x] [#401 fix: fallback to quoted previewText when reply text is empty](https://github.com/soimy/openclaw-channel-dingtalk/pull/401)（状态：合并）
- [ ] 跟进 `#525` 的 chatRecord 明细解析补强：确认 `chatRecord/records/messages` 三种别名、summary-only 平台边界与注释说明已齐备，待合入后再做集中回归
  - [ ] [#525 Handle detailed DingTalk chatRecord payloads](https://github.com/soimy/openclaw-channel-dingtalk/pull/525)（状态：通过（待合入））
- [ ] 跟进 `#515` 的 quoted chain 可见性收口：确认 `allowlist/allowlist_quote` 只保留连续可见 hop，避免 deeper blocked chain 继续泄漏到 runtime
  - [ ] [#515 fix(inbound): trim blocked quoted chain context](https://github.com/soimy/openclaw-channel-dingtalk/pull/515)（状态：新（草稿，CI 通过））

### 6. 建立 Issue 提交标准化
任务：
- [ ] 新增 Bug report 模板
- [ ] 新增 Feature request 模板
- [ ] 新增 Regression report 模板
- [ ] 新增 Docs / onboarding 模板
- [ ] 统一必填字段：版本、部署方式、AI Card、messageType、复现步骤、预期/实际、日志、复现稳定性
- [ ] 建立标签标准：stability / streaming / media / files / ai-card / multi-agent / docs
- [ ] 在 README 或贡献文档中补提单说明

### 7. 建立 PR / Issue 自动化流程
相关参考：
- [npm publish workflow](https://github.com/soimy/openclaw-channel-dingtalk/blob/main/.github/workflows/npm-publish.yml)

任务：
- [ ] 新增 PR Template
- [ ] 增加 Issue / PR labeler
- [ ] 增加 stale 自动提醒
- [ ] 增加 needs-info 自动提醒
- [ ] 增加 `Closes #...` / `Refs #...` 校验
- [ ] 增加 PR CI gate：type-check / lint / test
- [ ] 增加 release note automation
- [ ] 规划自动化分阶段落地顺序

---

## P2

### 8. 多账号 / 多 agent / schema 与路由配置收敛
相关 Issues：
- [#460 [问题反馈] 多agent模式下, 通过@助手 /new /stop 等执行失败](https://github.com/soimy/openclaw-channel-dingtalk/issues/460)（状态：已关闭（2026-04-29 自动关闭，可重开））
- [#492 可以支持不同的人，通过同一个钉钉机器人，会话绑定到不同的agent里吗？](https://github.com/soimy/openclaw-channel-dingtalk/issues/492)（状态：已关闭（2026-04-26 自动关闭，可重开））
- [#530 [功能建议] 刚需，多agent协同办公](https://github.com/soimy/openclaw-channel-dingtalk/issues/530)（状态：已关闭（2026-04-29 自动关闭，可重开））

任务：
- [ ] 补齐配置示例
- [ ] 增加配置校验
- [ ] 优化启动时报错
- [ ] 补齐文档说明
- [ ] 跟进 `#514` 的多账号 schema 报错反馈：issue 已关闭，当前重点转为补 `accounts.main/default` 形态、遗留 `corpId/robotCode` 字段与缓存命中旧 schema 的迁移说明
- [ ] 跟进 `#528` 的 `clientSecret` SecretInput 支持：review 仍停留在要求修改，已补 trust boundary 文案、`maxLength` 与 file-source 测试，待 reviewer 翻转
  - [ ] [#528 feat: support SecretInput for DingTalk clientSecret](https://github.com/soimy/openclaw-channel-dingtalk/pull/528)（状态：要求修改）
- [ ] 吸收 `#492` 的“同一机器人按用户路由到不同 agent”案例：补 `bindings.peer.id` / `direct` staffId 示例，并明确这属于框架 routing 能力而非插件新增特性
- [ ] 跟进 `#460` 的多 agent 指令路由回归：复核 `#478` 在当前版本对 `@agent /new`、`@agent /stop` 与 `/reasoning stream` 的覆盖范围，并补最小复现与版本结论
- [ ] 区分 `#530` 的“用户直接 @agent 路由”与“Agent 间自主通信并回写群聊”两类诉求，明确前者已有能力边界、后者是否需要新的编排/回传方案
- [x] 明确 `session-alias` 与框架 routing bindings 的职责边界（#307）
  - [x] [#307 feat(dingtalk): 支持 owner 控制群共享会话别名](https://github.com/soimy/openclaw-channel-dingtalk/pull/307)（状态：合并）
- [x] 评估 `@sub-agent` 能力与现有路由模型整合方案（#317）
  - [x] [#132 多账号 schema / ControlUI 兼容相关](https://github.com/soimy/openclaw-channel-dingtalk/pull/132)（状态：合并）
  - [x] [#133 feat(dingtalk): add multi-account schema support](https://github.com/soimy/openclaw-channel-dingtalk/pull/133)（状态：合并）
  - [x] [#137 refactor(dingtalk): modularize channel implementation](https://github.com/soimy/openclaw-channel-dingtalk/pull/137)（状态：合并）
  - [x] [#317 feat(dingtalk): add @sub-agent basic support for group chat multi-agent scenarios](https://github.com/soimy/openclaw-channel-dingtalk/pull/317)（状态：合并）
- [x] 复核 dashboard schema 渲染与 legacy key 归一化行为在 UI/Raw 配置路径的一致性（#304/#324）
  - [x] [#324 fix(config): resolve dashboard Unsupported schema node for #304](https://github.com/soimy/openclaw-channel-dingtalk/pull/324)（状态：合并）
- [x] 跟进 `#317` review blocking 项与“先暂缓”结论，冻结范围在基础路由能力并避免再次回归 `#327` 已修复的 inbound 能力
  - [x] [#317 feat(dingtalk): add @sub-agent basic support for group chat multi-agent scenarios](https://github.com/soimy/openclaw-channel-dingtalk/pull/317)（状态：合并）
  - [x] [#327 fix(dingtalk): restore non-session inbound logic regressed by #307](https://github.com/soimy/openclaw-channel-dingtalk/pull/327)（状态：合并）
- [ ] 排查并修复 `#185` 反馈的多 agent workspace 绑定异常（疑似默认 `main` 绑定导致配置失效）
- [ ] 补充 `#185/#267` 的“多账号配置是否生效”快速诊断步骤，减少重复提问
- [ ] 跟进 `#354` 的 `peer.kind/peer.id` 绑定案例：新增“staffId 配置正确仍不生效”反馈，补最小复现与 `peerId/senderStaffId` 对照日志诊断
- [ ] 吸收 `#510` 的配置追问：补充 `allowFrom` / `groupAllowFrom` / `cid/...` 的最小可用示例，并说明群聊白名单不命中时的排查步骤
- [ ] 复核 `#356` 的 schema 导入路径争议，确认 `buildChannelConfigSchema` 兼容策略后再决定是否合入
  - [ ] [#356 fix: import buildChannelConfigSchema from plugin-sdk/discord](https://github.com/soimy/openclaw-channel-dingtalk/pull/356)（状态：已关闭未合并）
- [x] 评估 `#372` 的 displayName 目标目录学习能力与既有 routing 规则的兼容性（命名冲突、跨群歧义、隐私边界）
  - [x] [#372 feat: add displayName-based target learning and resolution](https://github.com/soimy/openclaw-channel-dingtalk/pull/372)（状态：合并）
- [x] 收敛 `main` 会话默认路由 owner 隔离，避免群聊流量意外接管私聊主会话（#382）
  - [x] [#382 fix(dingtalk): 限制 main 会话默认路由只被 owner 接管](https://github.com/soimy/openclaw-channel-dingtalk/pull/382)（状态：合并）
- [x] 补齐群聊访问控制（allowlist/sender restriction/disabled）并确认 legacy `allowFrom` 兼容（#385）
  - [x] [#385 feat: group access control with per-group allowlist, sender restriction, and disabled policy](https://github.com/soimy/openclaw-channel-dingtalk/pull/385)（状态：合并）
- [ ] 跟进 `#380` HTTP callback 多实例方案的 review 阻塞项（签名校验、TOPIC_CARD 回调行为、部署文档边界）
  - [ ] [#380 feat(dingtalk): add HTTP callback mode for multi-instance deployment](https://github.com/soimy/openclaw-channel-dingtalk/pull/380)（状态：要求修改）
- [ ] 跟进 `#383` 入站命令分发抽离重构，确认 command 域边界与现有 owner/session 命令回归覆盖
  - [ ] [#383 refactor(dingtalk): 抽离入站命令分发逻辑](https://github.com/soimy/openclaw-channel-dingtalk/pull/383)（状态：通过）
- [x] 跟进 `#395` plugin-sdk API 对齐分支并完成兼容层回归（入口/类型导出/onboarding）
  - [x] [#395 refactor(dingtalk): Sync upstream plugin-sdk new API](https://github.com/soimy/openclaw-channel-dingtalk/pull/395)（状态：合并）
- [ ] 跟进 `#472` 的 scoped import 对齐收尾，确认 `command-auth` 测试 mock 与 peer dependency 约束后再合入
  - [ ] [#472 fix(plugin-sdk): align scoped imports with latest sdk](https://github.com/soimy/openclaw-channel-dingtalk/pull/472)（状态：新）
- [x] 跟进 `#412` 的 DM `@sub-agent` 路由方案，重点复核 DM richText/quoted 场景误触发与回归覆盖
  - [x] [#412 feat: support @mention sub-agent routing in DM (direct messages)](https://github.com/soimy/openclaw-channel-dingtalk/pull/412)（状态：合并）
- [x] 跟进 `#453` targeting 分域迁移，确认 group member store 搬迁后路由与缓存语义保持不变
  - [x] [#453 refactor(targeting): move group member store into targeting domain](https://github.com/soimy/openclaw-channel-dingtalk/pull/453)（状态：合并）
- [ ] 跟进 `#420` 私聊会话疑似误路由反馈：补 `senderStaffId/senderOriginalId` 冲突诊断日志与复现用例

### 9. 支持群聊 @人 / @all
相关 Issues：
- [#353 如何让龙虾在群里中@其他成员](https://github.com/soimy/openclaw-channel-dingtalk/issues/353)（状态：已关闭（2026-04-25 自动关闭，可重开））
- [#417 在钉钉群里，@机器人后让他生成图片发群里，结果发了一条全员钉钉通知](https://github.com/soimy/openclaw-channel-dingtalk/issues/417)（状态：已关闭（2026-04-25 自动关闭，可重开））
- [#522 [功能建议] AI Card支持@User响应](https://github.com/soimy/openclaw-channel-dingtalk/issues/522)（状态：已关闭（2026-04-28 自动关闭，可重开））

任务：
- [ ] （拟完成，请评估）明确 @单人 需求范围
  - [x] [#317 feat(dingtalk): add @sub-agent basic support for group chat multi-agent scenarios](https://github.com/soimy/openclaw-channel-dingtalk/pull/317)（状态：合并）
- [ ] 明确 @多人 需求范围
- [ ] 明确 @all 需求范围
- [ ] 设计失败降级与兼容行为
- [ ] 整理 `#288/#305` 重复诉求，收敛为 `#67` 验收标准
- [ ] 同步 `#486` 的平台侧结论：明确“仅 @所有人”不会触发机器人回调，并补“同时 @机器人 / 改走 webhook”两条替代路径
- [ ] 跟进 `#305` 新增用户追问，补充当前版本可行配置与仍未覆盖场景的状态说明
- [ ] 跟进 `#353` 最新追问（是否排期），补当前“仅 @sender 能力”与“@指定成员待规划”状态说明
- [ ] 跟进 `#417` 的“触发全员工作通知”风险，补充 `@all` 防护说明与默认关闭/显式开启策略
- [ ] 合并 `#522` 的 AI Card 群聊可追溯诉求：明确应走 `atUsers`、引用原消息，还是与 `#480` 的卡片引用回复方案组合交付
- [x] 明确 card 模式下 `@sender` 通知能力边界，避免与“@指定成员”诉求混淆（#369）
  - [x] [#369 feat: add cardAtSender option to @mention sender after card finalization](https://github.com/soimy/openclaw-channel-dingtalk/pull/369)（状态：合并）

### 10. 支持对话打断 / 取消任务
相关 Issues：

任务：
- [ ] 明确用户主动取消的交互形式
- [ ] 明确长任务中断机制
- [ ] 明确中断后状态回收方式
- [ ] 明确 UI / 提示语反馈
- [ ] 明确 ACP 最小可用范围（`/acp spawn`）及 `status/steer/cancel` 分阶段目标（#310）
- [ ] （拟完成，请评估）跟进 `#508` 的 `/btw` 旁路问答方案，确认“绕过 session lock + 强制 markdown + 不新建卡片”在实机卡片/群聊场景稳定
  - [x] [#508 feat(btw): bypass session lock for /btw side questions](https://github.com/soimy/openclaw-channel-dingtalk/pull/508)（状态：合并）
- [ ] 跟进 `#489` 的原生审批卡片方案，确认 approval callback / 文本命令回退 / origin surface 投递边界后再决定是否推进
  - [ ] [#489 feat(approval): exec/plugin approval card with command session dispatch](https://github.com/soimy/openclaw-channel-dingtalk/pull/489)（状态：新（草稿，CI 通过））
- [x] 评估 `#427` 的“停止指令绕过 session 锁”方案与现有卡片停止流程整合边界（避免空卡片 finalize）
  - [x] [#427 feat: bypass session lock for real-time stop command support](https://github.com/soimy/openclaw-channel-dingtalk/pull/427)（状态：合并）

### 11. AI Card usage footer / thinking 展示行为可配置
相关 Issues：
- [#424 新版本的思考状态导致/verbose on模式无法查看工作链路，整体思考体验变慢](https://github.com/soimy/openclaw-channel-dingtalk/issues/424)（状态：已关闭（2026-04-25 自动关闭，可重开））

任务：
- [ ] 明确 thinking 展示可配置项
- [ ] 明确 tool use 展示可配置项
- [ ] 明确 usage footer 展示策略
- [ ] 补齐默认值与文档说明
- [ ] （拟完成，请评估）评估卡片模板多参数/多按钮交互支持方案（#312）
  - [x] [#119 AI Card thinking/tool use streaming](https://github.com/soimy/openclaw-channel-dingtalk/pull/119)（状态：合并）
  - [x] [#214 make thinking message configurable](https://github.com/soimy/openclaw-channel-dingtalk/pull/214)（状态：合并）
- [ ] 明确 `/reasoning stream` 在钉钉通道的提示与降级策略（#320）
- [x] 回归 reasoning 结束态在钉钉卡片上的收敛行为（#282）
  - [x] [#368 refactor: extract ReplyStrategy interface for streaming reply dispatch](https://github.com/soimy/openclaw-channel-dingtalk/pull/368)（状态：合并）
- [ ] 回归 `/verbose on` 下 tool result 流式展示在卡片模式的可见性（#322）
  - [ ] [#322 fix: wire onToolResult to enable verbose tool streaming in card mode](https://github.com/soimy/openclaw-channel-dingtalk/pull/322)（状态：要求修改，已关闭未合并）
- [x] 修复升级后未配置 `ackReaction` 时“无反馈”回归（#359）
  - [x] [#362 fix(config): add default ackReaction fallback to prevent silent upgrade regression](https://github.com/soimy/openclaw-channel-dingtalk/pull/362)（状态：合并）
- [x] 复核 `#332`“思考中表情”在钉钉 UI 延迟显示场景下的撤回收敛行为与 API 调用成本
  - [x] [#332 feat(dingtalk): add native thinking reaction feedback](https://github.com/soimy/openclaw-channel-dingtalk/pull/332)（状态：合并）
- [x] 跟进 `#344` 的 review blocking 项（冲突、默认值语义、media deliver 覆盖回归、超时设置），确认 `ackReaction` 对齐策略后再评估可合并性
  - [x] [#344 feat(dingtalk): add native thinking reaction feedback](https://github.com/soimy/openclaw-channel-dingtalk/pull/344)（状态：合并）
- [x] 评估 `#314` 的“工具执行实时进度提示”与现有 thinking/usage 提示的职责边界及节流策略
  - [x] [#314 feat: real-time tool progress notifications during agent tasks](https://github.com/soimy/openclaw-channel-dingtalk/pull/314)（状态：合并）
  - [x] [#387 fix(types): remove redundant ackReaction union lint](https://github.com/soimy/openclaw-channel-dingtalk/pull/387)（状态：合并）
  - [x] [#388 test(inbound): align ack reaction cleanup expectations](https://github.com/soimy/openclaw-channel-dingtalk/pull/388)（状态：合并）
- [ ] 复盘 `#314` 合并后的会话隔离/kaomoji 兼容/状态机测试覆盖结论，沉淀回归清单
- [ ] 复盘 `#367` 关闭未合并方案与当前主线差异（模板变量契约、callback 入口边界、synthetic message 生命周期）
  - [ ] [#367 feat: forward card action callbacks to AI with card variable update](https://github.com/soimy/openclaw-channel-dingtalk/pull/367)（状态：已关闭未合并）
- [ ] 跟进 `#383` 入站命令分发重构的阻塞项（CI 失败 + ack reaction 重复/额外时延），确认不引入普通消息路径回归
  - [ ] [#383 refactor(dingtalk): 抽离入站命令分发逻辑](https://github.com/soimy/openclaw-channel-dingtalk/pull/383)（状态：通过）
- [x] 跟进 AI Card dynamic summary 默认行为，确认配置与展示不引入额外噪声
  - [x] [#384 feat: enable dynamic summary for AI cards](https://github.com/soimy/openclaw-channel-dingtalk/pull/384)（状态：合并）
- [x] 复核 `#374` 的“无思考中反馈”现场是否已被 `#362` 完全覆盖（含用户配置位置错误场景）
- [x] 跟进 `#424` 的 `/verbose on` 可见性反馈，区分“thinking 展示变更”与“工具链路输出被覆盖”两类问题
- [x] 跟进 `#428` 的单时间线重构非阻塞 review 建议，确认 `cardUpdateMode` 类型收敛与兼容说明
  - [x] [#428 refactor: unify DingTalk AI Card verbose display into a single timeline](https://github.com/soimy/openclaw-channel-dingtalk/pull/428)（状态：合并）
- [x] 跟进 `#447` markdown 增量时间线方案，已合并，后续重点观察与 `#428` 单时间线语义一致性及回归反馈
  - [x] [#447 feat(markdown): stream incremental timeline segments](https://github.com/soimy/openclaw-channel-dingtalk/pull/447)（状态：合并）
- [x] 同步 `#446` 已由 `#447` 替代并关闭，避免重复跟踪
  - [x] [#446 feat(markdown): stream incremental timeline segments](https://github.com/soimy/openclaw-channel-dingtalk/pull/446)（状态：已关闭未合并）
- [ ] 跟进 `#456` 在单聊场景反馈的 `/verbose` 与 `/reasoning` 失效问题，复核 `#447/#457` 是否已完整覆盖（含卡片与 markdown 两种模式）
  - [x] [#447 feat(markdown): stream incremental timeline segments](https://github.com/soimy/openclaw-channel-dingtalk/pull/447)（状态：合并）
  - [ ] [#457 fix(card): unify reasoning-on and reasoning-stream block delivery](https://github.com/soimy/openclaw-channel-dingtalk/pull/457)（状态：审核中）

---

## P3

### 12. 流式与响应时延
相关 Issues：
- [#414 安装新版本发现在 markdown模式下，消息不按照 block 发送，而是全部完成后发送](https://github.com/soimy/openclaw-channel-dingtalk/issues/414)（状态：已关闭（2026-04-26 自动关闭，可重开））

任务：
- [ ] 评估 20 秒延迟是否仅在超大规模部署下发生
  - [ ] [#255 make stream keepAlive configurable and default off](https://github.com/soimy/openclaw-channel-dingtalk/pull/255)（状态：要求修改，已关闭未合并）
- [ ] 评估个人场景是否真的需要真流式
- [ ] 评估消息更新 API 配额消耗
- [ ] 评估低更新频率的替代方案
- [ ] 修复 chunk 模式仅显示增量字符的问题
- [ ] 给出“继续投入 / 保持现状”的结论
- [ ] 跟进 `#416` 的“分步骤执行但钉钉端最终一次性可见”反馈，明确是通道节流策略、上游 buffering 还是客户端展示限制
- [x] 回归 `#341` 引入的实时流式开关与默认值，验证“时延改善 vs API 成本”是否达到可接受平衡
  - [x] [#341 feat(dingtalk): real-time stream update for card mode](https://github.com/soimy/openclaw-channel-dingtalk/pull/341)（状态：合并）
- [ ] 跟进 `#414` 最新讨论：核对 `#447` 是否已恢复 markdown 增量时间线，排查后续 card 修复是否造成 markdown 回退，并补真机复现记录与文档说明
- [x] 跟进 `#425` 乱序反馈，补“卡片模式/markdown 模式/客户端顺序渲染差异”对照复现记录

### 13. README / 截图 / onboarding / 配置说明补齐
相关 Issues：
- [#498 telegram-core 模块缺失安装反馈](https://github.com/soimy/openclaw-channel-dingtalk/issues/498)（状态：已关闭（v3.5.3 已发布；剩余 qa-lab / install.runtime 噪音属上游 OpenClaw 打包问题；2026-04-25 自动关闭，可重开））
- [#455 定时任务发送消息到指定群组](https://github.com/soimy/openclaw-channel-dingtalk/issues/455)（状态：已关闭（2026-04-26 自动关闭，可重开））
- [#520 [问题反馈] message send action 运行时报错 jsonResult is not a function (SDK 版本兼容性)](https://github.com/soimy/openclaw-channel-dingtalk/issues/520)（状态：已关闭（升级到 openclaw >= 2026.4.5 可规避；2026-04-26 自动关闭，可重开））

任务：
- [ ] （拟完成，请评估）补 README 截图
  - [x] [#175 docs: align README cardTemplateKey default](https://github.com/soimy/openclaw-channel-dingtalk/pull/175)（状态：合并）
  - [x] [#199 docs: align onboarding and runtime defaults](https://github.com/soimy/openclaw-channel-dingtalk/pull/199)（状态：合并）
- [ ] 补 onboarding 示例
- [ ] 跟进 `#537` 的 DingTalk Device Flow 自动注册 onboarding：确认最新简化流程、P2 review 建议与手动扫码/失败回退实机验证
  - [ ] [#537 feat(onboarding): add DingTalk Device Flow auto-registration to setup wizard](https://github.com/soimy/openclaw-channel-dingtalk/pull/537)（状态：审核中（CI 通过，待手动验证））
- [ ] 补配置说明
- [ ] 补常见问题
- [ ] 补排障说明
- [ ] 增补 `400/protocol mismatch` 常见排障示例与配置核对清单（#243/#303）
- [x] 补充 `dingtalk.docs.*` gateway methods 的使用示例与权限/参数说明（#301）
  - [x] [#301 feat(dingtalk): 增加钉钉文档 gateway methods](https://github.com/soimy/openclaw-channel-dingtalk/pull/301)（状态：合并）
- [x] 整合 `#328` 的多 bot 多 agent 绑定示例到 onboarding/FAQ，减少与 `#317` 相关配置误解
  - [x] [#328 docs: add multi-agent multi-bot binding guide for DingTalk](https://github.com/soimy/openclaw-channel-dingtalk/pull/328)（状态：合并）
- [ ] 补充 `debug` -> `dwClientDebug` 的迁移说明与兼容窗口说明（#337）
  - [ ] [#337 refactor: deprecate legacy dingtalk debug config](https://github.com/soimy/openclaw-channel-dingtalk/pull/337)（状态：要求修改，已关闭未合并）
- [ ] 增补“钉钉上游能力边界”FAQ：项目管理接口、文档表格编辑、消息输出类型限制（#293/#340/#342）
- [ ] 增补“主动消息发送”FAQ 与前置条件（`robotCode`、会话预热、机器人类型权限、流式模式差异）（#144/#355）
- [ ] 跟进 `#527` 的 `dingtalk-connector.*` Gateway RPC 兼容：确认 `send/status/probe` 的目标格式、`clientId` 暴露边界与 `messageId` fallback 语义后再决定是否合入
  - [ ] [#527 feat: add DingTalk connector Gateway RPC compatibility](https://github.com/soimy/openclaw-channel-dingtalk/pull/527)（状态：审核中（CI 通过））
- [ ] 增补“定时/主动发送到指定群”说明（`conversationId` 直发 + `displayNameResolution` 能力与版本门槛）（#376/#372）
- [ ] 合并 `#455` 追问：补充 `cron/jobs.json` 中 `conversationId: group:cid...` 与 `session_key` 两种定向发送写法示例
- [ ] （拟完成，请评估）跟进 `#519` 的 CLI 子命令加载噪音：循环依赖已拆除，待补一次发布后 CLI 子命令真实安装路径回归确认噪音已消失
  - [x] [#521 fix: break 3 circular import cycles causing CLI RangeError](https://github.com/soimy/openclaw-channel-dingtalk/pull/521)（状态：合并）
- [ ] 合并 `#520` 的 SDK 兼容结论：明确 `message send` 在 PR `#499` 之后依赖 `openclaw >= 2026.4.5`，补版本矩阵、升级提示与低版本保护策略
- [ ] 增补“Markdown 表格渲染差异”说明（客户端差异 + 自定义机器人 vs 应用机器人）（#192/#358）
- [ ] 补充 `gatewayToken` 缺失/错误时的配置排障指引与默认回退行为说明（#370）
- [ ] （拟完成，请评估）跟进 `#402/#404/#405` 安装失败闭环：补版本兼容矩阵与升级指引，并同步已由 `#406` 修复的范围边界
  - [x] [#406 fix: avoid omitting openclaw during plugin install](https://github.com/soimy/openclaw-channel-dingtalk/pull/406)（状态：合并）
- [ ] 跟进 `#413` 的“插件内嵌 openclaw 目录”安装反馈：补充“全新安装仍可出现目录”的复现结论与清理/规避建议
- [ ] 基于 `#226` 2026-03-25 新线索（竞品疑似可读群聊）补一条能力边界说明：若无公开 API 支持则保持 `wontfix`，避免误导承诺
- [ ] 跟进 `#421` 的 Windows 路径报错反馈：在 FAQ 明确“旧版本（v2.x）升级到 v3.x”优先路径与校验步骤
- [ ] 跟进 `#423/#426/#434/#435` 安装失败反馈：补“安装方式 + OpenClaw 最低版本 + semver 兼容”检查清单
- [ ] 合并 `#498/#502` 的兼容性结论：确认 `v3.5.3` 已修复 `telegram-core` 导入缺失，但 `qa-lab / install.runtime` 安装噪音仍属上游 OpenClaw 打包问题，并补最低兼容版本与升级/回退指引
- [ ] 补充 `#434/#435` 最新进展：标注 clawhub 安装路径缺陷与 semver 紧急修复（`b21e501`）的适用边界，给出临时 git 安装指引
- [x] 同步 `#445` 配置字段收敛（移除 `corpId/agentId/robotCode`）与 README/onboarding 更新，减少安装与升级期配置歧义
  - [x] [#445 refactor: remove dead config fields corpId, agentId, robotCode](https://github.com/soimy/openclaw-channel-dingtalk/pull/445)（状态：合并）
- [x] 补充 `cardAtSender` 配置参考说明，确保字段类型、默认值与群聊 @sender 行为说明同步到 reference 文档
  - [x] [#529 docs: add cardAtSender to configuration reference](https://github.com/soimy/openclaw-channel-dingtalk/pull/529)（状态：合并）
- [ ] 评估 `#393` 的 structured real-device debug sessions 文档/脚本方案，决定合并范围与最小维护面
  - [ ] [#393 feat: add structured real-device debug sessions](https://github.com/soimy/openclaw-channel-dingtalk/pull/393)（状态：新（草稿））

### 14. 群聊历史滚动摘要 /summary 命令
任务：
- [x] 同步 `#331` 状态变更：PR 已关闭未合并，原范围拆分为 `#440`（message context metadata）与 `#441`（owner-only /summary）
  - [x] [#331 feat(dingtalk): add rolling summary history commands](https://github.com/soimy/openclaw-channel-dingtalk/pull/331)（状态：已关闭未合并）
- [x] 跟进 `#440` 的基础能力拆分方案，确认 message-context metadata 暴露不引入跨会话串扰
  - [x] [#440 refactor(dingtalk): expose message context metadata for summary queries](https://github.com/soimy/openclaw-channel-dingtalk/pull/440)（状态：合并）
- [x] 跟进 `#441` owner-only `/summary` 命令实现，复核 owner 鉴权/历史窗口限制/帮助文本一致性
  - [x] [#441 feat(dingtalk): add owner-only summary history commands](https://github.com/soimy/openclaw-channel-dingtalk/pull/441)（状态：合并）
- [ ] 对齐 `historyLimit` 默认值语义（代码默认关闭 vs 注释默认 50）并补充文档
- [ ] 在 rebase 后复核 `/summary` 命令边界（owner 鉴权、token 成本、历史窗口与归档段限制）
- [ ] 跟进 `#331` 最新阻塞项：`conversationId` 归一化冲突导致历史聚合错路由，需统一 canonical key 策略
- [ ] 结合 `#331` 2026-03-22 最新更新复核“DM scope 统一 / 引用+附件 fallback / target-directory 测试矩阵”是否已消除阻塞项
- [ ] 合并 `#331` 2026-03-25 最新 review：`reviewDecision=CHANGES_REQUESTED` 仍未翻转，优先收敛 CL test 报错后再复核合并条件
- [ ] 同步 `#331` 2026-03-25 review 阻塞项：将 `channel.ts` 中新增 chatType/storePath 业务逻辑下沉至目标域并消除与 `send-service` 的重复推断
- [ ] 同步 `#331` 2026-03-26 最新进展：CI 通过但 `CHANGES_REQUESTED` 未解除，需逐条核对 reviewer 阻塞项是否全部关闭

---

## Milestone 建议

### Milestone A：基础可用性收敛
- [ ] 消息接收稳定性 / 长时间待机可靠性
- [ ] AI Card 发送链路一致性
- [ ] 文件上传 / 文件读取 / 文件预览 / 大文件链路
- [ ] 图片 / 语音 / 媒体链路补强

### Milestone B：高频消息类型与治理能力补齐
- [ ] 引用消息 / chatRecord / 转发记录解析收口
- [ ] 建立 Issue 提交标准化
- [ ] 建立 PR / Issue 自动化流程

### Milestone C：配置与体验增强
- [ ] 多账号 / 多 agent / schema 与路由配置收敛
- [ ] AI Card usage footer / thinking 展示行为可配置
- [ ] README / 截图 / onboarding / 配置说明补齐

### Milestone D：增强能力与低优先级优化
- [ ] 支持群聊 @人 / @all
- [ ] 支持对话打断 / 取消任务
- [ ] 流式与响应时延

---

## 建议拆分顺序

### 第一阶段
- [ ] 消息接收稳定性 / 长时间待机可靠性
- [ ] AI Card 发送链路一致性
- [ ] 文件上传 / 文件读取 / 文件预览 / 大文件链路
- [ ] 图片 / 语音 / 媒体链路补强

### 第二阶段
- [ ] 引用消息 / chatRecord / 转发记录解析收口
- [ ] 建立 Issue 提交标准化
- [ ] 建立 PR / Issue 自动化流程

### 第三阶段
- [ ] 多账号 / 多 agent / schema 与路由配置收敛
- [ ] AI Card usage footer / thinking 展示行为可配置
- [ ] README / 截图 / onboarding / 配置说明补齐

### 第四阶段
- [ ] 支持群聊 @人 / @all
- [ ] 支持对话打断 / 取消任务
- [ ] 流式与响应时延

---

## /btw bypass session lock — 验证 TODO (PR #508)

- [x] DM `/btw 这个函数为什么慢` while bot is idle → blockquote + answer rendered correctly
- [x] DM `/btw <question>` while a main run is in PROCESSING → BTW answer arrives without waiting for main run
- [x] Group `@Bot /btw <question>` while main run in PROCESSING → mention stripped from blockquote, sender nickname displayed
- [x] `/btw` (no question) → openclaw usage error rendered with `> [<sender>: ]/btw` blockquote prefix (note: `<side question>` placeholder eaten by markdown — upstream issue openclaw/openclaw#62877)
- [x] Long question (> 80 chars) → blockquote shows truncated form with `…`
- [x] Card mode (`messageType: card`): `/btw` and `/stop` do NOT create orphan PROCESSING cards (createAICard hoist regression)
- [x] After upgrading to openclaw with `isBtwRequestText` exported, BTW activates without channel config change
