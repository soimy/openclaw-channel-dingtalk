# 安全策略

本页说明私聊、群聊和远程媒体下载相关的主要安全控制点。

## 默认能力面速查表

下表是插件的**默认暴露面**。标为"开启"的项依赖宿主 Gateway 信任模型，插件层不做二次调用方身份认证；标为"关闭"的项需要在配置中显式开启才会生效。

| 配置项 | 默认值 | 风险面 | 启用 / 收窄方式 |
| --- | --- | --- | --- |
| `gatewayCapabilities.tools.docs` | 关闭 | 开启后文档 RPC 可读写钉钉文档空间 | 需要时设 `true`，并配置 `gatewayCapabilities.docs.allowedSpaceIds` |
| `gatewayCapabilities.tools.proactiveSend` | 关闭 | 开启后主动发送 RPC 可向任意 `user:*` / `group:*` 发消息 | 需要时设 `true`，并配置 `gatewayCapabilities.send.allowedTargets` |
| `dmPolicy` | `open` | 任意用户可私聊机器人 | 改 `pairing` / `allowlist` |
| `groupPolicy` | `open` | 任意群可 @机器人 | 改 `allowlist`，或用 `groups` 按群收窄 |
| `learningEnabled` | 关闭 | 学习内容持久化并注入后续 prompt；owner 写入的规则还能**强制精确回复（绕过模型）**。关闭时上述行为全部停止（含已存规则） | 保持关闭，或仅在受控会话中开启 |
| `learningAutoApply` | 关闭 | 自动把生成内容写入 note / 全局 rule | 保持关闭 |
| `learningRuleTtlMs` | 30 天 | 规则超过该窗口后既不再注入 prompt，也不再命中触发语 | 保持默认或调小；`0` 表示永不过期（不建议） |
| `learningAllowManualGlobalRules` | 关闭 | 允许写入 owner 的 account 级规则，并让其注入 prompt、强制精确回复（绕过模型）；关闭时 `/learn global` 直接被拒 | 保持关闭；改用显式作用域的 `/learn targets`、`/learn target-set apply` |
| `mediaUrlAllowlist` | 未配置 | 远程媒体下载范围（默认已拒绝内网与本地地址） | 需要时才显式配置 |

插件的 manifest（`openclaw.plugin.json`）为上述字段声明了 `default`，因此即使不阅读源码，也能从元数据读出默认状态。

> **升级注意（破坏性变更）**：`gatewayCapabilities.tools.docs` / `tools.proactiveSend` 的默认值由 `true` 改为 `false`。升级后如需继续使用 docs 或主动发送 RPC，必须显式开启对应开关；`dingtalk-connector.status` 与 `probe` 不受影响。

最小权限示例：

```json5
{
  "channels": {
    "dingtalk": {
      "dmPolicy": "allowlist",
      "groupPolicy": "allowlist",
      "gatewayCapabilities": {
        // 需要哪一项就开哪一项，并同时限定范围
        "tools": { "docs": true, "proactiveSend": false },
        "docs": { "allowedSpaceIds": ["<spaceId>"] },
        "send": { "allowedTargets": ["user:<staffId>", "group:<conversationId>"] }
      }
    }
  }
}
```

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

发送本地媒体时，OpenClaw 宿主会把允许读取的沙箱目录通过 `mediaLocalRoots` 传给插件。插件按以下规则决定媒体如何被读取：

- **调用方提供的路径一律不直读**：无论是否配置 `mediaLocalRoots`，插件都不会自行打开调用方（含模型产出）给出的主机路径，而是把路径与授权 roots 一起交给 runtime media bridge，由宿主执行边界判定 —— 包括目录包含性、`workspace-<agent>` 的 sibling 隔离、硬链接与文件系统根拒绝等规则。插件不再复刻这套策略，避免随宿主演进产生分歧。
- **`mediaLocalRoots` 的作用**：作为授权参数传递给 bridge。回复链路（AI 卡片图片、Markdown 本地图片、附件投递）会带上宿主导出的 agent-scoped roots（`getAgentScopedMediaLocalRoots(cfg, agentId)`），因此工作区内的媒体可以正常发送。
- **未配置 `mediaLocalRoots`**：bridge 按宿主默认 roots 判定；`workspace-<agent>` 这类需要显式 scoped 授权的路径会被 `path-not-allowed` 拒绝。
- **未配置与显式空数组 `[]` 语义不同**：未配置时 bridge 回落到宿主默认 roots（`localRoots ?? getDefaultLocalRootsCore()`）；显式传 `[]` 表示**不授权任何普通本地 root**，不会启用默认 roots，对普通本地路径比未配置更严格。
- **插件自身生成的临时媒体**：远程 URL 下载、语音转码与 staging 产生的文件由插件直接读取（`O_NOFOLLOW`，读取后清理）；这些路径由插件产出，不受调用方控制。
- **语音消息**：需要转码时先经 bridge 读取源文件字节，再写入插件自有临时文件交给 ffmpeg/ffprobe；`.ogg` / `.amr` 的时长探测同样先把源文件落到插件自有临时文件再调用 ffprobe。
- **升级注意（行为变更）**：此前配置了 `mediaLocalRoots` 时，位于允许目录内的主机文件由插件直接读取；现在统一经 runtime media bridge 读取，并把同一份 roots 传给 bridge。若升级后出现本地媒体发送失败，请检查宿主是否为出站与回复链路提供了正确的 roots（尤其是 agent workspace 的 scoped 授权）。

> `mediaLocalRoots` 由 OpenClaw 宿主提供，不是 `channels.dingtalk` 的配置项；如需调整允许范围，请在宿主侧的媒体访问配置中修改。

## 凭据解析（SecretInput）

`clientSecret` 支持普通的 `env` / `file` SecretInput 引用，解析过程遵循以下边界：

- `env` 引用必须先通过宿主只读路径授权，规则与宿主完全一致：
  - provider 在 `secrets.providers` 中声明为 `source: "env"` 且 `allowlist` 包含该 `id` → 通过
  - provider 声明为 `source: "env"` 但**省略 `allowlist`** → 该 provider 对**任意** `id` 放行，**不做白名单限制**
  - provider 是宿主内置的默认 env provider（`secrets.providers` 中无同名项）→ 按宿主内置默认规则判定
  - 都不满足 → 未授权
- 通过授权后，**环境变量的实际读取由宿主 SDK 完成**：插件只把引用本身交给
  `openclaw/plugin-sdk/secret-ref-readonly` 的 `resolveReadOnlyEnvSecretRef`，由宿主读取该引用对应的**单个**变量并交回结果。插件代码不会自己访问进程环境，也不会把整个 `process.env` 交给任何解析器
- 未通过授权的引用判定为 blocked；已授权但变量未设置或为空判定为未解析。两者都在发起任何 DingTalk API 请求前抛出本地错误，并在日志中给出 `source` / `provider` / `id` 与对应的修复指引
- `file` 引用只通过 `secrets.providers` 的文件 provider 读取，`id` 不会被当作本地路径；密钥文件需要位于受信状态目录并满足宿主权限校验

> **务必显式配置 `allowlist`**：省略 `allowlist` 不是“更安全”，而是让该 env provider 授权所有环境变量名。

## 环境变量读取范围

插件**源码中直接读取**的环境变量只剩一项非凭据例外：

| 环境变量 | 用途 | 说明 |
| --- | --- | --- |
| `DINGTALK_CARD_TEMPLATE_ID` | 覆盖内置 AI 卡片模板 ID | **非凭据例外**：该值是钉钉卡片模板 ID，不是密钥；默认值为内置模板，未设置时不读取任何其它变量 |

`clientSecret` 的 `env` SecretInput 引用**不再由插件读取**：单键读取发生在宿主只读解析器内部（见上一节）。发布前的 `scripts/verify-runtime-package.mjs` 会用语法树校验构建产物（`scripts/ambient-env-guard.mjs`）：除上表例外外，任何进程环境读取都会直接失败，且 `process?.env`、`process["env"]`、`globalThis.process.env`、`const { env } = process` 等等价写法、以及 `node:process` 的 `env` 导入都在拒绝范围内。

除该例外外，插件源码不直接读取宿主环境变量。底层库（例如 HTTP 客户端）可能会按自身约定读取代理类环境变量，这属于宿主既有行为，不受本插件控制。

## Gateway RPC 能力边界

插件暴露的 `dingtalk.docs.*`、`dingtalk-connector.docs.*` 文档 RPC 和 `dingtalk-connector.sendToUser/sendToGroup/send` 主动发送 RPC 依赖宿主 Gateway 信任模型：能调用这些 RPC 的，是已获得 OpenClaw Gateway 访问权的调用方；插件层不做二次调用方身份认证。

可以通过 `channels.dingtalk.gatewayCapabilities` 收窄影响面：

- `gatewayCapabilities.tools.docs = false`：关闭全部 docs RPC
- `gatewayCapabilities.tools.proactiveSend = false`：关闭全部主动发送 RPC
- `gatewayCapabilities.docs.allowedSpaceIds`：文档空间白名单（配置后至少一项；不携带 `spaceId` 的请求会被拒绝）
- `gatewayCapabilities.send.allowedTargets`：主动发送目标白名单（`user:*` / `group:*`；配置后至少一项）

能力开关与白名单默认不启用（保持向后兼容），但一旦配置即 fail-closed：空数组会被配置校验拒绝，运行时遇到"已配置但为空"的白名单按全部拒绝处理；多账号下账号级 `gatewayCapabilities` 与渠道级按子键合并，渠道级的限制不会被账号级局部配置静默移除。

详见 [Gateway RPC 兼容层](gateway-rpc.md)。

## 适用建议

- 对生产环境，优先最小化开放范围
- 对高风险消息发送，优先显式目标 ID
- 对 owner 命令与本地状态修改命令，明确限制来源
- 使用 `env` 引用时，在 `secrets.providers` 中显式配置 `allowlist`，只放行需要的变量名

## 相关文档

- [配置项参考](configuration.md)
- [钉钉权限与凭证](../getting-started/permissions.md)
- [消息类型支持](../features/message-types.md)
