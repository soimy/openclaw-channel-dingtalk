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
