# Gateway RPC 兼容层

本插件现在提供两组 DingTalk Gateway RPC 命名空间：

- `dingtalk.*`：本仓库的 canonical OpenClaw DingTalk 插件命名空间。
- `dingtalk-connector.*`：仅面向已有 connector 风格调用方的兼容命名空间。

`dingtalk-connector.*` 是本仓库现有 DingTalk 能力之上的薄适配层。它不 vendored、不依赖、也不承诺兼容任何独立的 DingTalk connector 项目。新调用方如果没有历史兼容需求，应优先使用 `dingtalk.*`。

## 兼容边界

`dingtalk-connector.*` 只保留 Gateway 调用方需要的最小稳定表面：

- `dingtalk-connector.sendToUser`：把 `userId` 映射为 `user:<userId>`，内容参数接受 `content` 或 `message`。
- `dingtalk-connector.sendToGroup`：把 `openConversationId` 映射为 `group:<openConversationId>`，内容参数接受 `content` 或 `message`。
- `dingtalk-connector.send`：直接接受 canonical `target` 字符串；当前只接受 `user:*` 或 `group:*`，避免在 RPC 边界透传无法识别的目标格式。
- `dingtalk-connector.status`：返回已配置账号的配置状态；`clientId` 只返回脱敏尾号，不暴露完整凭证标识。
- `dingtalk-connector.probe`：通过请求 access token 验证账号凭证；成功响应同样只返回脱敏后的 `clientId`。
- `dingtalk-connector.docs.*`：与 `dingtalk.docs.*` 共享同一组 handler，只是兼容别名。

这些兼容方法复用 canonical auth、send、docs、usage-tracking 和 outbound-context persistence 路径。后续如果某个兼容请求需要与 `dingtalk.*` 不同的行为，必须先在这里说明差异，再扩展适配层。

## 能力开关与白名单 `gatewayRpc`

docs RPC 与主动发送 RPC 使用配置中的钉钉应用凭证直接执行文档读写和发消息。它们面向已获得 OpenClaw Gateway 访问权的调用方（插件层不做二次调用方身份认证）；如需进一步收窄，可通过 `channels.dingtalk.gatewayRpc` 配置：

```json5
{
  "channels": {
    "dingtalk": {
      "gatewayRpc": {
        "tools": {
          "docs": true,           // 关闭后 dingtalk.docs.* 与 dingtalk-connector.docs.* 全部拒绝
          "proactiveSend": true   // 关闭后 dingtalk-connector.sendToUser/sendToGroup/send 全部拒绝
        },
        "docs": {
          "allowedSpaceIds": ["spaceA"] // 配置后 docs RPC 只接受这些 spaceId（至少一项）；未配置不限制
        },
        "send": {
          "allowedTargets": ["user:staff123", "group:cidXXXX"] // 配置后发送目标必须在列表内；未配置不限制
        }
      }
    }
  }
}
```

行为说明：

- 所有开关默认开启，向后兼容；显式关闭后对应 RPC 返回 `error`，并在日志中打出 `[DingTalk][GatewayRPC][Denied]` 前缀。
- `dingtalk.docs.*` 与 `dingtalk-connector.docs.*` 共享同一组 handler，能力开关对两个命名空间同时生效。
- `allowedTargets` 中的每一项必须是 `user:<id>` 或 `group:<conversationId>`；`allowedSpaceIds` / `allowedTargets` 一旦配置就至少需要一项，空数组会被配置校验直接拒绝，避免"限制被静默取消"。
- 白名单是 fail-closed 的：运行时若收到"已配置但为空"的白名单（例如绕过了配置校验），会按"全部拒绝"处理。
- 多账号场景下，账号级 `gatewayRpc` **按子键与渠道级合并**（`tools` / `docs` / `send` 三组分别合并），同一子键以账号级为准。因此渠道级的 `tools.docs: false` 或渠道级白名单不会被账号级的局部配置静默移除；未配置的账号完全继承渠道级设置。

`allowedSpaceIds` 的适用范围：

- 配置白名单后，带 `spaceId` 的 docs 方法（`create` / `list` / `search`）只接受白名单内的 `spaceId`。
- `search` 的 `spaceId` 是可选的：配置白名单后，不传 `spaceId` 的 `search` 会被拒绝，因为无法确认它要访问哪个空间。
- `dingtalk.docs.append` / `dingtalk-connector.docs.append` 以 `docId` 为目标、永远不携带 `spaceId`；配置白名单后该方法也会被拒绝，拒绝信息会说明"请求未携带 spaceId"。如需在白名单模式下继续使用 append，请不要配置 `allowedSpaceIds`（改为依赖 `tools.docs` 开关）。

## 所需钉钉应用权限

- docs RPC：钉钉文档/知识库相关 OpenAPI 权限（文档空间读写，`Doc.*` 对应 scope）。
- 主动发送 RPC：机器人消息发送权限（企业机器人 `oToMessages` / `groupMessages` 发送权限）。

