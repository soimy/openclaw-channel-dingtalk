# 配置项参考

本页汇总常用配置项及其作用。更完整的场景说明请结合功能页一起阅读。

## 主要配置项

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用插件 |
| `clientId` | string | 必填 | 钉钉 AppKey；同时作为钉钉 API 请求中的 `robotCode` |
| `clientSecret` | string | 必填 | 钉钉 AppSecret |
| `dmPolicy` | string | `open` | 私聊策略 |
| `groupPolicy` | string | `open` | 群聊策略 |
| `allowFrom` | string[] | `[]` | 私聊白名单 |
| `groupAllowFrom` | string[] | - | 群聊发送者白名单 |
| `groups` | object | - | 群级配置 |
| `displayNameResolution` | string | `disabled` | 是否允许基于本地目录做显示名解析 |
| `contextVisibility` | string | 宿主默认值 | 是否限制宿主补充上下文、引用上下文与历史上下文的可见性 |
| `bypassProxyForSend` | boolean | `false` | 发送链路是否绕过全局代理 |
| `learningEnabled` | boolean | `false` | 是否开启学习信号采集 |
| `learningAutoApply` | boolean | `false` | 是否自动注入学习结果 |
| `learningNoteTtlMs` | number | `21600000` | 会话级学习笔记 TTL |
| `mediaUrlAllowlist` | string[] | `[]` | 允许下载的远程媒体目标 |
| `journalTTLDays` | number | `7` | 引用回溯日志保留天数 |
| `ackReaction` | string | - | 原生处理中表情反馈 |
| `messageType` | string | `markdown` | 回复模式：`markdown` 或 `card` |
| `cardTemplateId` | string | - | AI 卡片模板 ID |
| `cardTemplateKey` | string | `content` | 卡片内容字段名 |
| `cardStreamingMode` | string | `off`（生效值） | 卡片流式模式：`off` / `answer` / `all` |
| `cardStreamInterval` | number | `1000` | 卡片实时更新节奏（毫秒，最小 `200`） |
| `cardAtSender` | string | - | 群聊中卡片完成后追加 @发送者 的消息文本；非空时生效 |
| `cardRealTimeStream` | boolean | `false` | 已弃用；仅兼容旧配置，`true` 会回退到 `cardStreamingMode: all` |
| `aicardDegradeMs` | number | `1800000` | 卡片连续失败后的降级时间 |
| `debug` | boolean | `false` | 是否输出调试日志 |
| `mediaMaxMb` | number | - | 入站媒体大小上限 |
| `maxConnectionAttempts` | number | `10` | 最大连接重试次数 |
| `initialReconnectDelay` | number | `1000` | 初始重连延迟 |
| `maxReconnectDelay` | number | `60000` | 最大重连延迟 |
| `reconnectJitter` | number | `0.3` | 重连抖动因子 |

## 关于 `clientId` 与钉钉 `robotCode`

钉钉开放接口的请求体里仍会携带 `robotCode` 字段。本插件不提供单独的 `robotCode`、`corpId` 或钉钉应用 `agentId` 配置项：`clientId` 会作为机器人代码用于相关 API 调用。

## 关于 `displayNameResolution`

- `disabled`：默认值，只允许显式 ID
- `all`：允许本地学习目录参与群名和显示名解析

启用后要注意两类风险：

- 误投风险：重名、改名、旧目录数据都可能导致误解析
- 权限扩散风险：当前没有 owner-only 粒度

对敏感通知和不可撤回消息，建议优先使用显式 ID。

## 关于 `contextVisibility`

- `all`：沿用宿主当前的补充上下文行为
- `allowlist`：只保留宿主 allowlist 范围内的补充上下文
- `allowlist_quote`：优先保留显式引用 / 回复上下文，同时过滤额外补充上下文

如果你只想让模型看到“用户明确引用的那条消息”，通常 `allowlist_quote` 是最稳妥的高级模式。

它和 `displayNameResolution` 的职责不同：

- `contextVisibility` 控制“宿主把多少上下文送进 reply runtime”
- `displayNameResolution` 控制“插件是否允许根据本地学习目录解析群名或显示名”

前者影响模型可见上下文，后者影响目标解析与投递安全；两者不要混用。

## 关于 `ackReaction`

启用后，插件会在处理开始时对用户原消息添加原生文本表情反馈，处理结束后自动撤回。

常见配置：

- `""`：关闭
- `"🤔思考中"`：固定“思考中”
- `"emoji"`：使用固定 emoji 模式
- `"kaomoji"`：按输入语气选择颜文字

## 关于 `cardStreamingMode` / `cardRealTimeStream` / `cardStreamInterval`

- `cardStreamingMode=off`：关闭答案实时流式，增量更新最少。
- `cardStreamingMode=answer`：只实时推送答案内容。
- `cardStreamingMode=all`：实时推送答案与思考内容。
- `cardRealTimeStream` 已弃用，仅保留兼容：
- 未设置 `cardStreamingMode` 且 `cardRealTimeStream=true` 时，生效为 `all`。
- 同时设置时，以 `cardStreamingMode` 为准。
- `cardStreamInterval` 控制实时更新节奏（毫秒），在 `answer` / `all` 下生效；值越小，更新越频繁，API 调用通常越高。

## 关于连接参数

连接相关配置用于提升 Stream 连接鲁棒性：

- 最大尝试次数
- 指数退避延迟
- 随机抖动
- 发送链路代理绕过

## 相关文档

- [配置](../getting-started/configure.md)
- [安全策略](security-policies.md)
- [AI 卡片](../features/ai-card.md)
