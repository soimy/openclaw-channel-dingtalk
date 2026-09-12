# Spec: 收窄 Gateway docs RPC 与主动发送的授权边界（Issue #608 问题 3）

## 背景

ClawHub 安全审核（v3.6.11）的 LLM 分析将 `gateway-docs-and-send-rpc` 列为风险项：插件通过 `index.ts` 注册了

- `dingtalk.docs.create / append / search / list`（及 `dingtalk-connector.docs.*` 别名）
- `dingtalk-connector.sendToUser / sendToGroup / send`

这些 RPC 直接使用配置中的钉钉应用凭证执行文档读写和主动发消息，插件自身没有任何细粒度的调用方授权、文档空间限制或能力开关。

对照官方仓库 `DingTalk-Real-AI/dingtalk-openclaw-connector`：

1. **官方 connector 同样没有对 docs/send RPC 做调用方鉴权**——`src/gateway-methods.ts` 中 docs.read/create/append/search 与 sendToUser/sendToGroup 只做"clientId 已配置 + 参数必填"检查，之后即用应用凭证直接调用钉钉 API。也就是说宿主 Gateway 层的信任模型（能连上 Gateway RPC 的调用方即为可信）是两边共同的基线，这一点在审核材料中应当显式说明。
2. **官方 connector 提供了能力开关**：`src/config/schema.ts` 中定义了 `DingtalkToolsConfigSchema`：

   ```ts
   const DingtalkToolsConfigSchema = z.object({
     docs: z.boolean().optional(),  // 文档操作（默认 true）
     media: z.boolean().optional(), // 媪体上传（默认 true）
   }).strict();
   ```

   虽然当前 gateway-methods 并未全部消费该开关，但它给出了可对齐的配置形态：**capability gate 以 `tools.{docs,media}` 布尔开关呈现，默认开启、可显式关闭**。
3. **官方 connector 的 docs.read 要求 `operatorId`**（unionId/staffId），把"以谁的身份读文档"交给调用方显式声明，避免插件默认用机器人身份遍历空间；本插件的 docs RPC 无此概念。

## 问题

本插件 `index.ts` 的 docs RPC 与 connector 兼容发送 RPC：

- 没有任何插件级 capability/config gate，无法关闭；
- 没有文档空间（spaceId）白名单；
- 没有主动发送目标（user:/group:）白名单；
- 审核材料/文档中未说明其依赖宿主 Gateway 信任模型与所需钉钉权限。

## 目标

1. docs RPC 与主动发送 RPC 可通过配置显式关闭（capability gate）。
2. 可选的空间/目标白名单，收窄默认影响面。
3. 行为向后兼容：默认开启（与官方 connector 的 `tools.docs 默认 true` 对齐），避免破坏现有 cron/agent 调用方。
4. 文档中清楚说明信任模型与所需钉钉权限，供 ClawHub 审核材料引用。

## 方案

### 1. 配置 schema 新增 `gateway.tools` 能力开关（对齐官方 `tools.*` 形态）

在 `src/config-schema.ts` 的共享配置形状中新增：

```ts
gateway: z.object({
  tools: z.object({
    docs: z.boolean().optional(),        // 默认 true
    proactiveSend: z.boolean().optional(), // 默认 true
  }).strict().optional(),
  docs: z.object({
    allowedSpaceIds: z.array(z.string()).optional(), // 未配置 = 不限制
  }).strict().optional(),
  send: z.object({
    allowedTargets: z.array(z.string()).optional(),  // "user:xxx" / "group:cid"，未配置 = 不限制
  }).strict().optional(),
}).strict().optional(),
```

在 `src/config.ts` 增加解析函数（默认值回退，多账号继承渠道级默认，与 `mergeAccountWithDefaults` 一致）：

```ts
resolveGatewayCapabilityConfig(config): {
  docsEnabled: boolean;            // 默认 true
  proactiveSendEnabled: boolean;   // 默认 true
  allowedSpaceIds?: string[];
  allowedTargets?: string[];
}
```

### 2. `index.ts` 的 handler 统一走 gate

- 抽一个 `withGatewayCapability(api, capability, handler)` 包装器（或在各 handler 开头调用 `resolveGatewayCapabilityConfig`）：
  - `docs.*` → 检查 `docsEnabled`，再检查 `allowedSpaceIds`（若配置）包含请求中的 `spaceId`；`docs.append` 无 spaceId 时应先通过 `docs-service` 反查所属空间或在 gate 中要求传入 spaceId（推荐：保持兼容，仅当配置了白名单才要求反查/拒绝）。
  - `sendToUser / sendToGroup / send` → 检查 `proactiveSendEnabled`，再检查 `allowedTargets`（若配置）。
- 被拒时返回 `respond(false, { error: "dingtalk gateway tool '<x>' is disabled by config" })`，并打 `[DingTalk][GatewayRPC][Denied]` 日志。
- `dingtalk.docs.*` 与 `dingtalk-connector.docs.*` 共享同一 handler，gate 自动对别名生效。

### 3. 文档与审核材料

- `docs/user/`：新增/更新 Gateway RPC 章节，说明：
  - 信任模型：这些 RPC 面向已获得 OpenClaw Gateway 访问权的调用方（与官方 connector 一致），插件层不做二次身份认证；
  - 如何用 `gateway.tools.*` 关闭能力、用 `allowedSpaceIds` / `allowedTargets` 收窄范围；
  - 所需钉钉应用权限（文档读写、机器人消息发送对应的 OpenAPI scope）。
- 若 `docs/` 站点有安全/权限说明页，追加"ClawHub 审核说明"小节，回应 `gateway-docs-and-send-rpc` finding。

## 非 Goals

- 不做插件级调用方身份认证（由宿主 Gateway 信任模型负责，与官方 connector 一致）。
- 不改动 `send` channel action（问题 2 的媒体路径边界由另一份方案覆盖）。
- 不调整 `dmPolicy` / `groupPolicy` 默认值（问题 4 单独评估）。

## 实现偏差说明

实现时配置键由 spec 中的 `gateway` 更名为 **`gatewayRpc`**（`channels.dingtalk.gatewayRpc`）：宿主 `OpenClawConfig` 已存在顶层 `gateway` 配置（网络/发现/角色策略），插件级 `gateway` 字段会与其类型冲突。其余能力开关形态（`tools.docs` / `tools.proactiveSend`、`docs.allowedSpaceIds`、`send.allowedTargets`）与 spec 一致。

另外两点审核后明确的边界（已写入用户文档）：

- 账号级 `gatewayRpc` 覆盖是对象级整体替换（沿承渠道级配置的浅合并语义），不做子键深合并。
- `docs.append` 不携带 `spaceId`；配置 `allowedSpaceIds` 后 append 会被显式拒绝（拒绝信息说明"方法不携带 spaceId"），未配置白名单时 append 不受影响。

## 实现 TODO

- [ ] `src/config-schema.ts`：新增 `gateway.tools/docs/send` schema 与一致性校验（如 `allowedTargets` 项必须以 `user:`/`group:` 开头）。
- [ ] `src/config.ts`：`resolveGatewayCapabilityConfig` + 多账号继承 + 单测。
- [ ] `index.ts`：handler 接入 gate；统一拒绝响应与日志前缀。
- [ ] 单测：`tests/unit/` 覆盖 gate 默认开启、显式关闭、白名单命中/未命中、`dingtalk-connector.*` 别名同样受限。
- [ ] `docs/user/` 更新；必要时更新 onboarding 提示。
- [ ] `pnpm run type-check && pnpm lint && pnpm test`，然后 `pnpm run build:runtime` 重新构建 `dist/index.js`，重新发布并复查 ClawHub 审核结果。

## 验证 TODO

- [ ] 关闭 `gateway.tools.docs` 后，`dingtalk.docs.create` 与 `dingtalk-connector.docs.create` 均返回禁用错误。
- [ ] 配置 `allowedSpaceIds` 后，未列入的 spaceId 请求被拒绝；未配置时行为不变。
- [ ] 关闭 `gateway.tools.proactiveSend` 后，`sendToUser/sendToGroup/send` 全部拒绝；聊天回复通道（inbound reply）不受影响。
- [ ] 现有 cron/agent 调用方在默认配置下无需改动即可继续工作（向后兼容验证）。
- [ ] ClawHub 重新审核后 `gateway-docs-and-send-rpc` finding 降级或消除。
