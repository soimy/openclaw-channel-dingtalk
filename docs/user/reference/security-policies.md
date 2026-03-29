# 安全策略

本页说明私聊、群聊和远程媒体下载相关的主要安全控制点。

## 私聊策略 `dmPolicy`

- `open`：任何人都可以私聊机器人
- `pairing`：新用户需通过配对码验证
- `allowlist`：只有白名单用户可用

## 群聊策略 `groupPolicy`

- `open`：任何群都可以 @机器人
- `allowlist`：只有配置中的群可以使用
- `disabled`：完全禁用群聊消息

## `allowlist` 模式的群聊判定

当 `groupPolicy = "allowlist"` 时，判定顺序通常是：

1. 命中 `groups[conversationId]`
2. 命中 `groups["*"]`
3. 旧版兼容路径：`allowFrom` 中包含群 ID
4. 都不匹配则拒绝

## 群聊发送者白名单

群准入通过后，还可以继续限制允许发言的用户。

优先级：

1. `groups[conversationId].groupAllowFrom`
2. `groups["*"].groupAllowFrom`
3. 顶层 `groupAllowFrom`
4. 未配置则不限制

## `requireMention`

可以为每个群单独配置是否必须 @机器人。

但在钉钉群聊里，不 @机器人通常就不会收到消息，因此这一选项在钉钉场景中的实际价值有限。

## 远程媒体下载防护

远程 `mediaUrl` 下载默认带以下限制：

- 超时
- 大小上限
- 内网和本地地址拒绝
- DNS 解析结果校验

如需从受控内网媒体服务下载，需要显式配置 `mediaUrlAllowlist`。

支持的白名单形式包括：

- 主机名
- 泛域名
- 主机加端口
- 单个 IP
- CIDR 网段

## 适用建议

- 对生产环境，优先最小化开放范围
- 对高风险消息发送，优先显式目标 ID
- 对 owner 命令与本地状态修改命令，明确限制来源

## 相关文档

- [配置项参考](configuration.md)
- [消息类型支持](../features/message-types.md)
