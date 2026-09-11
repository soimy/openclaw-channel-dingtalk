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

## 出站媒体主机读取边界 `mediaLocalRoots`

发送本地媒体时，OpenClaw 宿主会把允许读取的沙箱目录通过 `mediaLocalRoots` 传给插件。插件按以下规则决定是否直接读取主机文件：

- **配置了 `mediaLocalRoots`**：仅当媒体文件的真实路径（解析符号链接后）位于其中某个允许目录内时才直接读取主机文件；允许目录内、但指向目录外的符号链接不会被跟随。
- **路径在允许目录之外**：不直接读取主机文件，改由受控的 runtime media bridge 处理，并继续把 `mediaLocalRoots` 传给 bridge。
- **未配置 `mediaLocalRoots`**：保持历史行为，先尝试直接读取主机文件，文件在主机上不存在时再回退到 runtime media bridge。
- **插件自身生成的临时媒体**：远程 URL 下载和语音转码产生在系统临时目录下的文件由插件直接读取（读取后清理），不受 `mediaLocalRoots` 限制；这些路径不是调用方提供的路径。

> `mediaLocalRoots` 由 OpenClaw 宿主提供，不是 `channels.dingtalk` 的配置项；如需调整允许范围，请在宿主侧的媒体访问配置中修改。

## 凭据解析（SecretInput）

`clientSecret` 支持普通的 `env` / `file` SecretInput 引用，解析过程遵循以下边界：

- `env` 引用必须先通过宿主只读路径授权，规则与宿主完全一致：
  - provider 在 `secrets.providers` 中声明为 `source: "env"` 且 `allowlist` 包含该 `id` → 通过
  - provider 声明为 `source: "env"` 但**省略 `allowlist`** → 该 provider 对**任意** `id` 放行，**不做白名单限制**
  - provider 是宿主内置的默认 env provider（`secrets.providers` 中无同名项）→ 按宿主内置默认规则判定
  - 都不满足 → 未授权
- 通过授权后，插件只读取该引用对应的**单个**环境变量；插件不会读取、也不会把整个 `process.env` 交给解析器
- 未通过授权的引用判定为 blocked；已授权但变量未设置或为空判定为未解析。两者都在发起任何 DingTalk API 请求前抛出本地错误，并在日志中给出 `source` / `provider` / `id` 与对应的修复指引
- `file` 引用只通过 `secrets.providers` 的文件 provider 读取，`id` 不会被当作本地路径；密钥文件需要位于受信状态目录并满足宿主权限校验

> **务必显式配置 `allowlist`**：省略 `allowlist` 不是“更安全”，而是让该 env provider 授权所有环境变量名。

## 环境变量读取范围

插件**源码中直接读取**的环境变量限于两类，均为显式且非凭据用途或经授权的单键读取：

| 环境变量 | 用途 | 说明 |
| --- | --- | --- |
| 经只读路径授权校验的单个 `env` SecretInput `id` | 解析 `clientSecret` | 每次只读取该引用对应的一个变量；是否授权及是否配置白名单见上一节 |
| `DINGTALK_CARD_TEMPLATE_ID` | 覆盖内置 AI 卡片模板 ID | **非凭据例外**：该值是钉钉卡片模板 ID，不是密钥；默认值为内置模板，未设置时不读取任何其它变量 |

除上述两类外，插件源码不直接读取宿主环境变量。底层库（例如 HTTP 客户端）可能会按自身约定读取代理类环境变量，这属于宿主既有行为，不受本插件控制。

## 适用建议

- 对生产环境，优先最小化开放范围
- 对高风险消息发送，优先显式目标 ID
- 对 owner 命令与本地状态修改命令，明确限制来源
- 使用 `env` 引用时，在 `secrets.providers` 中显式配置 `allowlist`，只放行需要的变量名

## 相关文档

- [配置项参考](configuration.md)
- [钉钉权限与凭证](../getting-started/permissions.md)
- [消息类型支持](../features/message-types.md)
