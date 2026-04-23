# Card V2 连续私聊图片请求 sessionKey=- 问题交接文档

**日期**: 2026-04-14  
**分支**: `card-template-v2-clean`  
**问题**: 单聊场景下连续两次请求发送图片，第二次请求无法嵌入到 card 中，而是作为独立消息发送

## 问题现象

用户在单聊中连续两次请求发送图片：
1. 第一次请求：正常创建 card 并嵌入图片
2. 第二次请求：图片作为独立消息发送，未嵌入到已有 card

预期行为：第二次请求应该将图片嵌入到第一次创建的 card 中。

## 根本原因

OpenClaw runtime 在调用 message tool 的 `handleAction` 时传递 `sessionKey=-`，导致：

1. **conversationId 解析失败**：`resolveConversationIdFromSessionKey("-")` 返回 `undefined`
2. **expectedCardOwnerId 缺失**：OpenClaw runtime 不会自动传递 `expectedCardOwnerId` 参数
3. **Registry 查询失败**：`sendMedia` 无法通过 conversation 或 owner 匹配到活跃的 card run

### 日志证据

```log
[2026-04-14 13:19:40.083] Dynamic reaction observed agent event 
  stream=item phase=start runId=0b18580e-bd04-4b62-97a5-54cbdbfa7e9b 
  sessionKey=- toolCallId=call_function_l01j6yub1chp_1 toolName=message
```

所有 message tool 调用的 `sessionKey` 都是 `-`，而不是实际的 session key。

## 已实现修复（已落地，待真机验证）

### 代码变更

1. **新增 `resolveCardRunByOwner` 函数** (`src/card/card-run-registry.ts:131-144`)
   - 仅通过 `accountId` + `ownerUserId` 匹配 card run
   - 返回最近注册的匹配记录

2. **三层查询策略** (`src/send-service.ts:665-688`)
   ```typescript
   if (options.conversationId) {
     // 1. conversationId 可用：owner-filtered → conversation-only
     activeRun = options.expectedCardOwnerId
       ? resolveCardRunByConversation(accountId, options.conversationId, {
           ownerUserId: options.expectedCardOwnerId,
         }) ?? resolveCardRunByConversation(accountId, options.conversationId, undefined)
       : resolveCardRunByConversation(accountId, options.conversationId, undefined);
   } else if (options.expectedCardOwnerId) {
     // 2. conversationId 不可用但有 owner：owner-only fallback
     activeRun = resolveCardRunByOwner(accountId, options.expectedCardOwnerId);
   }
   ```

3. **message tool action 层 fallback** (`src/channel.ts`)
   - `conversationId` 先尝试 `resolveConversationIdFromSessionKey(sessionKey)`，失败时回退到当前 `target`
   - `expectedCardOwnerId` 先读取显式参数，缺失时在 direct target 场景回退到当前 `target`
   - 这样 `sessionKey=-` 或缺失时，单聊 message tool 发图仍可命中当前用户的活跃 card run

4. **测试覆盖**
   - `tests/unit/card-run-registry.test.ts`: 6 个 `resolveCardRunByOwner` 测试
   - `tests/unit/send-service-media-owner-fallback.test.ts`: 3 个 owner-only fallback 场景测试
   - `tests/unit/message-actions.test.ts`: 新增 2 个 action 层回归测试，覆盖 `sessionKey` 缺失/为 `-` 时 direct target fallback
   - 验证结果：
     - `pnpm vitest run tests/unit/message-actions.test.ts --testNamePattern "falls back to direct target|forwards expectedCardOwnerId|forwards current direct conversationId"` 通过
     - `pnpm vitest run tests/unit/send-service-media-owner-fallback.test.ts tests/unit/send-service-media.test.ts` 通过
     - `npm run type-check` 通过

### 为什么这次修复能生效

1. **Inbound 阶段 owner 仍然是正确来源**
   ```typescript
   // src/inbound-handler.ts:866-872
   registerCardRun(aiCard.outTrackId, {
     accountId,
     sessionKey: route.sessionKey,
     agentId: route.agentId,
     ownerUserId: senderId,
     card: aiCard,
   });
   ```

2. **message tool action 层不再依赖 runtime 额外透传 `expectedCardOwnerId`**
   - OpenClaw runtime 当前只稳定透传标准参数和已解析的 `to/accountId`
   - 因此 action 层改为直接利用 `target` 推导 direct 场景的 `conversationId` 与 `expectedCardOwnerId`

3. **与现有 outbound 链路保持一致**
   - `outbound.sendText` / `outbound.sendMedia` 已经把 `to` 作为当前会话 scope 传入发送服务
   - message tool action 现在补齐了这一层行为对齐，不再只依赖 `sessionKey`

## 技术分析

### sessionKey=- 的来源

OpenClaw runtime 在 message tool 调用时传递 `sessionKey=-`，这是 runtime 层面的行为，不是 DingTalk channel 的问题。

### Optimistic Capture 机制

Dynamic ack reaction 使用 optimistic capture 在 `sessionKey=-` 时捕获 `runId`：

```typescript
// src/ack-reaction/dynamic-ack-reaction-events.ts:97-112
if (
  optimisticCaptureCount === 0
  && eventStream === "lifecycle"
  && eventPhase === "start"
  && eventRunId
  && !eventSessionKey  // sessionKey 为空或 "-" 时触发
  && Date.now() - params.createdAt <= params.optimisticCaptureWindowMs
) {
  optimisticCaptureCount += 1;
  activeRunId = eventRunId;
  params.log?.debug?.(
    `[DingTalk] Dynamic reaction optimistically captured active runId=${activeRunId}`
  );
  return true;
}
```

**关键发现**：optimistic capture 只捕获了 `runId`，没有捕获 `ownerUserId`。

### 剩余风险与后续方向

1. **当前 fallback 是“最近 owner 匹配”**
   - `resolveCardRunByOwner(accountId, ownerUserId)` 返回最近注册记录
   - 对“同账号下同一用户同时存在多个活跃卡片”的并发场景仍然不是精确匹配

2. **更长期的精确方案仍可继续推进**
   - 扩展 runtime / optimistic capture，将 `runId` 或 owner 上下文稳定传给 message tool
   - 或为 registry 增加更精确的 run 级查询入口

## 相关文件

### 核心逻辑
- `src/card/card-run-registry.ts` - Card run 注册与查询
- `src/send-service.ts:662-688` - Card 图片嵌入决策点
- `src/channel.ts:242-299` - Message tool handleAction 入口
- `src/inbound-handler.ts:866-872` - Card run 注册点

### Dynamic Ack Reaction
- `src/ack-reaction/dynamic-ack-reaction-events.ts` - Optimistic capture 逻辑
- `src/ack-reaction/dynamic-ack-reaction-controller.ts` - Reaction 控制器

### 测试
- `tests/unit/card-run-registry.test.ts` - Registry 查询测试
- `tests/unit/send-service-media-owner-fallback.test.ts` - Owner-only fallback 测试
- `tests/unit/send-service-media.test.ts` - SendMedia 集成测试

## Git 状态

```
Current branch: card-template-v2-clean
Modified files:
  M src/card-service.ts
  M src/card/card-template.ts
  M src/channel.ts
  M src/inbound-handler.ts
  M src/reply-strategy-card.ts
  M src/send-service.ts
  M tests/unit/card-service.test.ts
  M tests/unit/inbound-handler-card.test.ts
  M tests/unit/message-actions.test.ts
  M tests/unit/reply-strategy-card.test.ts
  M tests/unit/send-service-media.test.ts

Recent commits:
  92a36ee fix(card): reroute local markdown images and refresh task info
  1c032bb merge: sync main branch changes
```

## 下一步建议

1. **执行真机验证**
   - 场景：单聊连续两次请求发送图片
   - 预期：第二次图片继续嵌入已有 card，而不是掉到独立主动消息

2. **观察关键日志**
   - action 层传入 `conversationId` / `expectedCardOwnerId`
   - `sendMedia` 是否命中 owner-only 或 direct target fallback
   - 是否出现 `Active card matched but controller was not attached in time`

3. **若真机仍失败，再看更深层信号**
   - 是否是 controller attach 时序问题
   - 是否是模型没有真正发出 media 指令
   - 是否需要继续推进 runId 级别精确匹配

## 参考

- OpenClaw 版本：2026.4.5（本地）
- 最新稳定版：2026.4.12
- Issue: 连续私聊图片请求第二次失败
- 相关 PR: #507 (chatRecord summary), #505/#506 (media filename)
