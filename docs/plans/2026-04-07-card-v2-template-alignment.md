# Card V2 模板对齐设计方案

**日期：** 2026-04-07
**状态：** 已完成
**关联：** PR #480, `docs/assets/card-data-mock-v2.json`, `docs/assets/card-template-v2.json`

---

## 变更概览

| 变更项 | 旧版本 | 新版本 | 影响 |
|--------|--------|--------|------|
| `hasQuote` 变量 | 显式设置 `"true"/"false"` | **移除** | quoteContent 块由值是否为空决定显示 |
| `taskInfo.agent` | 无 | **新增** | 显示当前会话对应的 agent 名称 |
| `hasAction` | 使用 `stop_action` 变量 | **新增** | 控制 Stop Button 显示 |

---

## Mock 数据对比

### 旧版本 (当前代码)

```json
{
  "hasQuote": "true",
  "quoteContent": "用户消息",
  "stop_action": "true",
  "taskInfo": {
    "model": "gpt-5.4",
    "effort": "medium",
    "dapi_usage": 12,
    "taskTime": 24
  }
}
```

### 新版本 (V2 模板)

```json
{
  "hasAction": true,
  "content": "# 流式富文本内容",
  "quoteContent": "这是一条测试引用文本",
  "taskInfo": {
    "model": "gpt-5.4",
    "effort": "medium",
    "dapi_usage": 12,
    "taskTime": 24,
    "agent": "main"
  },
  "version": 1
}
```

---

## 问题分析

### Issue 1: hasQuote 变量已废弃

**当前代码 (`src/card-service.ts:730-736`):**

```typescript
const cardParamMap = {
  config: JSON.stringify({ autoLayout: true, enableForward: true }),
  [template.streamingKey]: "",
  hasQuote: String(Boolean(options.hasQuote)),  // ← 需移除
  quoteContent: options.quoteContent || "",
  stop_action: STOP_ACTION_VISIBLE,
};
```

**问题：** V2 模板不再使用 `hasQuote` 变量，quoteContent 块的显示由模板自动判断 `quoteContent` 值是否为空。

**影响：**
- 保留 `hasQuote` 变量不会报错（模板忽略未知变量）
- 但属于冗余代码，应清理

---

### Issue 2: taskInfo 缺少 agent 属性

**当前代码 (`src/reply-strategy-card.ts:473-482`):**

```typescript
if (ctx.taskMeta) {
  const info: Record<string, unknown> = {};
  if (ctx.taskMeta.model) { info.model = ctx.taskMeta.model; }
  if (ctx.taskMeta.effort) { info.effort = ctx.taskMeta.effort; }
  if (typeof ctx.taskMeta.usage === "number") { info.dapi_usage = ctx.taskMeta.usage; }
  if (typeof ctx.taskMeta.elapsedMs === "number") { info.taskTime = Math.round(ctx.taskMeta.elapsedMs / 1000); }
  // ← 缺少 agent 属性
}
```

**问题：** V2 模板 `taskInfo` 要求包含 `agent` 字段，用于显示当前会话对应的 agent 名称。

**数据来源：**
- `ReplyStrategyContext.sessionAgentId` 或 `CardRunRecord.agentId`
- 从 `inbound-handler.ts` 的 route 解析结果获取

---

### Issue 3: hasAction 变量未设置

**当前代码：**
- 创建时设置 `stop_action: STOP_ACTION_VISIBLE`
- Finalize 时设置 `flowStatus: 3` 自动隐藏 Stop Button

**V2 模板要求：**
- `hasAction: true` 显示 Stop Button
- 需要确认 `hasAction` 与 `stop_action` 的关系

**分析：**
- `stop_action` 是旧版变量，控制 Stop Button 的显示状态
- `hasAction` 是新版变量，功能类似
- 需要确认模板使用哪个变量名

---

## 设计方案

### Task 1: 移除 hasQuote 变量

**文件：** `src/card-service.ts`

**Step 1:** 移除 `CreateAICardOptions` 接口中的 `hasQuote` 字段

```typescript
// src/card-service.ts:328-329
export interface CreateAICardOptions {
  storePath?: string;
  contextConversationId?: string;
  accountId?: string;
  // hasQuote?: boolean;  // ← 移除
  quoteContent?: string;
}
```

**Step 2:** 移除 `createAICard` 中的 `hasQuote` 设置

```typescript
// src/card-service.ts:730-736
const cardParamMap = {
  config: JSON.stringify({ autoLayout: true, enableForward: true }),
  [template.streamingKey]: "",
  // hasQuote: String(Boolean(options.hasQuote)),  // ← 移除
  quoteContent: options.quoteContent || "",
  stop_action: STOP_ACTION_VISIBLE,
};
```

**Step 3:** 移除 `inbound-handler.ts` 中的 `hasQuote` 传参

```typescript
// src/inbound-handler.ts:739-745
const aiCard = await createAICard(dingtalkConfig, to, log, {
  accountId,
  storePath: accountStorePath,
  contextConversationId: groupId,
  // hasQuote: inboundQuoteText.length > 0,  // ← 移除
  quoteContent: inboundQuoteText,
});
```

**Step 4:** 更新测试

移除测试中对 `hasQuote` 的断言。

---

### Task 2: taskInfo 新增 agent 属性

**文件：** `src/reply-strategy.ts`, `src/reply-strategy-card.ts`, `src/inbound-handler.ts`

**Step 1:** 扩展 `TaskMeta` 接口

```typescript
// src/reply-strategy.ts
export interface TaskMeta {
  model?: string;
  effort?: string;
  usage?: number;
  elapsedMs?: number;
  agent?: string;  // ← 新增
}
```

**Step 2:** 在 `reply-strategy-card.ts` 中添加 agent 到 taskInfo

```typescript
// src/reply-strategy-card.ts:473-482
if (ctx.taskMeta) {
  const info: Record<string, unknown> = {};
  if (ctx.taskMeta.model) { info.model = ctx.taskMeta.model; }
  if (ctx.taskMeta.effort) { info.effort = ctx.taskMeta.effort; }
  if (typeof ctx.taskMeta.usage === "number") { info.dapi_usage = ctx.taskMeta.usage; }
  if (typeof ctx.taskMeta.elapsedMs === "number") { info.taskTime = Math.round(ctx.taskMeta.elapsedMs / 1000); }
  if (ctx.taskMeta.agent) { info.agent = ctx.taskMeta.agent; }  // ← 新增
  if (Object.keys(info).length > 0) {
    taskInfoJson = JSON.stringify(info);
  }
}
```

**Step 3:** 在 `inbound-handler.ts` 中传递 agent 名称

**Agent 名称获取优先级：**

| 优先级 | 来源 | 场景 | 说明 |
|--------|------|------|------|
| 1 | `subAgentOptions.matchedName` | 子 agent @mention | 用户友好名称，如 "代码专家" |
| 2 | `cfg.agents.list.find(a => a.id === route.agentId)?.name` | 默认 agent | 从配置查找名称 |
| 3 | `route.agentId` | Fallback | 技术标识符 |

**实现方案：**

```typescript
// src/inbound-handler.ts - 创建 strategy context 时

// 获取 agent 显示名称
function getAgentDisplayName(params: {
  subAgentOptions?: { matchedName?: string };
  agentId: string;
  agentsList?: Array<{ id: string; name?: string }>;
}): string {
  // 优先级 1: 子 agent 的 matchedName
  if (params.subAgentOptions?.matchedName) {
    return params.subAgentOptions.matchedName;
  }
  // 优先级 2: 从 agents.list 查找
  if (params.agentsList) {
    const agent = params.agentsList.find(a => a.id === params.agentId);
    if (agent?.name) {
      return agent.name;
    }
  }
  // 优先级 3: fallback 到 agentId
  return params.agentId;
}

// 创建 strategy context 时
const agentDisplayName = getAgentDisplayName({
  subAgentOptions,
  agentId: route.agentId,
  agentsList: cfg.agents?.list,
});

const strategy = createCardReplyStrategy({
  // ... existing fields
  taskMeta: {
    model: /* from agent runtime */,
    effort: /* from agent runtime */,
    usage: /* from agent runtime */,
    elapsedMs: /* from agent runtime */,
    agent: agentDisplayName,  // ← 新增
  },
});
```

**Step 4:** 更新测试

```typescript
// tests/unit/reply-strategy-card.test.ts
it("includes agent in taskInfoJson", async () => {
  const ctx = buildCtx(card, {
    taskMeta: {
      model: "gpt-5.4",
      agent: "assistant",
    },
  });
  // ...
  expect(taskInfo.agent).toBe("assistant");
});
```

---

### Task 3: hasAction 替代 stop_action

**已确认：** V2 模板使用 `hasAction: Boolean` 控制 Stop Button 显示。

**当前实现：**
```typescript
// src/card/card-template.ts
export const STOP_ACTION_VISIBLE = "true";
export const STOP_ACTION_HIDDEN = "false";

// src/card-service.ts:735
stop_action: STOP_ACTION_VISIBLE,
```

**V2 模板期望：**
```json
{
  "hasAction": true
}
```

**修改方案：**

**Step 1: 更新 card-template.ts**

```typescript
/** Card variable value that shows the stop button. */
export const STOP_ACTION_VISIBLE = true;
/** Card variable value that hides the stop button. */
export const STOP_ACTION_HIDDEN = false;
```

**Step 2: 更新 card-service.ts 创建时**

```typescript
// src/card-service.ts:730-736
const cardParamMap = {
  config: JSON.stringify({ autoLayout: true, enableForward: true }),
  [template.streamingKey]: "",
  quoteContent: options.quoteContent || "",
  hasAction: true,  // 替代 stop_action
};
```

**Step 3: 更新 hideCardStopButton**

```typescript
// src/card-service.ts:56
await updateCardVariables(outTrackId, { hasAction: false }, token, config);
```

**兼容性考虑：** 如果需要同时支持 V1 和 V2 模板，可以同时设置两个变量：

```typescript
const cardParamMap = {
  config: JSON.stringify({ autoLayout: true, enableForward: true }),
  [template.streamingKey]: "",
  quoteContent: options.quoteContent || "",
  // V1 兼容 (字符串)
  stop_action: "true",
  // V2 支持 (布尔)
  hasAction: true,
};
```

---

## 实施顺序

1. **Task 1: 移除 hasQuote** (简单清理，低风险)
   - 修改 `card-service.ts` - 移除接口字段和 cardParamMap 设置
   - 修改 `inbound-handler.ts` - 移除传参
   - 更新测试

2. **Task 2: taskInfo.agent** (功能增强)
   - 扩展 `TaskMeta` 接口
   - 创建 `getAgentDisplayName` 辅助函数
   - 修改 `reply-strategy-card.ts` - 添加 agent 到 taskInfo
   - 修改 `inbound-handler.ts` - 传入 agent 显示名称
   - 更新测试

3. **Task 3: hasAction 替代 stop_action**
   - 修改 `card/card-template.ts` - 常量值改为 boolean
   - 修改 `card-service.ts` - 替换变量名和值类型
   - 真机验证 Stop Button 功能

---

## 测试验证清单

- [ ] Task 1: `hasQuote` 移除后所有测试通过
- [ ] Task 2: 子 agent 场景 `taskInfo.agent` 显示 matchedName
- [ ] Task 2: 默认 agent 场景 `taskInfo.agent` 显示配置名称或 ID
- [ ] Task 3: `hasAction` 正确控制 Stop Button 显示
- [ ] Task 3: Stop Button 点击后卡片正确停止
- [ ] 所有单元测试通过 (`pnpm test`)
- [ ] TypeScript 类型检查通过 (`pnpm run type-check`)
- [ ] 真机测试验证卡片渲染正确

---

## 相关文档

- `docs/assets/card-data-mock-v2.json` - V2 卡片数据 Mock
- `docs/assets/card-template-v2.json` - V2 卡片模板
- `docs/plans/2026-04-06-card-v2-real-device-fixes.md` - 真机测试修复计划
- `src/targeting/agent-routing.ts` - Sub-agent 路由实现
- `src/targeting/agent-name-matcher.ts` - Agent 名称匹配逻辑