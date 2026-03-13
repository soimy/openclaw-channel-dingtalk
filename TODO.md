# Backlog / Prioritized TODO

用于持续跟踪 `openclaw-channel-dingtalk` 的任务优先级、推进顺序和治理项。

---

## P0

### 1. 消息接收稳定性 / 长时间待机可靠性
相关 Issues：
- [#104 Inbound message missing](https://github.com/soimy/openclaw-channel-dingtalk/issues/104)
- [#164 经常无法接受到消息无法回复](https://github.com/soimy/openclaw-channel-dingtalk/issues/164)
- [#151 过几个小时后经常断线](https://github.com/soimy/openclaw-channel-dingtalk/issues/151)
- [#187 待机太久出现不可用](https://github.com/soimy/openclaw-channel-dingtalk/issues/187)
- [#302 TCP half-open问题](https://github.com/soimy/openclaw-channel-dingtalk/issues/302)
- [#303 Connection attempt x failed: protocol mismatch](https://github.com/soimy/openclaw-channel-dingtalk/issues/303)

相关 PRs：
- [#96 fix(dingtalk): harden inbound message handling](https://github.com/soimy/openclaw-channel-dingtalk/pull/96)
- [#167 fix(dingtalk): clean up heartbeat timer on reconnect](https://github.com/soimy/openclaw-channel-dingtalk/pull/167)
- [#183 fix(dingtalk): add stale lock cleanup on send path](https://github.com/soimy/openclaw-channel-dingtalk/pull/183)
- [#249 improve DingTalk connection troubleshooting](https://github.com/soimy/openclaw-channel-dingtalk/pull/249)
- [#313 fix: lazy-preload peer ID registry to fix 400 errors in delivery queue](https://github.com/soimy/openclaw-channel-dingtalk/pull/313)
- [#323 fix: increase health check interval/grace to prevent reconnect storm](https://github.com/soimy/openclaw-channel-dingtalk/pull/323)
- [#325 test(connection-manager): align health check timings with new 60s/30s constants](https://github.com/soimy/openclaw-channel-dingtalk/pull/325)

任务：
- [ ] 复核现有稳定性问题是否仍可复现
- [ ] 明确各已合并 PR 的覆盖范围与遗漏场景
- [ ] 建立最小回归用例：常规收发、长待机后收发、断线恢复、连接失败排障
- [ ] 形成“已收敛 / 未收敛 / 需新增 issue”结论
- [ ] 验证 `#313` 在“冷启动后立即主动发送”场景的稳定性
- [ ] 收敛 `#302/#303` 的复现路径与排障步骤
- [ ] 验证 `#323/#325` 后长待机与恢复窗口是否仍出现“间歇性收不到消息”（关联 `#104` 新增反馈）

### 2. AI Card 发送链路一致性
相关 Issues：
- [#166 回复done问题](https://github.com/soimy/openclaw-channel-dingtalk/issues/166)
- [#197 ai卡片模式下，主动发消息内容不正常](https://github.com/soimy/openclaw-channel-dingtalk/issues/197)
- [#136 同样的内容，会出现两遍](https://github.com/soimy/openclaw-channel-dingtalk/issues/136)
- [#318 日志显示API 被限流](https://github.com/soimy/openclaw-channel-dingtalk/issues/318)
- [#319 bug: sessionWebhook 过期后无 fallback，长任务回复静默丢失](https://github.com/soimy/openclaw-channel-dingtalk/issues/319)
- [#321 bug: deliver 回调中 payload.text 为空时直接 return，导致媒体消息无文字说明](https://github.com/soimy/openclaw-channel-dingtalk/issues/321)
- [#290 bug: reasoning token 内容重复堆叠进 AI card](https://github.com/soimy/openclaw-channel-dingtalk/issues/290)
- [#282 reasoning没有结束状态](https://github.com/soimy/openclaw-channel-dingtalk/issues/282)

相关 PRs：
- [#191 serialize send pipeline with session-scoped dispatch lock](https://github.com/soimy/openclaw-channel-dingtalk/pull/191)
- [#179 hardening send path](https://github.com/soimy/openclaw-channel-dingtalk/pull/179)
- [#291 fix(card): use replace mode for reasoning stream to prevent content duplication](https://github.com/soimy/openclaw-channel-dingtalk/pull/291)
- [#311 fix: deliver MEDIA attachments in inbound reply handler](https://github.com/soimy/openclaw-channel-dingtalk/pull/311)
- [#326 feat: support multiple final chunk](https://github.com/soimy/openclaw-channel-dingtalk/pull/326)
- [#327 fix(dingtalk): restore non-session inbound logic regressed by #307](https://github.com/soimy/openclaw-channel-dingtalk/pull/327)

任务：
- [ ] 回归 Done 提前结束问题
- [ ] 回归空回复问题
- [ ] 回归主动通知内容异常问题
- [ ] 回归重复输出问题
- [ ] 判断剩余问题是否需要拆出新的修复任务
- [ ] 回归 `sessionWebhook` 过期后的 fallback 发送路径（#319）
- [ ] 回归媒体消息 `仅媒体/仅文本/媒体+文本` 的 deliver 组合行为（#321/#311）
- [ ] 评估并实现 `card.stream` 节流/合并策略，降低限流风险（#318）
- [ ] 复核 reasoning 重复堆叠修复是否稳定（#290/#291）
- [ ] 回归“多个 final chunk + 工具报错”场景，确认最终输出不会被吞（#326）
- [ ] 复核 `#327` 恢复后的 reply-stream 契约是否完整（`cardUpdateMode=replace`、`payload.text` 路径）

### 3. 文件上传 / 文件读取 / 文件预览 / 大文件链路
相关 Issues：
- [#207 通过钉钉无法上传文件给Openclaw](https://github.com/soimy/openclaw-channel-dingtalk/issues/207)
- [#218 群里的文件都以 file 后缀结尾，无法预览](https://github.com/soimy/openclaw-channel-dingtalk/issues/218)
- [#101 支持访问钉盘文件](https://github.com/soimy/openclaw-channel-dingtalk/issues/101)
- [#125 大文件分片上传](https://github.com/soimy/openclaw-channel-dingtalk/issues/125)
- [#315 无法让openclaw将本地文件通过钉钉发送（Dup #207）](https://github.com/soimy/openclaw-channel-dingtalk/issues/315)

相关 PRs：
- [#68 feat(dingtalk): implement file uploading with send image, video and file support](https://github.com/soimy/openclaw-channel-dingtalk/pull/68)

任务：
- [ ] 核对基础文件发送能力的当前边界
- [ ] 拆分文件上传、读取、预览、扩展名处理、大文件、钉盘访问子任务
- [ ] 为每个子任务补最小复现和验收标准
- [ ] 明确哪些属于补尾，哪些需要新增开发
- [ ] 复核 `#315` 场景在当前版本中的行为与诊断提示是否一致

### 4. 图片 / 语音 / 媒体链路补强
相关 Issues：
- [#162 无法发送图片](https://github.com/soimy/openclaw-channel-dingtalk/issues/162)
- [#86 在AI的流式卡片上也实现插入图片/视频音频等](https://github.com/soimy/openclaw-channel-dingtalk/issues/86)
- [#306 钉钉无法发送图片，提示富文本（Dup #162）](https://github.com/soimy/openclaw-channel-dingtalk/issues/306)
- [#316 钉钉机器人无法发送本地文件或者图片发给我（Dup #162）](https://github.com/soimy/openclaw-channel-dingtalk/issues/316)

相关 PRs：
- [#182 support local image sending](https://github.com/soimy/openclaw-channel-dingtalk/pull/182)
- [#200 support asVoice for media messages](https://github.com/soimy/openclaw-channel-dingtalk/pull/200)
- [#181 add mediaMaxMb override for inbound media size limit](https://github.com/soimy/openclaw-channel-dingtalk/pull/181)
- [#311 fix: deliver MEDIA attachments in inbound reply handler](https://github.com/soimy/openclaw-channel-dingtalk/pull/311)

任务：
- [ ] 回归本地图片发送
- [ ] 回归语音消息发送
- [ ] 回归入站媒体大小限制覆盖配置
- [ ] 评估 AI Card 内媒体一体化展示是否值得推进
- [ ] 明确哪些项已完成、哪些项仍待开发
- [ ] 回归 Windows 绝对路径/相对路径下图片与文件发送（#316, #241）

---

## P1

### 5. 引用消息 / chatRecord / 转发记录解析收口
相关 Issues：
- [#126 引用消息支持](https://github.com/soimy/openclaw-channel-dingtalk/issues/126)
- [#205 chatRecord 消息显示空白](https://github.com/soimy/openclaw-channel-dingtalk/issues/205)
- [#208 优化 chatRecord 空内容提示](https://github.com/soimy/openclaw-channel-dingtalk/issues/208)
- [#227 forward/chatRecord 相关问题](https://github.com/soimy/openclaw-channel-dingtalk/issues/227)
- [#286 不支持识别钉群中富文本引用吗？](https://github.com/soimy/openclaw-channel-dingtalk/issues/286)

相关 PRs：
- [#128 feat(dingtalk): support quoted messages](https://github.com/soimy/openclaw-channel-dingtalk/pull/128)
- [#202 fix(dingtalk): improve quote and forward handling](https://github.com/soimy/openclaw-channel-dingtalk/pull/202)
- [#209 fix(dingtalk): handle empty forward payload](https://github.com/soimy/openclaw-channel-dingtalk/pull/209)
- [#210 fix(dingtalk): improve quote journal compatibility](https://github.com/soimy/openclaw-channel-dingtalk/pull/210)
- [#233 quote/chatRecord/stream-card hardening](https://github.com/soimy/openclaw-channel-dingtalk/pull/233)
- [#257 clarify empty chatRecord payload behavior](https://github.com/soimy/openclaw-channel-dingtalk/pull/257)

任务：
- [ ] 梳理各 PR 的前后替代关系
- [ ] 明确引用消息解析的最终行为
- [ ] 明确 chatRecord 空内容提示策略
- [ ] 明确转发记录展示策略
- [ ] 做一次集中回归并沉淀结论
- [ ] 补充富文本 markdown/代码块引用场景回归，确认引用内容传递边界（#286）

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
- [#130 多 agent 配置相关](https://github.com/soimy/openclaw-channel-dingtalk/issues/130)
- [#132 多账号 schema / ControlUI 兼容相关](https://github.com/soimy/openclaw-channel-dingtalk/issues/132)
- [#304 openclaw网页钉钉插件提示Unsupported schema node. Use Raw mode.](https://github.com/soimy/openclaw-channel-dingtalk/issues/304)

相关 PRs：
- [#133 feat(dingtalk): add multi-account schema support](https://github.com/soimy/openclaw-channel-dingtalk/pull/133)
- [#137 refactor(dingtalk): modularize channel implementation](https://github.com/soimy/openclaw-channel-dingtalk/pull/137)
- [#307 feat(dingtalk): 支持 owner 控制群共享会话别名](https://github.com/soimy/openclaw-channel-dingtalk/pull/307)
- [#317 feat(dingtalk): add @sub-agent basic support for group chat multi-agent scenarios](https://github.com/soimy/openclaw-channel-dingtalk/pull/317)
- [#324 fix(config): resolve dashboard Unsupported schema node for #304](https://github.com/soimy/openclaw-channel-dingtalk/pull/324)
- [#327 fix(dingtalk): restore non-session inbound logic regressed by #307](https://github.com/soimy/openclaw-channel-dingtalk/pull/327)

任务：
- [ ] 补齐配置示例
- [ ] 增加配置校验
- [ ] 优化启动时报错
- [ ] 补齐文档说明
- [ ] 明确 `session-alias` 与框架 routing bindings 的职责边界（#307）
- [ ] 评估 `@sub-agent` 能力与现有路由模型整合方案（#317）
- [ ] 复核 dashboard schema 渲染与 legacy key 归一化行为在 UI/Raw 配置路径的一致性（#304/#324）
- [ ] 跟进 `#317` 冲突与 review blocking 项，避免再次回归 `#327` 已修复的 inbound 能力

### 9. 支持群聊 @人 / @all
相关 Issues：
- [#67 机器人群聊中支持@某人](https://github.com/soimy/openclaw-channel-dingtalk/issues/67)
- [#288 支持群里多个龙虾左右互搏相互at吗？（Dup #67）](https://github.com/soimy/openclaw-channel-dingtalk/issues/288)
- [#305 群组中艾特机器人受限（Dup #67）](https://github.com/soimy/openclaw-channel-dingtalk/issues/305)

相关 PRs：
- [#317 feat(dingtalk): add @sub-agent basic support for group chat multi-agent scenarios](https://github.com/soimy/openclaw-channel-dingtalk/pull/317)

任务：
- [ ] 明确 @单人 需求范围
- [ ] 明确 @多人 需求范围
- [ ] 明确 @all 需求范围
- [ ] 设计失败降级与兼容行为
- [ ] 整理 `#288/#305` 重复诉求，收敛为 `#67` 验收标准

### 10. 支持对话打断 / 取消任务
相关 Issues：
- [#76 对话打断功能](https://github.com/soimy/openclaw-channel-dingtalk/issues/76)
- [#310 啥时候能支持acp啊](https://github.com/soimy/openclaw-channel-dingtalk/issues/310)

任务：
- [ ] 明确用户主动取消的交互形式
- [ ] 明确长任务中断机制
- [ ] 明确中断后状态回收方式
- [ ] 明确 UI / 提示语反馈
- [ ] 明确 ACP 最小可用范围（`/acp spawn`）及 `status/steer/cancel` 分阶段目标（#310）

### 11. AI Card usage footer / thinking 展示行为可配置
相关 Issues：
- [#111 usage footer](https://github.com/soimy/openclaw-channel-dingtalk/issues/111)
- [#236 思考中如何关闭](https://github.com/soimy/openclaw-channel-dingtalk/issues/236)
- [#312 为什么卡片模板的参数只支持一个，如果相传多个怎么实现](https://github.com/soimy/openclaw-channel-dingtalk/issues/312)
- [#320 reasoning stream提示 Reasoning stream enabled (Telegram only).（Dup #236）](https://github.com/soimy/openclaw-channel-dingtalk/issues/320)

相关 PRs：
- [#119 AI Card thinking/tool use streaming](https://github.com/soimy/openclaw-channel-dingtalk/pull/119)
- [#214 make thinking message configurable](https://github.com/soimy/openclaw-channel-dingtalk/pull/214)
- [#322 fix: wire onToolResult to enable verbose tool streaming in card mode](https://github.com/soimy/openclaw-channel-dingtalk/pull/322)

任务：
- [ ] 明确 thinking 展示可配置项
- [ ] 明确 tool use 展示可配置项
- [ ] 明确 usage footer 展示策略
- [ ] 补齐默认值与文档说明
- [ ] 评估卡片模板多参数/多按钮交互支持方案（#312）
- [ ] 明确 `/reasoning stream` 在钉钉通道的提示与降级策略（#320）
- [ ] 回归 reasoning 结束态在钉钉卡片上的收敛行为（#282）
- [ ] 回归 `/verbose on` 下 tool result 流式展示在卡片模式的可见性（#322）

---

## P3

### 12. 流式与响应时延
相关 Issues：
- [#238 新版本：延迟20S](https://github.com/soimy/openclaw-channel-dingtalk/issues/238)
- [#260 发现流式是假的，是最终生成完以后才开始流](https://github.com/soimy/openclaw-channel-dingtalk/issues/260)

相关 PRs：
- [#255 make stream keepAlive configurable and default off](https://github.com/soimy/openclaw-channel-dingtalk/pull/255)

任务：
- [ ] 评估 20 秒延迟是否仅在超大规模部署下发生
- [ ] 评估个人场景是否真的需要真流式
- [ ] 评估消息更新 API 配额消耗
- [ ] 评估低更新频率的替代方案
- [ ] 修复 chunk 模式仅显示增量字符的问题
- [ ] 给出“继续投入 / 保持现状”的结论

### 13. README / 截图 / onboarding / 配置说明补齐
相关 Issues：
- [#242 README 能否增加一些图片截图](https://github.com/soimy/openclaw-channel-dingtalk/issues/242)
- [#243 为啥我配置好了参数 一直显示0 ... Request failed with status code 400](https://github.com/soimy/openclaw-channel-dingtalk/issues/243)

相关 PRs：
- [#175 docs: align README cardTemplateKey default](https://github.com/soimy/openclaw-channel-dingtalk/pull/175)
- [#199 docs: align onboarding and runtime defaults](https://github.com/soimy/openclaw-channel-dingtalk/pull/199)
- [#301 feat(dingtalk): 增加钉钉文档 gateway methods](https://github.com/soimy/openclaw-channel-dingtalk/pull/301)

任务：
- [ ] 补 README 截图
- [ ] 补 onboarding 示例
- [ ] 补配置说明
- [ ] 补常见问题
- [ ] 补排障说明
- [ ] 增补 `400/protocol mismatch` 常见排障示例与配置核对清单（#243/#303）
- [ ] 补充 `dingtalk.docs.*` gateway methods 的使用示例与权限/参数说明（#301）

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
