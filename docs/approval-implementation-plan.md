# DingTalk Approval 功能实现方案

> 基于 approval-feature-research.md 的设计决策
> 日期：2026-03-30

## 1. 功能范围

为 DingTalk channel 实现 OpenClaw `requireApproval` 审批能力：
- 支持 `ExecApprovalRequest`（Bash 命令审批）
- 支持 `PluginApprovalRequest`（plugin hook 触发的任意 tool 审批，包括 Bash）
- `/approve` 命令由 OpenClaw native 处理，DingTalk 无需实现
- 第一期：`execApprovals` adapter（文字通知），DingTalk 作为纯展示层
- 第二期：互动卡片按钮交互
- 兼容老版本 OpenClaw（graceful degradation）

**设计原则：DingTalk 是纯展示层（delivery surface），不生成审批请求。**
- 生成审批：由 exec approval 系统（OpenClaw 内置）或 Sage 等安全 plugin 负责
- DingTalk 职责：实现 `execApprovals` adapter，把审批请求格式化后发给用户

---

## 2. 架构设计

### 分层原则

```
UI 层（可替换）                  核心层（共用）
─────────────────────            ──────────────────────────
/approve 命令解析                ApprovalService
  ↓                                ├── resolve(id, decision)         ← 唯一 gateway 回传入口
TOPIC_CARD 卡片回调解析（二期）    ├── buildPluginPendingText()      ← PluginApproval
  ↓                                ├── buildExecPendingPayload()     ← ExecApproval
                                   └── buildPendingCard()（二期）
           ↘            ↙
          ApprovalService.resolve()
```

**核心原则**：两种 UI 路径最终都调用同一个 `resolve()`。`execApprovals` adapter 的 `buildPluginPendingPayload` 只决定"发什么消息"，不包含任何 decision 逻辑。

### 模块职责

| 模块 | 职责 |
|---|---|
| `src/approval-service.ts`（新建） | 核心：gateway client 管理、resolve 调用、pending text/card 构建 |
| `src/channel.ts` | 在 `dingtalkPlugin` 增加 `execApprovals` adapter；在 `TOPIC_CARD` 回调加审批分支（二期） |
| `index.ts` | `registerFull` 中注册 `before_tool_call` hook |
| `src/card-callback-service.ts` | 增加识别审批回调的逻辑（二期） |

> `src/inbound-handler.ts` 不需要改动——`/approve` 由 OpenClaw native command 系统处理，消息不会到达 inbound pipeline。

---

## 3. 工具拦截配置设计（供参考，非 Phase 1 实现范围）

> **Phase 1 不实现 `before_tool_call` hook。** DingTalk 是纯展示层，不生成审批请求。

如需 DingTalk 用户对 Edit/Write 等 tool 也有审批能力，有两条路：
1. 安装 Sage（`@gendigital/sage-openclaw`）等安全 plugin，由它触发 `requireApproval`
2. 未来：独立的 `@soimy/dingtalk-approval` companion plugin（`registerPlugin` 方式注册，只拦截 DingTalk session）

`before_tool_call` 放在 DingTalk channel plugin 里不合适——`ChannelPlugin` 类型没有此 hook 注册入口，且职责混淆。

配合 OpenClaw 顶层配置：

```yaml
approvals:
  exec:
    enabled: true    # Bash 审批（需配合 elevated 或 tools.exec.host）
  plugin:
    enabled: true    # Plugin approval 转发到 channel（Phase 1 需配置）
    mode: session    # 路由到发起会话的 channel（DingTalk）
```

---

## 4. 消息构建（Phase 1）

Phase 1 只需两个纯函数，放在 `src/approval-message-builder.ts`：

```typescript
// Exec approval 格式化文本
export function buildExecApprovalText(
  request: ExecApprovalRequest,
  nowMs: number,
): string {
  const expiresInSec = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  const lines = [
    "🔒 需要审批",
    "",
    `命令: ${request.request.command}`,
  ];
  if (request.request.cwd) lines.push(`目录: ${request.request.cwd}`);
  if (request.request.agentId) lines.push(`Agent: ${request.request.agentId}`);
  lines.push(`过期时间: ${expiresInSec}秒`);
  lines.push("");
  lines.push("回复 `/approve allow-once` 或 `/approve allow-always` 允许，`/approve deny` 拒绝");
  return lines.join("\n");
}

// Plugin approval 格式化文本
export function buildPluginApprovalText(
  request: PluginApprovalRequest,
  nowMs: number,
): string {
  const expiresInSec = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  const severityIcon = request.request.severity === "critical" ? "🚨" : "⚠️";
  const lines = [
    `${severityIcon} 需要审批 — ${request.request.title}`,
    "",
    request.request.description,
  ];
  if (request.request.toolName) lines.push(`工具: ${request.request.toolName}`);
  if (request.request.pluginId) lines.push(`Plugin: ${request.request.pluginId}`);
  if (request.request.agentId) lines.push(`Agent: ${request.request.agentId}`);
  lines.push(`过期时间: ${expiresInSec}秒`);
  lines.push("");
  lines.push("回复 `/approve allow-once` 或 `/approve allow-always` 允许，`/approve deny` 拒绝");
  return lines.join("\n");
}
```

---

## 5. execApprovals Adapter

在 `src/channel.ts` 的 `dingtalkPlugin` 中增加：

```typescript
execApprovals: {
  getInitiatingSurfaceState: ({ cfg, accountId }) => {
    // 检查 config 中是否有 approvals 相关配置
    return { kind: "enabled" };
  },

  // Bash 审批（ExecApproval）：SDK helper 直接返回 ReplyPayload
  buildPendingPayload: ({ cfg, request, target, nowMs }) => {
    return approvalService.buildExecPendingPayload(request, nowMs);
    // 二期：可在 payload 上追加卡片按钮
  },
  buildResolvedPayload: ({ cfg, resolved, target }) => {
    return { text: approvalService.buildResolvedText(resolved) };
  },

  // Plugin hook 审批（PluginApproval）：SDK helper 返回 string，包装为 ReplyPayload
  buildPluginPendingPayload: ({ cfg, request, target, nowMs }) => {
    return { text: approvalService.buildPluginPendingText(request, nowMs) };
    // 二期改为：return approvalService.buildPluginPendingCard(request, nowMs);
  },
  buildPluginResolvedPayload: ({ cfg, resolved, target }) => {
    return { text: approvalService.buildResolvedText(resolved) };
  },
},
```

---

## 6. /approve 命令

**无需 DingTalk 实现。** OpenClaw native command 系统在接收到任何 channel 的消息后，先经过命令识别层，`/approve` 会被直接处理并调用内部 resolve 逻辑，不会流入 inbound pipeline。

DingTalk 用户直接发 `/approve <id> allow-once` 即可，和其他 channel 行为一致。

---

## 7. 卡片按钮交互（二期）

### 卡片设计

```
┌─────────────────────────────────────────────────┐
│  🔐 工具执行需要授权                              │
│                                                   │
│  工具：[toolName]                                 │
│  操作：[title]                                    │
│  详情：[description]                              │
│  过期：[expiresAt 格式化]                         │
│                                                   │
│  [ ✅ 允许一次 ] [ 🔒 永久允许 ] [ ❌ 拒绝 ]     │
└─────────────────────────────────────────────────┘
```

### 卡片回调路由

在 `channel.ts` 的 `TOPIC_CARD` 回调中增加分支：

```typescript
c.registerCallbackListener(TOPIC_CARD, async (res) => {
  const payload = JSON.parse(res.data);
  const analysis = analyzeCardCallback(payload);

  // 审批回调（二期）
  if (analysis.approvalId && analysis.approvalDecision) {
    await approvalService.resolve(
      analysis.approvalId,
      analysis.approvalDecision,
      analysis.approvalType,
      config,
    );
    // 可选：更新卡片显示为"已审批"状态
    acknowledge();
    return;
  }

  // 现有 feedback 回调逻辑...
});
```

`processQueryKey` 格式（嵌入审批信息）：

```
dingtalk-approval:<type>:<approvalId>:<decision>
例：dingtalk-approval:plugin:abc12345:allow-once
```

---

## 8. 开发顺序

### 第一期（DingTalk 作为展示层）

1. 升级 devDependency：`openclaw@2026.3.28`（获取 `buildPluginPendingPayload` 类型）
2. `src/approval-message-builder.ts` — 消息格式化函数（TDD）
3. `src/channel.ts` — 增加 `execApprovals` adapter（`buildPendingPayload` + `buildPluginPendingPayload`）
4. `~/.openclaw/openclaw.json` — 加 `approvals.plugin.enabled: true`
5. 测试：unit tests

> `/approve` 无需实现，OpenClaw native 处理。
> `before_tool_call` hook 不在 Phase 1 范围——DingTalk 是展示层，不生成审批请求。

### 第二期（卡片按钮，后续）

6. `src/approval-service.ts` — 增加 `buildPendingCard`
7. `src/card-callback-service.ts` — 增加审批回调识别
8. `src/channel.ts` — `TOPIC_CARD` 增加审批路由；`buildPluginPendingPayload` 改返回卡片
9. 测试

---

## 9. 测试要点

- [ ] 老版本 OpenClaw：插件正常加载，无崩溃（`/approve` 由 OpenClaw 自己处理，无需 DingTalk 侧验证）
- [ ] 新版本 OpenClaw，`approvals.plugin.enabled: false`：审批请求不到达 DingTalk
- [ ] 新版本 OpenClaw，`approvals.plugin.enabled: true, mode: session`：审批请求发到发起会话的 DingTalk 群
- [ ] `/approve <id> allow-once` 正确 resolve，tool 执行
- [ ] `/approve <id> deny` 正确 resolve，tool 被拒绝
- [ ] `/approve <id> allow-always` resolve + onResolution 触发 allowlist 写入
- [ ] 超时（`timeoutBehavior: "deny"`）：tool 被拒绝
- [ ] ExecApprovalRequest 和 PluginApprovalRequest 都能正确展示和处理
- [ ] 卡片回调（二期）：三个按钮分别触发正确 decision

---

## 10. 已知未调研项

- [ ] `allow-always` 的 allowlist 持久化：DingTalk plugin 可用的 storage API 是什么？粒度如何？
- [ ] DingTalk 互动卡片 JSON 格式：按钮 action 的具体字段和限制（二期实现前需查）
- [ ] 多 account 场景：同一个 DingTalk channel 有多个 account，`target.accountId` 如何匹配到正确的 DWClient？

---

## 11. 审批机制深度分析（2026-03-31 实测）

### Exec approval vs Plugin approval 挂起机制差异

**实测结论**：
- **Exec approval + `/approve` 文字命令**：✅ 可正常工作
- **Plugin approval（requireApproval）+ `/approve` 文字命令**：❌ 死锁，超时失败

**原因分析**：

| | Exec Approval | Plugin Approval |
|---|---|---|
| 挂起机制 | `exec.approval.request`（non-blocking），agent turn 在 request 后结束 | `plugin.approval.waitDecision` 阻塞直到决定 |
| `dispatchReplyWithBufferedBlockDispatcher` | 在 request 后返回 | 在 waitDecision 返回前一直阻塞 |
| DingTalk session lock | 释放 | 持有（死锁） |
| `/approve` 文字命令 | 能拿到 lock，正常执行 | 排队等 lock，超时失败 |

**代码证据**（`node_modules/openclaw/dist/auth-profiles-B5ypC5S-.js`）：
- Plugin approval 第二阶段：`await callGatewayTool("plugin.approval.waitDecision", ...)` — 真正的阻塞等待
- Exec approval 只有：`callGatewayTool("exec.approval.request", ..., { expectFinal: false })` — 发出请求即返回

### Sage 版本与 requireApproval

- **Sage 0.6.0（当前最新）**：使用 `{ block: true, blockReason: ... }` 立刻阻断，不挂起，无死锁风险
- **Sage 未发布新版本**：PR #55339 演示中 Sage 使用了 `requireApproval`，但该版本尚未发布（gendigital/sage 最新仍是 0.6.0）
- `buildPluginPendingPayload` 为未来 Sage 升级或其他使用 `requireApproval` 的插件准备

### `/approve` 文字命令死锁根本原因

DingTalk inbound-handler 在 `dispatchReplyWithBufferedBlockDispatcher` 外层持有 session lock（`acquireSessionLock`），lock 在整个 agent 处理期间保持。当 agent 因 `requireApproval` 挂起时，lock 仍被持有。用户回复的 `/approve` 消息（走 `TOPIC_ROBOT` 路径）进入同一 session 队列等待 lock 释放 —— 形成死锁，最终触发 120s 超时。

不做 hack 修复原因：在 session lock 前检测 `/approve` 会将 OpenClaw native command 语法耦合进 DingTalk plugin，属于反向依赖。

**根本解决方案：卡片按钮（即最终实现方案）**
卡片按钮点击走 `TOPIC_CARD` 回调路径，完全独立于 `TOPIC_ROBOT` 消息流水线，天然不受 session lock 影响。
