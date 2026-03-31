# OpenClaw requireApproval 功能调研

> 基于 OpenClaw 2026.03.28 版本（PR #55339）的分析
> 调研日期：2026-03-30

## 1. 功能概述

PR #55339 为 `before_tool_call` hooks 增加了 `requireApproval` 异步审批能力，让 plugin 可以暂停 tool 执行并通过以下方式提示用户审批：
- Exec approval overlay（本地 UI）
- Telegram buttons
- Discord interactions
- `/approve` command（任意 channel 均支持）

---

## 2. 两种审批类型

### ExecApprovalRequest（Bash 专用）

OpenClaw **内置**的 Bash 命令执行审批，与 plugin 无关。

触发条件：`security: allowlist` + `ask: on-miss/always`，命令不在 allowlist 时触发。

**关键前提：只在 `host = "gateway"` 或 `host = "node"` 时生效。** 满足以下任一条件才会走 gateway 路径：
1. 配置了 `tools.exec.host: "gateway"`（显式指定）
2. Agent 使用了 elevated 模式（`elevated: true`），且 elevated mode 不是 `"full"`

> 实测：用户配置 `sandbox.mode: "off"` 但未配 `tools.exec.host`，Web UI 会话直接执行命令，不触发 exec approval。DingTalk 会话能触发是因为 `tools.elevated.allowFrom.dingtalk` 使 elevated 路径生效，间接把 host 改为 `"gateway"`。

特点：
- 有完整的 allowlist 管理（pattern 匹配、per-agentId 粒度）
- allow-always → 写入 allowlist 持久化文件，重启后存活
- OpenClaw 全权管理，plugin 只负责 UI 展示（`execApprovals` adapter）

### PluginApprovalRequest（PR #55339 新增，任意 tool）

Plugin 的 `before_tool_call` hook 返回 `requireApproval` 触发。

特点：
- 适用于**任意 tool**，包括 Bash、Edit、Write、WebSearch 等
- 不受 sandbox/exec host 配置影响，在 `before_tool_call` 层拦截，与底层执行路径无关
- allow-always 语义由 plugin 自己通过 `onResolution` callback 实现（OpenClaw 不维护）
- Plugin 自行决定过滤规则、持久化 allowlist

---

## 3. Plugin SDK 接口

### Hook 返回值

```typescript
// before_tool_call hook 接收
type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

// hook 返回值
type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;     // 修改 tool 参数
  block?: boolean;                       // 直接拒绝
  blockReason?: string;
  requireApproval?: {
    title: string;                       // 最长 80 字符
    description: string;                 // 最长 256 字符
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;                  // 默认 120s，最大 600s
    timeoutBehavior?: "allow" | "deny"; // 超时行为，默认 deny
    onResolution?: (decision: PluginApprovalResolution) => Promise<void> | void;
    // pluginId 由 OpenClaw 自动注入，plugin 不要设置
  };
};

// onResolution callback 收到的决定（5个值）
type PluginApprovalResolution =
  | "allow-once"    // 放行此次
  | "allow-always"  // plugin 自己在 onResolution 里实现持久化语义
  | "deny"
  | "timeout"       // 超时未响应
  | "cancelled";    // run 被取消

// PluginApprovalResolved.decision 使用的类型（3个值，与 ExecApprovalDecision 相同）
// "timeout"/"cancelled" 不会出现在 resolved.decision 里，只出现在 onResolution callback 里
type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";
```

### 审批请求 Payload

```typescript
type PluginApprovalRequestPayload = {
  pluginId?: string | null;
  title: string;
  description: string;
  severity?: "info" | "warning" | "critical" | null;
  toolName?: string | null;
  toolCallId?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
  // 来源 channel 信息（用于路由）
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

type PluginApprovalRequest = {
  id: string;
  request: PluginApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};
```

---

## 4. Channel 需要实现的接口

在 `ChannelPlugin` 中增加 `execApprovals?: ChannelExecApprovalAdapter`：

```typescript
type ChannelExecApprovalAdapter = {
  // 声明支持状态（返回对象，不是裸字符串）
  getInitiatingSurfaceState?: (params: { cfg, accountId? })
    => { kind: "enabled" } | { kind: "disabled" } | { kind: "unsupported" };

  // 构建审批请求消息（ExecApproval，Bash 专用）
  buildPendingPayload?: (params: { cfg, request: ExecApprovalRequest, target, nowMs })
    => ReplyPayload | null;
  buildResolvedPayload?: (params: { cfg, resolved: ExecApprovalResolved, target })
    => ReplyPayload | null;

  // 构建审批请求消息（PluginApproval，任意 tool）
  buildPluginPendingPayload?: (params: { cfg, request: PluginApprovalRequest, target, nowMs })
    => ReplyPayload | null;
  buildPluginResolvedPayload?: (params: { cfg, resolved: PluginApprovalResolved, target })
    => ReplyPayload | null;

  // 发送前回调（可选）
  beforeDeliverPending?: (params: { cfg, target, payload }) => Promise<void> | void;

  // 其他（DM 路由、fallback 抑制等）
  shouldSuppressLocalPrompt?: ...;
  hasConfiguredDmRoute?: ...;
  shouldSuppressForwardingFallback?: ...;
};
```

`ChannelExecApprovalForwardTarget`（传给 adapter 方法的 target）：

```typescript
type ChannelExecApprovalForwardTarget = {
  channel: string;           // 如 "dingtalk"
  to: string;                // 目标（群ID或用户ID）
  accountId?: string | null;
  threadId?: string | number | null;
  source?: "session" | "target";
};
```

---

## 5. Gateway 路由机制

**不是广播**，是精确路由。

路由逻辑（`resolveForwardTargets`）：

```javascript
// mode = "session"：路由到发起 turn 的 channel/user（turnSource）
// mode = "targets"：路由到 config 里写死的静态目标
// mode = "both"：两者都发
```

OpenClaw 全局配置（`openclaw.yaml`）：

```yaml
approvals:
  exec:               # 控制 Bash 命令审批转发
    enabled: true
    mode: session     # session | targets | both
    agentFilter: []   # 只对特定 agentId 生效（可选）
    sessionFilter: [] # 只对特定 sessionKey 生效（可选）
    targets:          # 静态转发目标（mode=targets/both 时）
      - channel: dingtalk
        to: "<群ID>"
        accountId: "<account>"

  plugin:             # 控制 Plugin hook 触发的审批转发
    enabled: true
    mode: session
    # 同上
```

关键：`enabled: false` 时，该类型审批请求不会路由到任何 channel。

---

## 6. 审批 Decision 提交

Channel 通过 GatewayClient 提交审批结果：

```javascript
// 提交 plugin approval 决定
gatewayClient.request("plugin.approval.resolve", { id: approvalId, decision })

// 提交 exec approval 决定
gatewayClient.request("exec.approval.resolve", { id: approvalId, decision })
```

需要用 `createOperatorApprovalsGatewayClient` 创建独立的 GatewayClient：

```typescript
import { createOperatorApprovalsGatewayClient }
  from "openclaw/plugin-sdk/gateway-runtime";

const client = await createOperatorApprovalsGatewayClient({ config: cfg });
```

---

## 7. /approve 命令

OpenClaw 内置的 native chat command（`commands-registry` 里注册）：

```
/approve <id> allow-once|allow-always|deny
```

别名支持：`allow` = `allow-once`，`always` = `allow-always` 等。

**DingTalk channel 完全不需要实现任何 `/approve` 相关代码。** OpenClaw 在收到 DingTalk 消息后，会先经过 native command 处理层，识别到 `/approve` 后直接调用内部 resolve 逻辑，不会把消息交给 agent。

`/approve` 会自动 fallback：ID 不匹配 exec approval 时，自动试 plugin approval。两种类型统一处理，channel 侧无感知。

---

## 8. DingTalk 卡片回调机制

`TOPIC_CARD = "/v1.0/card/instances/callback"`

当用户点击 DingTalk 互动卡片上的按钮，DingTalk 通过**同一条 WebSocket Stream 连接**推送回调（不是 HTTP 回调到外部 URL）。

接收路径：`channel.ts` 中已有的 `registerCallbackListener(TOPIC_CARD, ...)` → 解析 payload → 调用 `socketCallBackResponse(messageId, { success: true })` ack。

当前代码只处理 feedback 回调，审批回调需要额外添加分支。

---

## 9. 兼容老版本 OpenClaw

**老版本根本没有这套 hooks**，兼容策略：

| 涉及的代码 | 老版本行为 | 处理方式 |
|---|---|---|
| `dingtalkPlugin.execApprovals` | gateway 不认识，直接忽略 | 无需处理，天然兼容 |
| `api.on("before_tool_call", ...)` | `on` 最坏情况是 noop；或注册成功但 handler 永远不被调用 | 无需处理，天然兼容 |
| `createOperatorApprovalsGatewayClient` | 函数不存在，import 会失败 | **dynamic import + try-catch** |

```typescript
// 兼容处理
async function getGatewayClient(cfg): Promise<GatewayClient | null> {
  try {
    const mod = await import("openclaw/plugin-sdk/gateway-runtime");
    return await mod.createOperatorApprovalsGatewayClient({ config: cfg });
  } catch {
    return null; // 老版本，静默降级
  }
}
```
