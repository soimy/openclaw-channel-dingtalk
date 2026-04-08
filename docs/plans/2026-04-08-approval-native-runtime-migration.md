# DingTalk Approval 迁移到 ChannelApprovalNativeRuntimeAdapter

日期：2026-04-08
分支：`feat/approval-v2`
依赖：openclaw `>=2026.4.7`（PR #62135），DingTalk card v2（PR #480，未 merge）

## 背景

OpenClaw v2026.4.7（PR #62135）把 native approval lifecycle 从 core 搬到 channel capability，引入
`ChannelApprovalNativeRuntimeAdapter`（5 个 sub-adapter：availability / presentation / transport /
interaction / observe）。Discord / Matrix / Slack / Telegram 已全部迁移。DingTalk 当前 `feat/approval-v2`
还在用 legacy `approvals.render.exec/plugin.buildPendingPayload` + 自写 `approvalCardStore`。

Approval 功能在 DingTalk 是**从 0 到 1**，没有历史包袱，直接一步到位迁 nativeRuntime，和其他 channel 对齐。

## 核心收益

1. **删 store**：core 内存里管 `activeEntries`，`deliverPending` 返回的 entry 会自动带回 `updateEntry`/`deleteEntry`。不再需要 `approvalCardStore`。
2. **删 bypass-via-command-dispatch**：卡片按钮回调直接调 `resolveApprovalOverGateway({ cfg, approvalId, decision })`，不再绕 `/approve` 文本命令。
3. **删 channelData hack**：`sendPayload` 里 `_dingtalkApproval` 路由整块删除，`transport.deliverPending` 直接调 DingTalk API，不过 `dispatchReply`。
4. **和其他 channel 对齐**：framework 统一，后续 core 改动不需要 DingTalk 单独跟。
5. **`/approve` 文本命令简化**：同样改为直接调 `resolveApprovalOverGateway`，`src/command/card-approve-command.ts` 整个文件删除。

## 调用流（关键理解）

**卡片发送**：core → `nativeRuntime.transport.deliverPending(...)` → 我们直接调 DingTalk API。**不过 `sendPayload` / `dispatchReply`**，所以和 session lock 无关。

**卡片解决（按钮点击）**：
```
DingTalk 卡片按钮点击 → TOPIC_CARD callback → card-callback-service 解析 cardPrivateData
  → resolveApprovalOverGateway({ cfg, approvalId, decision, senderId })
  → core 的 exec.approval.resolve gateway method
  → core 从 activeEntries 取出 entry → transport.updateEntry / deleteEntry 更新卡片 UI
```

**`/approve` 文本命令**（仅作为 Plugin Approval 的备用入口）：
```
inbound-handler 早期 intercept (在 acquireSessionLock 之前)
  → 解析 /approve <id> <decision>
  → resolveApprovalOverGateway(...)
```
绕过 session lock 死锁的关键是**早期 intercept + 直接 resolve**，不经过 session lock、不经过 dispatchReply。

## 文件改动清单

### 新建

- `src/approval/approval-native-adapter.ts` — 实现 5 个 sub-adapter
  - `availability`: `isConfigured` / `shouldHandle`
  - `presentation`: `buildPendingPayload` / `buildResolvedResult` / `buildExpiredResult`
  - `transport`: `prepareTarget` / `deliverPending` / `updateEntry` / `deleteEntry`
  - `interaction`: `clearPendingActions`（可选，用于解决后清按钮）
  - `observe`: `onDelivered` / `onDeliveryError`（日志）
- `src/approval/approval-capability.ts` — 组装 `ChannelApprovalCapability`，注册到 channel

### 删除

- `src/approval-card-service.ts` 里的 `approvalCardStore` + `handleApprovalCardCallback` + `ApprovalCardEntry` 类型
- `src/command/card-approve-command.ts` — 整个文件
- `src/channel.ts` 里 `approvals.render.exec/plugin.buildPendingPayload` 块
- `src/channel.ts` 里 `sendPayload` 的 `_dingtalkApproval` channelData 路由
- `tests/unit/approval-card-callback.test.ts`
- `tests/unit/card-approve-command.test.ts`（若存在）

### 保留 + 迁移

- `src/approval-message-builder.ts` — text fallback，不变
- `buildExecApprovalCardParamMap` / `buildPluginApprovalCardParamMap` — 迁到 `approval-native-adapter.ts`，被 `presentation.buildPendingPayload` 调用
- `createApprovalCard`（调 DingTalk API 那部分） — 迁到 adapter，被 `transport.deliverPending` 调用
- `updateApprovalCardResolved` — 迁到 adapter，被 `transport.updateEntry` 调用
- 迁完后 `src/approval-card-service.ts` 如果变空就删除

### 改动

- `src/card-callback-service.ts` approval 分支 — 不再调 `handleApprovalCardCallback`，改调 `resolveApprovalOverGateway`
- `src/inbound-handler.ts` `/approve` 文本 intercept — 不再调 command session dispatch，改直接调 `resolveApprovalOverGateway`
- `src/channel.ts` — 用 `approvals.nativeRuntime` 代替 `approvals.render`
- `package.json` — peerDep `>=2026.3.28` → `>=2026.4.7`

## 测试策略

### 新增
- `tests/unit/approval-native-adapter.test.ts`
  - `presentation.buildPendingPayload` 生成正确 CardBtn 参数
  - `transport.deliverPending` 调 DingTalk API 并返回带 `outTrackId` 的 entry
  - `transport.updateEntry` 在 resolved/expired 时更新卡片
  - `availability.shouldHandle` 过滤不匹配的请求

### 改写
- `tests/unit/approval-card-service.test.ts` — 从测 `handleApprovalCardCallback` 改为测迁移后的工具函数
- `tests/unit/inbound-handler.test.ts` `/approve` 3 个测试 — 改 assertion 为"调了 `resolveApprovalOverGateway`"而不是"调了 command session dispatch"

### 删除
- `tests/unit/approval-card-callback.test.ts`
- `tests/unit/card-approve-command.test.ts`（若存在）

### 保留
- `tests/unit/approval-message-builder.test.ts`

## 实施步骤

1. ✅ 写设计文档（此文件）
2. Bump peerDep 到 `>=2026.4.7`，`pnpm install`
3. TDD 写 `approval-native-adapter.ts` 和测试
4. 写 `approval-capability.ts` 组装 capability
5. 接入 `channel.ts`（`approvals.nativeRuntime`）
6. 改 `card-callback-service.ts` approval 分支用 `resolveApprovalOverGateway`
7. 改 `inbound-handler.ts` `/approve` 文本 intercept 用 `resolveApprovalOverGateway`
8. 删 legacy：`approvals.render`、`_dingtalkApproval` 路由、`approvalCardStore`、`handleApprovalCardCallback`、`card-approve-command.ts`
9. 改写 / 删除受影响测试
10. `pnpm test` + `pnpm run type-check` + `pnpm run lint` 全量验证
11. commit（分逻辑 commit：adapter 新建、channel 接入、legacy 清理）
12. PR 预览 → force-push → 等 CI

## 不变项

- `src/approval-message-builder.ts` 文本格式化（text fallback）
- `/approve` 文本命令的**早期 intercept 机制**（只是内部实现改了，入口不变）
- `feat/approval-v2` 分支名和 PR #489

## Breaking change 说明

- peerDep 从 `>=2026.3.28` bump 到 `>=2026.4.7`（已有 PR #497 bump 了 base，此变更延续）
- 对 plugin 用户无 API breaking
