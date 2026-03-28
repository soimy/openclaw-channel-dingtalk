# AICard 动态按钮与 Stream 回调实施方案

日期：2026-03-13

## 1. 背景

当前仓库已经具备 AICard 的基础能力：

- 通过 `/v1.0/card/instances/createAndDeliver` 创建并投放卡片。
- 创建卡片时已设置 `callbackType: "STREAM"`。
- Stream 网关已监听卡片回调 topic `/v1.0/card/instances/callback`。
- 当前卡片回调仅用于点赞/点踩反馈，尚未支持通用业务按钮。

现状对应代码：

- 卡片创建与投放：[src/card-service.ts](../../src/card-service.ts)
- Stream 卡片回调入口：[src/channel.ts](../../src/channel.ts)
- 卡片回调解析：[src/card-callback-service.ts](../../src/card-callback-service.ts)
- 现有 AI 卡片模板：[docs/cardTemplate.json](../cardTemplate.json)

本方案目标是在现有 AICard 能力之上，增加“动态按钮 + Stream 回调 + 会话内动作处理”的完整闭环。

## 2. 官方约束与结论

基于钉钉官方文档，落地时应遵循以下约束：

- 创建并投放卡片接口支持 `callbackType`，可选 `STREAM` 或 `HTTP`。
- 本仓库当前定位是 Stream 模式接入，因此按钮互动继续走 `STREAM`，不需要 HTTP 回调地址注册。
- 卡片按钮点击后的回调请求中，按钮信息位于 `content.cardPrivateData.actionIds` 和 `content.cardPrivateData.params`。
- 回调响应可以直接返回 `cardData`、`userPrivateData`、`cardUpdateOptions`，用于即时更新卡片。
- 事件回调有超时限制，应在 2 秒内完成响应。
- 官方文档明确建议：不要在回调处理中直接调用更新接口做同步业务处理。

对本仓库的直接结论：

- V1 应以“回调快速响应 + 异步业务执行”为主。
- V1 不建议在按钮点击后继续对同一张已完成卡片做复杂流式更新。
- V1 更稳妥的策略是“旧卡反馈点击状态，新卡承载后续回答”。

## 3. 需求定义

### 3.1 目标能力

新增 AICard 动态动作区，支持服务端按会话上下文生成按钮，并在用户点击后通过 Stream 回调触发业务逻辑。

### 3.2 功能范围

V1 支持以下能力：

- 在 AICard 完成态展示最多 3 个动态按钮。
- 每个按钮支持独立的文案、风格、动作 ID、参数和启用状态。
- 用户点击按钮后，插件通过 Stream 回调获取按钮动作和参数。
- 插件在 2 秒内响应回调，并即时更新卡片上的动作状态文案。
- 对于会话类动作，插件将按钮点击转化为同一会话中的“后续指令”。
- 插件产出新的回复消息或新卡片，而不是强依赖旧卡片继续流式输出。

### 3.3 非目标

V1 不做以下能力：

- 不做无限数量的动态按钮渲染。
- 不做复杂表单提交、多步骤事件链编排。
- 不做回调期间直接同步调用卡片更新接口。
- 不做“任意旧卡回调后恢复原卡流式生成”的复杂状态机。

## 4. 用户故事

### 4.1 继续追问

- 用户收到一张 AI 回复卡片。
- 卡片底部显示“继续展开”“总结为要点”“重新回答”按钮。
- 用户点击“继续展开”。
- 插件收到 Stream 回调，将动作转成同一会话内的追问。
- 插件回一张新卡片继续输出。

### 4.2 轻量确认动作

- 卡片上展示“已阅”“采纳建议”之类按钮。
- 用户点击后，插件仅记录事件，并在卡片上标记“已处理”。

### 4.3 权限控制

- 某些按钮仅允许原提问者点击。
- 非原提问者点击时，卡片显示无权限或忽略处理。

## 5. 交互设计

### 5.1 按钮展示策略

V1 使用固定 3 槽位按钮，而不是动态数组：

- `primary`
- `secondary`
- `tertiary`

选择固定槽位的原因：

- 与当前模板体系最兼容。
- 调试成本低。
- 足够覆盖“继续 / 重试 / 总结”等常见场景。
- 后续如果需要更多按钮，再升级为数组驱动模板。

### 5.2 推荐默认按钮

建议 V1 提供以下默认动作：

- `continue`: 继续上一个回答
- `retry`: 换一种方式重新回答
- `summary`: 将上一个回答整理为要点

### 5.3 按钮点击后的 UI 反馈

回调即时更新的内容建议包括：

- `action_status_text = 已触发：继续展开`
- 当前点击按钮临时置灰或隐藏
- 需要时写入当前用户私有状态，避免重复点击

## 6. 模板方案

### 6.1 模板改造位置

基于 [docs/cardTemplate.json](../cardTemplate.json) 现有完成态操作区扩展：

- 保留当前 `Feedback` 组件。
- 在 `Feedback` 的 `customRightArea` 或其下方增加 3 个按钮槽位。
- 让按钮仅在卡片完成态显示。

### 6.2 新增模板变量

建议新增以下卡片公共变量：

- `action_primary_text`
- `action_primary_visible`
- `action_primary_enabled`
- `action_primary_action_id`
- `action_primary_payload_json`
- `action_secondary_text`
- `action_secondary_visible`
- `action_secondary_enabled`
- `action_secondary_action_id`
- `action_secondary_payload_json`
- `action_tertiary_text`
- `action_tertiary_visible`
- `action_tertiary_enabled`
- `action_tertiary_action_id`
- `action_tertiary_payload_json`
- `action_status_text`

如需区分按钮视觉风格，可增加：

- `action_primary_style`
- `action_secondary_style`
- `action_tertiary_style`

### 6.3 按钮事件传参方式

每个按钮的 `onTap` 统一使用 `dtSendOutData`，将业务信息写入 `cardPrivateData`：

```json
{
  "cardPrivateData": {
    "actionIds": ["continue"],
    "params": {
      "slot": "primary",
      "payloadJson": "{\"kind\":\"session_prompt\",\"prompt\":\"继续上一个回答\"}",
      "processQueryKey": "pqk_xxx"
    }
  }
}
```

说明：

- `actionIds[0]` 作为服务端动作主键。
- `params` 作为服务端业务补充参数。
- 复杂对象统一序列化为 JSON 字符串。

## 7. 服务端数据模型

### 7.1 按钮定义

建议新增类型：

```ts
export interface AICardActionButton {
  id: string;
  label: string;
  style?: "primary" | "default" | "danger";
  kind: "ack_only" | "session_prompt";
  prompt?: string;
  params?: Record<string, string | number | boolean>;
  permission?: "sender_only" | "chat_members";
  enabled?: boolean;
}
```

### 7.2 回调上下文

建议新增 `CardActionContext`，并按 `outTrackId` 做持久化索引：

- `outTrackId`
- `accountId`
- `conversationId`
- `sessionKey`
- `routeAgentId`
- `originSenderId`
- `processQueryKey`
- `buttons`
- `createdAt`
- `expiresAt`

设计原因：

- 当前 pending card 记录在卡片完成后会被移除。
- 按钮点击往往发生在卡片已完成后。
- 因此不能依赖“活动卡片缓存”承接回调。

## 8. 代码改造方案

### 8.1 类型定义

建议修改或新增以下内容：

- 在 [src/types.ts](../../src/types.ts) 中新增按钮与回调上下文类型。
- 为卡片回调分析结果新增：
  - `type`
  - `outTrackId`
  - `userId`
  - `params`
  - `slot`

### 8.2 卡片创建链路

建议扩展 [src/card-service.ts](../../src/card-service.ts)：

- `createAICard()` 支持接收动态按钮定义。
- 创建卡片时将按钮变量写入 `cardParamMap`。
- 创建成功后持久化 `CardActionContext`。

建议新增辅助函数：

- `buildCardActionParamMap(buttons)`
- `persistCardActionContext(context)`
- `getCardActionContext(outTrackId)`
- `deleteExpiredCardActionContexts()`

### 8.3 卡片回调解析

扩展 [src/card-callback-service.ts](../../src/card-callback-service.ts)：

- 继续兼容现有点赞/点踩逻辑。
- 新增对通用按钮动作的解析。
- 优先从 `content` 和 `value` 中解析 `cardPrivateData.actionIds`。
- 解析 `cardPrivateData.params.payloadJson`。
- 读取 `outTrackId` 和 `userId`。

### 8.4 网关回调处理

扩展 [src/channel.ts](../../src/channel.ts) 的 `TOPIC_CARD` 处理逻辑：

- 根据 `outTrackId` 查找 `CardActionContext`。
- 校验按钮动作是否存在。
- 校验点击用户是否有权限执行该动作。
- 在 2 秒内调用 `socketCallBackResponse(messageId, response)` 返回卡片更新响应。
- 对于耗时动作，将实际业务处理放到异步任务中执行。

V1 的回调响应建议如下：

```json
{
  "cardData": {
    "cardParamMap": {
      "action_status_text": "处理中..."
    }
  },
  "userPrivateData": {
    "cardParamMap": {
      "last_clicked_action": "continue"
    }
  },
  "cardUpdateOptions": {
    "updateCardDataByKey": true,
    "updatePrivateDataByKey": true
  }
}
```

### 8.5 异步动作执行

定义两种动作类型：

- `ack_only`
- `session_prompt`

处理规则：

- `ack_only`: 仅写审计日志、学习记录或业务状态。
- `session_prompt`: 将按钮动作转为同一会话中的一条“合成用户输入”。

`session_prompt` 的推荐策略：

- 基于持久化的 `sessionKey` 复用原会话。
- 构造新的入站上下文，触发同一会话下的后续回答。
- 使用新的消息或新卡片输出结果。
- 不强依赖原已完成卡片继续 stream。

## 9. 分阶段实施

### Phase 1：模板与基础回调

目标：

- 模板完成 3 槽位按钮改造。
- 服务端能够识别通用按钮点击。
- 回调可即时更新卡片状态文案。

交付：

- 模板变量定义完成。
- `CardActionContext` 持久化完成。
- `TOPIC_CARD` 支持通用 `actionId` 路由。

### Phase 2：会话动作

目标：

- `session_prompt` 能复用原会话。
- 点击按钮后触发新的后续回答。

交付：

- 新增按钮动作到会话的转换逻辑。
- 新回复稳定产出到相同会话。

### Phase 3：增强能力

可选增强：

- 动态数组按钮
- 多步骤事件链
- 表单输入类卡片动作
- 更细粒度的按钮状态管理
- 指标埋点与动作审计面板

## 10. 验收标准

### 10.1 功能验收

- AICard 完成态可按服务端配置显示按钮。
- 用户点击按钮后 2 秒内卡片有可见反馈。
- 插件日志中能拿到 `outTrackId`、`userId`、`actionId`、`params`。
- `session_prompt` 动作可在原会话里产生新的回答。
- 非法 `actionId` 不会触发业务逻辑。
- 非授权用户点击受限按钮时不会触发动作。

### 10.2 稳定性验收

- 回调快速响应，不因大模型调用而阻塞。
- 回调重复投递不会导致重复执行关键动作。
- 卡片上下文过期后能安全拒绝处理。
- 回调异常不会影响 Stream 主连接稳定性。

## 11. 测试方案

### 11.1 单元测试

新增测试覆盖：

- 通用按钮 `actionId` 提取
- `params` 解析
- `outTrackId` 提取
- 权限校验
- 非法 payload 降级处理

### 11.2 集成测试

新增测试覆盖：

- `TOPIC_CARD` 回调后返回卡片 response
- `socketCallBackResponse(messageId, { response: ... })` 被正确调用
- `session_prompt` 能触发会话后续消息
- 已完成卡片点击后仍可触发新业务流程

## 12. 风险与应对

### 12.1 风险：旧卡片状态机与新回复冲突

应对：

- 不在 V1 中强行继续更新已完成卡片的流式正文。
- 旧卡片仅负责显示点击结果或处理中状态。
- 新回复使用新消息或新卡片输出。

### 12.2 风险：按钮参数结构不稳定

应对：

- 服务端统一以 `cardPrivateData.actionIds[0]` 为动作主键。
- 复杂参数仅从 `cardPrivateData.params.payloadJson` 中读取。
- 对所有回调 payload 做宽松解析与结构化日志。

### 12.3 风险：回调超时

应对：

- 回调逻辑分成“快速响应”和“异步执行”两段。
- 所有耗时业务放到响应之后执行。

## 13. 建议的文件改动清单

建议涉及以下文件：

- [docs/cardTemplate.json](../cardTemplate.json)
- [src/types.ts](../../src/types.ts)
- [src/card-service.ts](../../src/card-service.ts)
- [src/card-callback-service.ts](../../src/card-callback-service.ts)
- [src/channel.ts](../../src/channel.ts)

可能新增的文件：

- `src/card-action-store.ts`
- `tests/unit/card-action-store.test.ts`
- `tests/unit/card-callback-service-advanced.test.ts`
- `tests/integration/card-action-callback-flow.test.ts`

## 14. 推荐的首批实现范围

建议第一批只做以下内容：

- 模板增加 3 个动态按钮槽位。
- 服务端保存 `outTrackId -> CardActionContext`。
- 回调支持解析 `actionId`、`params`、`outTrackId`。
- 回调响应更新 `action_status_text`。
- 实现 `continue`、`retry`、`summary` 三个 `session_prompt` 动作。

这个范围最小、闭环完整、风险可控，适合作为第一版上线能力。

## 15. 参考文档

- [创建并投放卡片](https://open.dingtalk.com/document/development/create-and-deliver-cards)
- [事件回调](https://open.dingtalk.com/document/development/event-callback-card)
- [API 卡片数据的填写说明](https://open.dingtalk.com/document/development/instructions-for-filling-in-api-card-data)
- [注册卡片回调地址](https://open.dingtalk.com/document/development/register-card-callback-address)
