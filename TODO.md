# Backlog / Prioritized TODO

用于持续跟踪 `openclaw-channel-dingtalk` 的任务优先级、推进顺序和治理项。

---

## P0

### 1. 消息接收稳定性 / 长时间待机可靠性
相关 Issues：
- [#104 Inbound message missing](https://github.com/soimy/openclaw-channel-dingtalk/issues/104)（状态：开启）
- [#164 经常无法接受到消息无法回复](https://github.com/soimy/openclaw-channel-dingtalk/issues/164)（状态：已关闭）
- [#151 过几个小时后经常断线](https://github.com/soimy/openclaw-channel-dingtalk/issues/151)（状态：已修复（关联 PR #153））
- [#187 待机太久出现不可用](https://github.com/soimy/openclaw-channel-dingtalk/issues/187)（状态：已关闭）
- [#302 TCP half-open问题](https://github.com/soimy/openclaw-channel-dingtalk/issues/302)（状态：已关闭）
- [#347 长时间不用，发消息无响应](https://github.com/soimy/openclaw-channel-dingtalk/issues/347)（状态：已修复（关联 PR #343））
- [#303 Connection attempt x failed: protocol mismatch](https://github.com/soimy/openclaw-channel-dingtalk/issues/303)（状态：已关闭）
- [#289 dingtalk connection error 503 & 400](https://github.com/soimy/openclaw-channel-dingtalk/issues/289)（状态：已关闭）
- [#345 机器人时不时收不到回复，只能重新发送，几次才能好](https://github.com/soimy/openclaw-channel-dingtalk/issues/345)（状态：已关闭）
- [#373 长时间不用钉钉机器人，再发送消息，openclaw接收不到](https://github.com/soimy/openclaw-channel-dingtalk/issues/373)（状态：开启）
- [#390 Delayed callback ack causes DingTalk to redeliver messages, resulting in duplicate processing](https://github.com/soimy/openclaw-channel-dingtalk/issues/390)（状态：已关闭（关联 PR #392））
- [#400 WebSocket was closed before the connection was established：偶尔重启之后会连续报错好多个这个](https://github.com/soimy/openclaw-channel-dingtalk/issues/400)（状态：已关闭（关联 PR #399））

任务：
- [ ] 复核现有稳定性问题是否仍可复现
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
- [#166 回复done问题](https://github.com/soimy/openclaw-channel-dingtalk/issues/166)（状态：已修复（关联 PR #191））
- [#197 ai卡片模式下，主动发消息内容不正常](https://github.com/soimy/openclaw-channel-dingtalk/issues/197)（状态：已关闭）
- [#136 同样的内容，会出现两遍](https://github.com/soimy/openclaw-channel-dingtalk/issues/136)（状态：开启）
- [#318 日志显示API 被限流](https://github.com/soimy/openclaw-channel-dingtalk/issues/318)（状态：开启）
- [#319 bug: sessionWebhook 过期后无 fallback，长任务回复静默丢失](https://github.com/soimy/openclaw-channel-dingtalk/issues/319)（状态：已关闭）
- [#321 bug: deliver 回调中 payload.text 为空时直接 return，导致媒体消息无文字说明](https://github.com/soimy/openclaw-channel-dingtalk/issues/321)（状态：已修复（关联 PR #311））
- [#290 bug: reasoning token 内容重复堆叠进 AI card](https://github.com/soimy/openclaw-channel-dingtalk/issues/290)（状态：已修复（关联 PR #291））
- [#282 reasoning没有结束状态](https://github.com/soimy/openclaw-channel-dingtalk/issues/282)（状态：已修复（关联 PR #368））
- [#208 当 LiteLLM 返回 429/503 错误时，机器人没有回复用户任何信息，希望能推送错误提示](https://github.com/soimy/openclaw-channel-dingtalk/issues/208)（状态：已修复（关联 PR #231））
- [#198 如果工具调用失败，就会导致一段时间无法对话](https://github.com/soimy/openclaw-channel-dingtalk/issues/198)（状态：已修复（关联 PR #326））
- [#292 bug: tool stream delivery failure aborts entire dispatch, subsequent AI reply is lost](https://github.com/soimy/openclaw-channel-dingtalk/issues/292)（状态：已关闭）
- [#357 3.2.0升级3.3.0后钉钉card只显示处理中](https://github.com/soimy/openclaw-channel-dingtalk/issues/357)（状态：开启）
- [#358 Markdown 表格经 convertMarkdownTablesToPlainText 转换后在钉钉显示格式丢失](https://github.com/soimy/openclaw-channel-dingtalk/issues/358)（状态：开启）
- [#360 Markdown 模式下 AI 回复被拆成多条消息](https://github.com/soimy/openclaw-channel-dingtalk/issues/360)（状态：已修复（关联 PR #361））
- [#379 千问免费模型token 失效，钉钉前端没有反馈](https://github.com/soimy/openclaw-channel-dingtalk/issues/379)（状态：开启）
- [#407 使用card模式接收不到消息](https://github.com/soimy/openclaw-channel-dingtalk/issues/407)（状态：开启）
- [#419 bug: AI Card shows empty cards when messages queue behind a long-running task](https://github.com/soimy/openclaw-channel-dingtalk/issues/419)（状态：已关闭（关联 PR #418，未合并））

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
  - [ ] [#396 feat(card): built-in AI card template with stop button support](https://github.com/soimy/openclaw-channel-dingtalk/pull/396)（状态：审核中）
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
- [ ] 复核 `#419` 关闭结论：确认“会话锁外提前建卡/空 Done 卡片”修复是否已入 `main`；若未落地，按最小补丁重提
  - [ ] [#418 fix: use dispatch counts to prevent empty "Done" card finalize](https://github.com/soimy/openclaw-channel-dingtalk/pull/418)（状态：已关闭未合并）

### 3. 文件上传 / 文件读取 / 文件预览 / 大文件链路
相关 Issues：
- [#207 通过钉钉无法上传文件给Openclaw](https://github.com/soimy/openclaw-channel-dingtalk/issues/207)（状态：开启）
- [#218 群里的文件都以 file 后缀结尾，无法预览](https://github.com/soimy/openclaw-channel-dingtalk/issues/218)（状态：已关闭）
- [#101 支持访问钉盘文件](https://github.com/soimy/openclaw-channel-dingtalk/issues/101)（状态：开启）
- [#125 大文件分片上传](https://github.com/soimy/openclaw-channel-dingtalk/issues/125)（状态：已关闭）
- [#315 无法让openclaw将本地文件通过钉钉发送（Dup #207）](https://github.com/soimy/openclaw-channel-dingtalk/issues/315)（状态：开启）
- [#366 无法发送本机文件到我的钉钉问题](https://github.com/soimy/openclaw-channel-dingtalk/issues/366)（状态：开启）
- [#270 钉钉收不到文件，回复只收到占位符，图片、语音都没有问题](https://github.com/soimy/openclaw-channel-dingtalk/issues/270)（状态：开启）
- [#391 能否做到帮我从钉盘找图片/文件并发给我](https://github.com/soimy/openclaw-channel-dingtalk/issues/391)（状态：开启）
- [#397 [Bug] Sandbox mode: sendMedia fails for workspace files - not using loadWebMedia](https://github.com/soimy/openclaw-channel-dingtalk/issues/397)（状态：已关闭（关联 PR #398））
- [#415 单聊不能收文件](https://github.com/soimy/openclaw-channel-dingtalk/issues/415)（状态：开启）
- [#422 机器人无法发送文件的问题](https://github.com/soimy/openclaw-channel-dingtalk/issues/422)（状态：开启）
- [#430 群聊怎么给openclaw发文件呢?](https://github.com/soimy/openclaw-channel-dingtalk/issues/430)（状态：开启）
- [#442 文件下载缺少 timeout 导致长时间阻塞](https://github.com/soimy/openclaw-channel-dingtalk/issues/442)（状态：开启）

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
- [x] 跟进 `#397` 的 sandbox 路径兼容缺口，`sendMedia -> uploadMedia` 已补齐 `loadWebMedia` 桥接能力
  - [x] [#398 fix: sandbox sendMedia fails for workspace files](https://github.com/soimy/openclaw-channel-dingtalk/pull/398)（状态：合并）
- [x] 跟进 `#411` 恢复“附件抽取文本注入 inbound body”修复并确认 quotedRef 链路已补齐（file/audio/video + Step 0 下载）
  - [x] [#411 fix: 修复引用文件/音频/视频消息下载及附件文本注入](https://github.com/soimy/openclaw-channel-dingtalk/pull/411)（状态：合并）
- [ ] 补充 `#415` 单聊收文件失败最小复现：区分“单聊附件入站限制”与“提取/落盘链路异常”
- [ ] 跟进 `#422` 的“模型不会触发文件发送动作”反馈，补充提示词/动作能力边界说明与可复现样例
- [ ] 跟进 `#430` 群聊文件读取反馈：确认 `#411` 发布版本已覆盖“引用文件 + @Bot”路径并补版本提示
- [ ] 跟进 `#442` 入站附件下载超时阻塞问题，补“第二跳下载 timeout + host 日志”回归
  - [ ] [#443 fix: add timeout and host logging for inbound media download](https://github.com/soimy/openclaw-channel-dingtalk/pull/443)（状态：审核中）

### 4. 图片 / 语音 / 媒体链路补强
相关 Issues：
- [#162 无法发送图片](https://github.com/soimy/openclaw-channel-dingtalk/issues/162)（状态：开启）
- [#86 在AI的流式卡片上也实现插入图片/视频音频等](https://github.com/soimy/openclaw-channel-dingtalk/issues/86)（状态：开启）
- [#306 钉钉无法发送图片，提示富文本（Dup #162）](https://github.com/soimy/openclaw-channel-dingtalk/issues/306)（状态：开启）
- [#316 钉钉机器人无法发送本地文件或者图片发给我（Dup #162）](https://github.com/soimy/openclaw-channel-dingtalk/issues/316)（状态：开启）
- [#333 求助为什么通过钉钉发一张图，agent只能接收到&lt;media:image&gt;](https://github.com/soimy/openclaw-channel-dingtalk/issues/333)（状态：已关闭（已定位 `robotCode` 配置））
- [#351 钉钉发送的图片默认是压缩，是否能暴露一个配置是否获取原图？](https://github.com/soimy/openclaw-channel-dingtalk/issues/351)（状态：开启）
- [#365 机器人发的图片，只有占位符](https://github.com/soimy/openclaw-channel-dingtalk/issues/365)（状态：已关闭（反馈指向 Media Url Allowlist 配置））
- [#394 钉钉给机器人发送图片 机器人无法识别图片](https://github.com/soimy/openclaw-channel-dingtalk/issues/394)（状态：已关闭）
- [#408 使用dingtalk 单聊，接收不到返回的 tts 语音包](https://github.com/soimy/openclaw-channel-dingtalk/issues/408)（状态：开启）
- [#429 最新版本openclaw 3.24和插件版本v3.4.2无法读取图片](https://github.com/soimy/openclaw-channel-dingtalk/issues/429)（状态：已关闭（关联 PR #432））

任务：
- [ ] 回归本地图片发送
- [ ] 回归语音消息发送
- [ ] 回归入站媒体大小限制覆盖配置
- [ ] 评估 AI Card 内媒体一体化展示是否值得推进
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
- [#126 引用消息支持](https://github.com/soimy/openclaw-channel-dingtalk/issues/126)（状态：已关闭）
- [#205 chatRecord 消息显示空白](https://github.com/soimy/openclaw-channel-dingtalk/issues/205)（状态：已关闭）
- [#227 forward/chatRecord 相关问题](https://github.com/soimy/openclaw-channel-dingtalk/issues/227)（状态：已关闭）
- [#286 不支持识别钉群中富文本引用吗？](https://github.com/soimy/openclaw-channel-dingtalk/issues/286)（状态：开启）
- [#349 是否支持引用群消息](https://github.com/soimy/openclaw-channel-dingtalk/issues/349)（状态：开启）

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
- [x] 评估 `#364/#371` 的消息上下文持久化统一方案对 quote/chatRecord 的迁移兼容与回归面
  - [x] [#364 feat: unify message context persistence](https://github.com/soimy/openclaw-channel-dingtalk/pull/364)（状态：合并）
  - [x] [#371 fix: unify message context journaling scope](https://github.com/soimy/openclaw-channel-dingtalk/pull/371)（状态：合并）
- [x] 落地 `quotedRef` 引用链并对齐 runtime reply context（#375/#377/#378）
  - [x] [#375 feat: add quotedRef-based reply reference chain](https://github.com/soimy/openclaw-channel-dingtalk/pull/375)（状态：合并）
  - [x] [#377 feat: translate quotedRef chain into runtime reply context](https://github.com/soimy/openclaw-channel-dingtalk/pull/377)（状态：合并）
  - [x] [#378 fix: remove undefined quotedPrefix in text message extraction](https://github.com/soimy/openclaw-channel-dingtalk/pull/378)（状态：合并）
- [x] 跟进 `#389` 对 `#377` 的后续补丁（preview fallback/attachment excerpt/TTL），确认与现有 `message-context-store` 语义一致并已合入
  - [x] [#389 feat: inject quoted reply context for agent runtime](https://github.com/soimy/openclaw-channel-dingtalk/pull/389)（状态：合并）
- [ ] 跟进 `#401` quoted-only 回归修复的后续项：补 handler 层回归测试，并评估 QuotedRef-first 输入策略
  - [x] [#401 fix: fallback to quoted previewText when reply text is empty](https://github.com/soimy/openclaw-channel-dingtalk/pull/401)（状态：合并）

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
- [#130 多 agent 配置相关](https://github.com/soimy/openclaw-channel-dingtalk/issues/130)（状态：已关闭）
- [#304 openclaw网页钉钉插件提示Unsupported schema node. Use Raw mode.](https://github.com/soimy/openclaw-channel-dingtalk/issues/304)（状态：已修复（关联 PR #324））
- [#185 用dingtalk插件为多agent绑定不同的钉钉机器人失效](https://github.com/soimy/openclaw-channel-dingtalk/issues/185)（状态：开启（已有修复文档但仍有用户追问））
- [#267 钉钉支持多账号配置吗？](https://github.com/soimy/openclaw-channel-dingtalk/issues/267)（状态：已关闭）
- [#354 peer.kind绑定方式不生效](https://github.com/soimy/openclaw-channel-dingtalk/issues/354)（状态：开启）
- [#381 插件报错 TypeError: pluginSdk.buildChannelConfigSchema is not a function](https://github.com/soimy/openclaw-channel-dingtalk/issues/381)（状态：已关闭）
- [#420 某些钉钉账号无法通过私聊发送邮件](https://github.com/soimy/openclaw-channel-dingtalk/issues/420)（状态：开启）

任务：
- [ ] 补齐配置示例
- [ ] 增加配置校验
- [ ] 优化启动时报错
- [ ] 补齐文档说明
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
  - [ ] [#383 refactor(dingtalk): 抽离入站命令分发逻辑](https://github.com/soimy/openclaw-channel-dingtalk/pull/383)（状态：审核中）
- [x] 跟进 `#395` plugin-sdk API 对齐分支并完成兼容层回归（入口/类型导出/onboarding）
  - [x] [#395 refactor(dingtalk): Sync upstream plugin-sdk new API](https://github.com/soimy/openclaw-channel-dingtalk/pull/395)（状态：合并）
- [x] 跟进 `#412` 的 DM `@sub-agent` 路由方案，重点复核 DM richText/quoted 场景误触发与回归覆盖
  - [x] [#412 feat: support @mention sub-agent routing in DM (direct messages)](https://github.com/soimy/openclaw-channel-dingtalk/pull/412)（状态：合并）
- [ ] 跟进 `#420` 私聊会话疑似误路由反馈：补 `senderStaffId/senderOriginalId` 冲突诊断日志与复现用例

### 9. 支持群聊 @人 / @all
相关 Issues：
- [#67 机器人群聊中支持@某人](https://github.com/soimy/openclaw-channel-dingtalk/issues/67)（状态：开启）
- [#288 支持群里多个龙虾左右互搏相互at吗？（Dup #67）](https://github.com/soimy/openclaw-channel-dingtalk/issues/288)（状态：开启）
- [#305 群组中艾特机器人受限（Dup #67）](https://github.com/soimy/openclaw-channel-dingtalk/issues/305)（状态：开启）
- [#353 如何让龙虾在群里中@其他成员](https://github.com/soimy/openclaw-channel-dingtalk/issues/353)（状态：开启）
- [#417 在钉钉群里，@机器人后让他生成图片发群里，结果发了一条全员钉钉通知](https://github.com/soimy/openclaw-channel-dingtalk/issues/417)（状态：开启）

任务：
- [ ] 明确 @单人 需求范围
  - [x] [#317 feat(dingtalk): add @sub-agent basic support for group chat multi-agent scenarios](https://github.com/soimy/openclaw-channel-dingtalk/pull/317)（状态：合并）
- [ ] 明确 @多人 需求范围
- [ ] 明确 @all 需求范围
- [ ] 设计失败降级与兼容行为
- [ ] 整理 `#288/#305` 重复诉求，收敛为 `#67` 验收标准
- [ ] 跟进 `#305` 新增用户追问，补充当前版本可行配置与仍未覆盖场景的状态说明
- [ ] 跟进 `#417` 的“触发全员工作通知”风险，补充 `@all` 防护说明与默认关闭/显式开启策略
- [x] 明确 card 模式下 `@sender` 通知能力边界，避免与“@指定成员”诉求混淆（#369）
  - [x] [#369 feat: add cardAtSender option to @mention sender after card finalization](https://github.com/soimy/openclaw-channel-dingtalk/pull/369)（状态：合并）

### 10. 支持对话打断 / 取消任务
相关 Issues：
- [#76 对话打断功能](https://github.com/soimy/openclaw-channel-dingtalk/issues/76)（状态：开启）
- [#310 啥时候能支持acp啊](https://github.com/soimy/openclaw-channel-dingtalk/issues/310)（状态：开启）

任务：
- [ ] 明确用户主动取消的交互形式
- [ ] 明确长任务中断机制
- [ ] 明确中断后状态回收方式
- [ ] 明确 UI / 提示语反馈
- [ ] 明确 ACP 最小可用范围（`/acp spawn`）及 `status/steer/cancel` 分阶段目标（#310）
- [x] 评估 `#427` 的“停止指令绕过 session 锁”方案与现有卡片停止流程整合边界（避免空卡片 finalize）
  - [x] [#427 feat: bypass session lock for real-time stop command support](https://github.com/soimy/openclaw-channel-dingtalk/pull/427)（状态：合并）

### 11. AI Card usage footer / thinking 展示行为可配置
相关 Issues：
- [#111 usage footer](https://github.com/soimy/openclaw-channel-dingtalk/issues/111)（状态：开启）
- [#236 思考中如何关闭](https://github.com/soimy/openclaw-channel-dingtalk/issues/236)（状态：已关闭）
- [#312 为什么卡片模板的参数只支持一个，如果相传多个怎么实现](https://github.com/soimy/openclaw-channel-dingtalk/issues/312)（状态：开启）
- [#320 reasoning stream提示 Reasoning stream enabled (Telegram only).（Dup #236）](https://github.com/soimy/openclaw-channel-dingtalk/issues/320)（状态：开启）
- [#244 能否只是card的宽屏模式？目前电脑端，窄屏太小了](https://github.com/soimy/openclaw-channel-dingtalk/issues/244)（状态：已关闭（关联 PR #271））
- [#359 ackReaction 无配置时缺少默认值，升级后发消息无任何反馈](https://github.com/soimy/openclaw-channel-dingtalk/issues/359)（状态：已修复（关联 PR #362））
- [#374 升级到新版本以后机器人收到消息没有“正在思考”了](https://github.com/soimy/openclaw-channel-dingtalk/issues/374)（状态：开启（评论指向 PR #362 已修复，待 issue 侧确认关闭））
- [#424 新版本的思考状态导致/verbose on模式无法查看工作链路，整体思考体验变慢](https://github.com/soimy/openclaw-channel-dingtalk/issues/424)（状态：开启）

任务：
- [ ] 明确 thinking 展示可配置项
- [ ] 明确 tool use 展示可配置项
- [ ] 明确 usage footer 展示策略
- [ ] 补齐默认值与文档说明
- [ ] 评估卡片模板多参数/多按钮交互支持方案（#312）
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
  - [ ] [#383 refactor(dingtalk): 抽离入站命令分发逻辑](https://github.com/soimy/openclaw-channel-dingtalk/pull/383)（状态：审核中）
- [x] 跟进 AI Card dynamic summary 默认行为，确认配置与展示不引入额外噪声
  - [x] [#384 feat: enable dynamic summary for AI cards](https://github.com/soimy/openclaw-channel-dingtalk/pull/384)（状态：合并）
- [ ] 复核 `#374` 的“无思考中反馈”现场是否已被 `#362` 完全覆盖（含用户配置位置错误场景）
- [ ] 跟进 `#424` 的 `/verbose on` 可见性反馈，区分“thinking 展示变更”与“工具链路输出被覆盖”两类问题
- [ ] 跟进 `#428` 的单时间线重构非阻塞 review 建议，确认 `cardUpdateMode` 类型收敛与兼容说明
  - [ ] [#428 refactor: unify DingTalk AI Card verbose display into a single timeline](https://github.com/soimy/openclaw-channel-dingtalk/pull/428)（状态：审核中）

---

## P3

### 12. 流式与响应时延
相关 Issues：
- [#238 新版本：延迟20S](https://github.com/soimy/openclaw-channel-dingtalk/issues/238)（状态：开启）
- [#260 发现流式是假的，是最终生成完以后才开始流](https://github.com/soimy/openclaw-channel-dingtalk/issues/260)（状态：已关闭（关联 PR #368））
- [#414 安装新版本发现在 markdown模式下，消息不按照 block 发送，而是全部完成后发送](https://github.com/soimy/openclaw-channel-dingtalk/issues/414)（状态：开启）
- [#416 分步骤回复消息的支持](https://github.com/soimy/openclaw-channel-dingtalk/issues/416)（状态：开启）
- [#425 openclaw的回复消息在钉钉中有时候是乱序的](https://github.com/soimy/openclaw-channel-dingtalk/issues/425)（状态：开启）

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
- [ ] 跟进 `#414` 的 markdown 模式“整段发送”反馈，明确是否为 `#361` 之后的预期行为并补文档说明
- [ ] 跟进 `#425` 乱序反馈，补“卡片模式/markdown 模式/客户端顺序渲染差异”对照复现记录

### 13. README / 截图 / onboarding / 配置说明补齐
相关 Issues：
- [#242 README 能否增加一些图片截图](https://github.com/soimy/openclaw-channel-dingtalk/issues/242)（状态：开启）
- [#243 为啥我配置好了参数 一直显示0 ... Request failed with status code 400](https://github.com/soimy/openclaw-channel-dingtalk/issues/243)（状态：开启）
- [#293 给机器人开了钉钉的项目管理权限，是不是不能用](https://github.com/soimy/openclaw-channel-dingtalk/issues/293)（状态：已关闭）
- [#340 钉钉文档表格还是有问题，无法创建和编辑](https://github.com/soimy/openclaw-channel-dingtalk/issues/340)（状态：已关闭）
- [#342 输出文本不支持msgtype:type吗？](https://github.com/soimy/openclaw-channel-dingtalk/issues/342)（状态：开启）
- [#144 如何让openclaw主动发消息给我？](https://github.com/soimy/openclaw-channel-dingtalk/issues/144)（状态：开启）
- [#355 如何让机器人主动给某个用户主动发消息](https://github.com/soimy/openclaw-channel-dingtalk/issues/355)（状态：开启）
- [#192 markdown格式表格不渲染](https://github.com/soimy/openclaw-channel-dingtalk/issues/192)（状态：已关闭）
- [#370 Response interrupted: Gateway error: 404 - Not Found（gatewayToken 配置）](https://github.com/soimy/openclaw-channel-dingtalk/issues/370)（状态：已关闭）
- [#376 配置定时任务时，如何让消息发送到钉钉指定的群聊](https://github.com/soimy/openclaw-channel-dingtalk/issues/376)（状态：开启（已确认可用 conversationId 直发 + `openclaw message send --target session_key`，displayName 直发待下版本））
- [#402 Failed to install plugin (v3.4.1) in OpenClaw-2026.3.22 (4dcc39c)](https://github.com/soimy/openclaw-channel-dingtalk/issues/402)（状态：已关闭（关联 PR #406））
- [#404 🦞 OpenClaw 2026.3.23-1 装最新的钉钉插件，无法启动，启动报错有日志](https://github.com/soimy/openclaw-channel-dingtalk/issues/404)（状态：已关闭（关联 PR #406））
- [#405 OpenClaw 2026.3.22+ 下本地插件无法解析 openclaw/plugin-sdk/* 子路径导入](https://github.com/soimy/openclaw-channel-dingtalk/issues/405)（状态：已关闭（关联 PR #406））
- [#413 Feature request: avoid nesting a full openclaw copy inside](https://github.com/soimy/openclaw-channel-dingtalk/issues/413)（状态：开启）
- [#226 可否增加一个读取群聊消息的功能，而不只是@机器人](https://github.com/soimy/openclaw-channel-dingtalk/issues/226)（状态：开启（wontfix，2026-03-25 新线索待验证））
- [#421 windows 10系统下无法配置钉钉消息](https://github.com/soimy/openclaw-channel-dingtalk/issues/421)（状态：开启）
- [#423 安装失败：Also not a valid hook pack: Error: package.json missing openclaw.hooks](https://github.com/soimy/openclaw-channel-dingtalk/issues/423)（状态：开启）
- [#426 安装出现 dingtalk failed to load ... root-alias.cjs/param-readers 报错](https://github.com/soimy/openclaw-channel-dingtalk/issues/426)（状态：已关闭）
- [#434 macOS 安装失败](https://github.com/soimy/openclaw-channel-dingtalk/issues/434)（状态：开启）
- [#435 [Bug]安装插件失败](https://github.com/soimy/openclaw-channel-dingtalk/issues/435)（状态：开启）

任务：
- [ ] 补 README 截图
  - [x] [#175 docs: align README cardTemplateKey default](https://github.com/soimy/openclaw-channel-dingtalk/pull/175)（状态：合并）
  - [x] [#199 docs: align onboarding and runtime defaults](https://github.com/soimy/openclaw-channel-dingtalk/pull/199)（状态：合并）
- [ ] 补 onboarding 示例
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
- [ ] 增补“定时/主动发送到指定群”说明（`conversationId` 直发 + `displayNameResolution` 能力与版本门槛）（#376/#372）
- [ ] 增补“Markdown 表格渲染差异”说明（客户端差异 + 自定义机器人 vs 应用机器人）（#192/#358）
- [ ] 补充 `gatewayToken` 缺失/错误时的配置排障指引与默认回退行为说明（#370）
- [ ] 跟进 `#402/#404/#405` 安装失败闭环：补版本兼容矩阵与升级指引，并同步已由 `#406` 修复的范围边界
  - [x] [#406 fix: avoid omitting openclaw during plugin install](https://github.com/soimy/openclaw-channel-dingtalk/pull/406)（状态：合并）
- [ ] 跟进 `#413` 的“插件内嵌 openclaw 目录”安装反馈：补充“全新安装仍可出现目录”的复现结论与清理/规避建议
- [ ] 基于 `#226` 2026-03-25 新线索（竞品疑似可读群聊）补一条能力边界说明：若无公开 API 支持则保持 `wontfix`，避免误导承诺
- [ ] 跟进 `#421` 的 Windows 路径报错反馈：在 FAQ 明确“旧版本（v2.x）升级到 v3.x”优先路径与校验步骤
- [ ] 跟进 `#423/#426/#434/#435` 安装失败反馈：补“安装方式 + OpenClaw 最低版本 + semver 兼容”检查清单
- [ ] 补充 `#434/#435` 最新进展：标注 clawhub 安装路径缺陷与 semver 紧急修复（`b21e501`）的适用边界，给出临时 git 安装指引
- [ ] 评估 `#393` 的 structured real-device debug sessions 文档/脚本方案，决定合并范围与最小维护面
  - [ ] [#393 feat: add structured real-device debug sessions](https://github.com/soimy/openclaw-channel-dingtalk/pull/393)（状态：新（草稿））

### 14. 群聊历史滚动摘要 /summary 命令
任务：
- [x] 同步 `#331` 状态变更：PR 已关闭未合并，原范围拆分为 `#440`（message context metadata）与 `#441`（owner-only /summary）
  - [x] [#331 feat(dingtalk): add rolling summary history commands](https://github.com/soimy/openclaw-channel-dingtalk/pull/331)（状态：已关闭未合并）
- [ ] 跟进 `#440` 的基础能力拆分方案，确认 message-context metadata 暴露不引入跨会话串扰
  - [ ] [#440 refactor(dingtalk): expose message context metadata for summary queries](https://github.com/soimy/openclaw-channel-dingtalk/pull/440)（状态：审核中）
- [ ] 跟进 `#441` owner-only `/summary` 命令实现，复核 owner 鉴权/历史窗口限制/帮助文本一致性
  - [ ] [#441 feat(dingtalk): add owner-only summary history commands](https://github.com/soimy/openclaw-channel-dingtalk/pull/441)（状态：审核中）
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
