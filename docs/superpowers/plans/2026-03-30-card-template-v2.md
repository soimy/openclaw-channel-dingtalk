# AI Card v2 模板重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AI Card 数据结构从单一 markdown 升级为多 key 结构化数据（blockList、taskInfo、hasQuote 等），使用预置卡片模板。

**Architecture:** 用 `CardBlock[]` 替代 `TimelineEntry[]`，通过 `onModelSelected` callback 采集 model/effort，`SessionState` 管理运行时状态，`streamAICard` 仅推送 `blockList` key。

**Tech Stack:** TypeScript, Vitest, 钉钉 Card Streaming API

---

## Files Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/types.ts` | 修改 | 新增 CardBlock/CardTaskInfo/CardBtn/CardStreamPayload 类型；新增 PRESET_CARD_TEMPLATE_ID 常量；移除 cardTemplateId/cardTemplateKey 配置字段 |
| `src/session-state.ts` | 创建 | SessionState 内存 Map 管理 + helper 方法 |
| `src/card-draft-controller.ts` | 修改 | TimelineEntry → CardBlock；新增 getBlockList() 方法 |
| `src/reply-strategy.ts` | 修改 | ReplyOptions 新增 onModelSelected callback 类型 |
| `src/card-service.ts` | 修改 | 使用 PRESET_CARD_TEMPLATE_ID；createAndDeliver 部署静态参数；streamAICard 推送 blockList；集成 dapiCount |
| `src/reply-strategy-card.ts` | 修改 | 接入 onModelSelected；传递 hasQuote/quoteContent |
| `src/inbound-handler.ts` | 修改 | 初始化 SessionState；记录 taskStartTime |
| `src/config.ts` | 修改 | 移除 cardTemplateId/cardTemplateKey 配置解析 |
| `src/onboarding.ts` | 修改 | 移除卡片模板配置引导步骤 |

---

### Task 1: 新增类型定义

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: 在 types.ts 顶部添加 PRESET_CARD_TEMPLATE_ID 常量**

在 `import` 语句之后，`AckReactionMode` 类型定义之前添加：

```typescript
/**
 * Preset AI Card template ID (unified template, no user configuration needed)
 */
export const PRESET_CARD_TEMPLATE_ID = "301508cd-5ddd-4e86-85f0-6b5312032743.schema";
```

- [ ] **Step 2: 在 types.ts 中添加 CardBlock 类型**

在 `PRESET_CARD_TEMPLATE_ID` 常量之后添加：

```typescript
/**
 * Card block for structured AI Card display
 */
export interface CardBlock {
  /** Block content (currently same as markdown, for future collapsed/expanded states) */
  text: string;
  /** Full block content in markdown format */
  markdown: string;
  /** true = thinking/tool block, false = answer block */
  isTool: boolean;
}
```

- [ ] **Step 3: 在 types.ts 中添加 CardTaskInfo 类型**

在 `CardBlock` 之后添加：

```typescript
/**
 * Task metadata for AI Card display
 */
export interface CardTaskInfo {
  /** Task summary (optional) */
  text?: string;
  /** Model name (from onModelSelected callback) */
  model?: string;
  /** Task duration in seconds (plugin local timing) */
  taskTime?: number;
  /** Thinking chain depth (from onModelSelected callback) */
  effort?: string;
  /** DingTalk API call count (plugin local counter) */
  dapi_usage?: number;
}
```

- [ ] **Step 4: 在 types.ts 中添加 CardBtn 类型**

在 `CardTaskInfo` 之后添加：

```typescript
/**
 * Interactive button for AI Card
 */
export interface CardBtn {
  text: string;
  color: string;
  status: string;
  event: {
    type: "openLink" | "sendCardRequest";
    params: Record<string, unknown>;
  };
}
```

- [ ] **Step 5: 在 types.ts 中添加 CardStreamPayload 类型**

在 `CardBtn` 之后添加：

```typescript
/**
 * Complete payload for AI Card streaming
 */
export interface CardStreamPayload {
  blockList: CardBlock[];
  taskInfo: CardTaskInfo;
  hasAction: boolean;
  content: string;
  hasQuote: boolean;
  quoteContent?: string;
  btns: CardBtn[];
}
```

- [ ] **Step 6: 从 DingTalkConfig 中移除 cardTemplateId 和 cardTemplateKey 字段**

找到 `DingTalkConfig` interface，删除以下两行：

```typescript
  cardTemplateId?: string;
  cardTemplateKey?: string;
```

- [ ] **Step 7: 从 DingTalkChannelConfig interface 中移除相同字段**

找到 `DingTalkChannelConfig` interface，删除以下两行：

```typescript
  cardTemplateId?: string;
  cardTemplateKey?: string;
```

- [ ] **Step 8: 运行类型检查**

Run: `pnpm run type-check`
Expected: No errors (types only, no usage yet)

- [ ] **Step 9: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add CardBlock/CardTaskInfo/CardBtn/CardStreamPayload types and PRESET_CARD_TEMPLATE_ID"
```

---

### Task 2: 创建 SessionState 管理模块

**Files:**
- Create: `src/session-state.ts`
- Create: `tests/unit/session-state.test.ts`

- [ ] **Step 1: 创建 session-state.ts 文件**

```typescript
/**
 * Session state management for AI Card v2.
 *
 * Stores runtime state (model, effort, task timing, API count) in memory.
 * Key format: accountId:conversationId
 */

import type { Logger } from "./types";

export interface SessionState {
  model?: string;
  effort?: string;
  taskStartTime: number;
  dapiCount: number;
}

const sessionStates = new Map<string, SessionState>();

function getSessionKey(accountId: string, conversationId: string): string {
  return `${accountId}:${conversationId}`;
}

export function initSessionState(
  accountId: string,
  conversationId: string,
  log?: Logger,
): SessionState {
  const key = getSessionKey(accountId, conversationId);
  const existing = sessionStates.get(key);
  if (existing) {
    log?.debug?.(`[SessionState] Reusing existing session state for ${key}`);
    return existing;
  }
  const state: SessionState = {
    taskStartTime: Date.now(),
    dapiCount: 0,
  };
  sessionStates.set(key, state);
  log?.debug?.(`[SessionState] Initialized new session state for ${key}`);
  return state;
}

export function getSessionState(
  accountId: string,
  conversationId: string,
): SessionState | undefined {
  return sessionStates.get(getSessionKey(accountId, conversationId));
}

export function updateSessionState(
  accountId: string,
  conversationId: string,
  updates: Partial<Pick<SessionState, "model" | "effort">>,
  log?: Logger,
): void {
  const key = getSessionKey(accountId, conversationId);
  const state = sessionStates.get(key);
  if (!state) {
    log?.debug?.(`[SessionState] Cannot update: no state for ${key}`);
    return;
  }
  if (updates.model !== undefined) {
    state.model = updates.model;
    log?.debug?.(`[SessionState] Updated model to "${updates.model}" for ${key}`);
  }
  if (updates.effort !== undefined) {
    state.effort = updates.effort;
    log?.debug?.(`[SessionState] Updated effort to "${updates.effort}" for ${key}`);
  }
}

export function incrementDapiCount(
  accountId: string,
  conversationId: string,
  log?: Logger,
): number {
  const key = getSessionKey(accountId, conversationId);
  const state = sessionStates.get(key);
  if (!state) {
    log?.debug?.(`[SessionState] Cannot increment dapi: no state for ${key}`);
    return 0;
  }
  state.dapiCount += 1;
  log?.debug?.(`[SessionState] Incremented dapiCount to ${state.dapiCount} for ${key}`);
  return state.dapiCount;
}

export function getTaskTimeSeconds(
  accountId: string,
  conversationId: string,
): number | undefined {
  const state = sessionStates.get(getSessionKey(accountId, conversationId));
  if (!state) {
    return undefined;
  }
  return Math.round((Date.now() - state.taskStartTime) / 1000);
}

export function clearSessionState(accountId: string, conversationId: string): void {
  sessionStates.delete(getSessionKey(accountId, conversationId));
}

export function clearAllSessionStatesForTest(): void {
  sessionStates.clear();
}
```

- [ ] **Step 2: 创建 session-state.test.ts 测试文件**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  clearAllSessionStatesForTest,
  clearSessionState,
  getSessionState,
  getTaskTimeSeconds,
  incrementDapiCount,
  initSessionState,
  updateSessionState,
} from "../../src/session-state";

describe("session-state", () => {
  beforeEach(() => {
    clearAllSessionStatesForTest();
  });

  describe("initSessionState", () => {
    it("creates new session state with defaults", () => {
      const state = initSessionState("account1", "conv1");
      expect(state.taskStartTime).toBeGreaterThan(0);
      expect(state.dapiCount).toBe(0);
      expect(state.model).toBeUndefined();
      expect(state.effort).toBeUndefined();
    });

    it("returns existing state if already initialized", () => {
      const state1 = initSessionState("account1", "conv1");
      state1.model = "gpt-4";
      const state2 = initSessionState("account1", "conv1");
      expect(state2.model).toBe("gpt-4");
      expect(state2).toBe(state1);
    });

    it("creates different states for different conversations", () => {
      const state1 = initSessionState("account1", "conv1");
      const state2 = initSessionState("account1", "conv2");
      expect(state1).not.toBe(state2);
    });
  });

  describe("updateSessionState", () => {
    it("updates model", () => {
      initSessionState("account1", "conv1");
      updateSessionState("account1", "conv1", { model: "claude-3" });
      const state = getSessionState("account1", "conv1");
      expect(state?.model).toBe("claude-3");
    });

    it("updates effort", () => {
      initSessionState("account1", "conv1");
      updateSessionState("account1", "conv1", { effort: "high" });
      const state = getSessionState("account1", "conv1");
      expect(state?.effort).toBe("high");
    });

    it("does nothing if state does not exist", () => {
      updateSessionState("account1", "conv1", { model: "gpt-4" });
      const state = getSessionState("account1", "conv1");
      expect(state).toBeUndefined();
    });
  });

  describe("incrementDapiCount", () => {
    it("increments count and returns new value", () => {
      initSessionState("account1", "conv1");
      const count1 = incrementDapiCount("account1", "conv1");
      const count2 = incrementDapiCount("account1", "conv1");
      expect(count1).toBe(1);
      expect(count2).toBe(2);
      const state = getSessionState("account1", "conv1");
      expect(state?.dapiCount).toBe(2);
    });

    it("returns 0 if state does not exist", () => {
      const count = incrementDapiCount("account1", "conv1");
      expect(count).toBe(0);
    });
  });

  describe("getTaskTimeSeconds", () => {
    it("returns undefined if state does not exist", () => {
      const time = getTaskTimeSeconds("account1", "conv1");
      expect(time).toBeUndefined();
    });

    it("returns elapsed time in seconds", async () => {
      initSessionState("account1", "conv1");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const time = getTaskTimeSeconds("account1", "conv1");
      expect(time).toBeGreaterThanOrEqual(0);
    });
  });

  describe("clearSessionState", () => {
    it("removes state from map", () => {
      initSessionState("account1", "conv1");
      clearSessionState("account1", "conv1");
      const state = getSessionState("account1", "conv1");
      expect(state).toBeUndefined();
    });
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `pnpm vitest run tests/unit/session-state.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/session-state.ts tests/unit/session-state.test.ts
git commit -m "feat(session-state): add session state management for model/effort/dapiCount"
```

---

### Task 3: 修改 ReplyOptions 接口添加 onModelSelected

**Files:**
- Modify: `src/reply-strategy.ts`

- [ ] **Step 1: 在 ReplyOptions interface 中添加 onModelSelected**

找到 `ReplyOptions` interface，在 `onAssistantMessageStart` 之后添加：

```typescript
  onModelSelected?: (ctx: { provider: string; model: string; thinkLevel?: string }) => void;
```

完整的 `ReplyOptions` interface 应为：

```typescript
export interface ReplyOptions {
  disableBlockStreaming: boolean;
  onPartialReply?: (payload: { text?: string }) => void | Promise<void>;
  onReasoningStream?: (payload: { text?: string }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onModelSelected?: (ctx: { provider: string; model: string; thinkLevel?: string }) => void;
}
```

- [ ] **Step 2: 运行类型检查**

Run: `pnpm run type-check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/reply-strategy.ts
git commit -m "feat(reply-strategy): add onModelSelected callback to ReplyOptions"
```

---

### Task 4: 修改 CardDraftController 使用 CardBlock

**Files:**
- Modify: `src/card-draft-controller.ts`
- Modify: `tests/unit/card-draft-controller.test.ts`

- [ ] **Step 1: 修改 TimelineEntry 类型为 CardBlock**

在 `card-draft-controller.ts` 中，删除：

```typescript
type TimelineEntryKind = "thinking" | "tool" | "answer";

type TimelineEntry = {
    kind: TimelineEntryKind;
    text: string;
};
```

替换为：

```typescript
import type { CardBlock } from "./types";
```

- [ ] **Step 2: 修改 timelineEntries 变量类型**

找到 `let timelineEntries: TimelineEntry[]` 改为：

```typescript
let timelineEntries: CardBlock[] = [];
```

- [ ] **Step 3: 修改 activeThinkingIndex 和 activeAnswerIndex 逻辑**

将 `activeThinkingIndex` 重命名为 `activeProcessIndex`（用于 thinking/tool），保留 `activeAnswerIndex`。

找到：

```typescript
let activeThinkingIndex: number | null = null;
let activeAnswerIndex: number | null = null;
```

改为：

```typescript
let activeProcessIndex: number | null = null;
let activeAnswerIndex: number | null = null;
```

- [ ] **Step 4: 修改 removeTimelineEntry 函数**

将 `activeThinkingIndex` 改为 `activeProcessIndex`：

```typescript
const removeTimelineEntry = (index: number) => {
    timelineEntries.splice(index, 1);
    if (activeProcessIndex !== null) {
        if (activeProcessIndex === index) {
            activeProcessIndex = null;
        } else if (activeProcessIndex > index) {
            activeProcessIndex -= 1;
        }
    }
    if (activeAnswerIndex !== null) {
        if (activeAnswerIndex === index) {
            activeAnswerIndex = null;
        } else if (activeAnswerIndex > index) {
            activeAnswerIndex -= 1;
        }
    }
};
```

- [ ] **Step 5: 修改 appendTimelineEntry 函数**

```typescript
const appendTimelineEntry = (isTool: boolean, text: string): number => {
    timelineEntries.push({ text, markdown: text, isTool });
    return timelineEntries.length - 1;
};
```

- [ ] **Step 6: 修改 getFinalAnswerContent 函数**

```typescript
const getFinalAnswerContent = (): string => {
    return timelineEntries
        .filter((entry) => !entry.isTool && entry.text)
        .map((entry) => entry.text)
        .join("\n\n");
};
```

- [ ] **Step 7: 修改 renderTimeline 函数**

替换整个 `renderTimeline` 函数：

```typescript
const renderTimeline = (options: {
    fallbackAnswer?: string;
    overrideAnswer?: string;
    compactProcessAnswerSpacing?: boolean;
} = {}): string => {
    const entries = timelineEntries.map((entry) => ({ ...entry }));

    const overrideAnswer = normalizeAnswerText(options.overrideAnswer);
    if (overrideAnswer) {
        const lastAnswerIndex = [...entries]
            .map((entry, index) => ({ entry, index }))
            .toReversed()
            .find(({ entry }) => !entry.isTool)?.index;
        if (lastAnswerIndex !== undefined) {
            entries[lastAnswerIndex] = { text: overrideAnswer, markdown: overrideAnswer, isTool: false };
        } else {
            entries.push({ text: overrideAnswer, markdown: overrideAnswer, isTool: false });
        }
    } else if (!entries.some((entry) => !entry.isTool && entry.text)) {
        const fallbackAnswer = normalizeAnswerText(options.fallbackAnswer);
        if (fallbackAnswer) {
            entries.push({ text: fallbackAnswer, markdown: fallbackAnswer, isTool: false });
        }
    }

    let rendered = "";
    const compactProcessAnswerSpacing = options.compactProcessAnswerSpacing === true;
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (!entry?.text) {
            continue;
        }
        const part = entry.isTool
            ? renderProcessBlock(entry.text)
            : entry.text;
        if (!rendered) {
            rendered = part;
            continue;
        }
        const previousIsTool = entries[index - 1]?.isTool;
        const separator =
            compactProcessAnswerSpacing && previousIsTool !== undefined
                ? "\n"
                : "\n\n";
        rendered += `${separator}${part}`;
    }

    return rendered;
};
```

- [ ] **Step 8: 修改 sealLiveThinking 函数名和实现**

将 `sealLiveThinking` 重命名为 `sealActiveProcess`：

```typescript
const sealActiveProcess = () => {
    activeProcessIndex = null;
};
```

- [ ] **Step 9: 修改 updateReasoning 函数**

```typescript
const updateReasoning = async (text: string) => {
    await waitForPendingBoundary();
    if (stopped || failed || activeAnswerIndex !== null) {
        return;
    }
    const normalized = normalizeProcessText(text);
    if (!normalized) {
        return;
    }
    if (activeProcessIndex === null && timelineEntries.length > 0) {
        const lastIsTool = timelineEntries.at(-1)?.isTool;
        if (lastIsTool === false) {
            await flushBoundaryFrame();
        }
    }
    if (activeProcessIndex !== null) {
        timelineEntries[activeProcessIndex] = { text: normalized, markdown: normalized, isTool: true };
    } else {
        activeProcessIndex = appendTimelineEntry(true, normalized);
    }
    queueRender();
};
```

- [ ] **Step 10: 修改 updateAnswer 函数**

```typescript
const updateAnswer = async (text: string) => {
    await waitForPendingBoundary();
    if (stopped || failed) {
        return;
    }
    const normalized = normalizeAnswerText(text);
    if (!normalized.trim()) {
        return;
    }
    if (activeAnswerIndex === null && timelineEntries.length > 0) {
        const lastIsTool = timelineEntries.at(-1)?.isTool;
        if (lastIsTool === true) {
            await flushBoundaryFrame();
        }
    }
    sealActiveProcess();
    if (activeAnswerIndex !== null) {
        timelineEntries[activeAnswerIndex] = { text: normalized, markdown: normalized, isTool: false };
    } else {
        activeAnswerIndex = appendTimelineEntry(false, normalized);
    }
    queueRender();
};
```

- [ ] **Step 11: 修改 updateTool 函数**

```typescript
const updateTool = async (text: string) => {
    await waitForPendingBoundary();
    if (stopped || failed) {
        return;
    }
    const normalized = normalizeProcessText(text);
    if (!normalized) {
        return;
    }
    if (timelineEntries.length > 0) {
        await flushBoundaryFrame();
    }
    sealActiveProcess();
    sealCurrentAnswer();
    appendTimelineEntry(true, normalized);
    queueRender();
};
```

- [ ] **Step 12: 修改 notifyNewAssistantTurn 函数**

```typescript
const notifyNewAssistantTurn = async () => {
    if (stopped || failed) {
        return;
    }
    if (activeAnswerIndex !== null) {
        sealCurrentAnswer();
        await beginBoundaryFlush();
        return;
    }
    if (activeProcessIndex !== null) {
        removeTimelineEntry(activeProcessIndex);
        loop.resetPending();
    }
};
```

- [ ] **Step 13: 添加 getBlockList 方法到返回对象**

在返回对象中添加：

```typescript
getBlockList: () => [...timelineEntries],
```

- [ ] **Step 14: 运行类型检查**

Run: `pnpm run type-check`
Expected: No errors

- [ ] **Step 15: 运行现有测试确认兼容**

Run: `pnpm vitest run tests/unit/card-draft-controller.test.ts`
Expected: All tests pass (behavior unchanged from external API)

- [ ] **Step 16: Commit**

```bash
git add src/card-draft-controller.ts
git commit -m "refactor(card-draft): use CardBlock[] instead of TimelineEntry[]"
```

---

### Task 5: 修改 card-service.ts 使用预置模板和 blockList streaming

**Files:**
- Modify: `src/card-service.ts`
- Modify: `tests/unit/card-service.test.ts`

- [ ] **Step 1: 导入新类型和 session-state**

在 `card-service.ts` 顶部添加：

```typescript
import {
  incrementDapiCount,
  getSessionState,
} from "./session-state";
import type { CardBlock, CardTaskInfo } from "./types";
import { PRESET_CARD_TEMPLATE_ID } from "./types";
```

- [ ] **Step 2: 修改 createAICard 使用 PRESET_CARD_TEMPLATE_ID**

找到 `createAICard` 函数中检查 `cardTemplateId` 的代码：

```typescript
if (!config.cardTemplateId) {
  throw new Error("DingTalk cardTemplateId is not configured.");
}
```

替换为：

```typescript
// Use preset template ID, no user configuration needed
const cardTemplateId = PRESET_CARD_TEMPLATE_ID;
```

并删除 `config.cardTemplateId` 的所有引用，改为使用 `cardTemplateId` 局部变量。

- [ ] **Step 3: 修改 createAndDeliver 的 cardParamMap**

找到构建 `cardParamMap` 的代码：

```typescript
const cardTemplateKey = config.cardTemplateKey || "content";
const cardParamMap = {
  config: JSON.stringify({ autoLayout: true, enableForward: true }),
  [cardTemplateKey]: "",
};
```

替换为（部署静态参数）：

```typescript
const cardParamMap = {
  config: JSON.stringify({ autoLayout: true, enableForward: true }),
  blockList: JSON.stringify([]),
  taskInfo: JSON.stringify({}),
  hasQuote: "false",
  quoteContent: "",
  btns: JSON.stringify([]),
  hasAction: "false",
};
```

- [ ] **Step 4: 添加 dapiCount 递增**

在 `createAICard` 函数成功创建卡片后（axios.post 成功），添加：

```typescript
// Increment API count for createAndDeliver
if (options.accountId) {
  incrementDapiCount(options.accountId, conversationId, log);
}
```

- [ ] **Step 5: 修改 streamAICard 函数签名**

将 `streamAICard` 改为接收 `CardBlock[]` 而非 `string content`：

```typescript
export async function streamAICard(
  card: AICardInstance,
  blockList: CardBlock[],
  finished: boolean = false,
  log?: Logger,
): Promise<void> {
```

- [ ] **Step 6: 修改 streamAICard 的 streamBody**

将 `streamBody` 改为推送 `blockList` key：

```typescript
const streamBody: AICardStreamingRequest = {
  outTrackId: card.outTrackId || card.cardInstanceId,
  guid: randomUUID(),
  key: "blockList",
  content: JSON.stringify(blockList),
  isFull: true,
  isFinalize: finished,
  isError: false,
};
```

- [ ] **Step 7: 在 streamAICard 中添加 dapiCount 递增**

在 axios.put 成功后添加：

```typescript
// Increment API count for streaming
if (card.accountId) {
  incrementDapiCount(card.accountId, card.conversationId, log);
}
```

- [ ] **Step 8: 更新 finishAICard 函数**

修改 `finishAICard` 接收 `CardBlock[]`：

```typescript
export async function finishAICard(
  card: AICardInstance,
  blockList: CardBlock[],
  log?: Logger,
  options: { quotedRef?: QuotedRef } = {},
): Promise<void> {
  log?.debug?.(`[DingTalk][AICard] Starting finish, blockList length=${blockList.length}`);
  await streamAICard(card, blockList, true, log);
  // ... rest of the function unchanged
}
```

- [ ] **Step 9: 更新调用 streamAICard 的地方**

搜索所有调用 `streamAICard` 和 `finishAICard` 的地方，更新参数类型。主要在 `card-draft-controller.ts` 和 `reply-strategy-card.ts` 中。

- [ ] **Step 10: 运行类型检查**

Run: `pnpm run type-check`
Expected: May have errors in other files that call streamAICard - fix in subsequent tasks

- [ ] **Step 11: Commit**

```bash
git add src/card-service.ts
git commit -m "refactor(card-service): use PRESET_CARD_TEMPLATE_ID and blockList streaming"
```

---

### Task 6: 修改 card-draft-controller 调用新的 streamAICard

**Files:**
- Modify: `src/card-draft-controller.ts`

- [ ] **Step 1: 修改 sendOrEditStreamMessage 调用**

找到 `createDraftStreamLoop` 中的 `sendOrEditStreamMessage`，修改为传递 `blockList`：

```typescript
sendOrEditStreamMessage: async (content: string) => {
    try {
        const blockList = timelineEntries;
        await streamAICard(params.card, blockList, false, params.log);
        lastSentContent = content;
        lastAnswerContent = getFinalAnswerContent();
    } catch (err: unknown) {
        // ... error handling unchanged
    }
},
```

- [ ] **Step 2: 运行类型检查**

Run: `pnpm run type-check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/card-draft-controller.ts
git commit -m "refactor(card-draft): pass blockList to streamAICard"
```

---

### Task 7: 修改 reply-strategy-card.ts 接入 onModelSelected 和 quoteContent

**Files:**
- Modify: `src/reply-strategy-card.ts`

- [ ] **Step 1: 导入 session-state**

在文件顶部添加：

```typescript
import {
  initSessionState,
  updateSessionState,
  getTaskTimeSeconds,
  getSessionState,
} from "./session-state";
```

- [ ] **Step 2: 修改 createCardReplyStrategy 参数**

扩展 `ReplyStrategyContext` 或新增参数传递 `accountId`、`conversationId`、`quotedText`：

找到函数定义：

```typescript
export function createCardReplyStrategy(
  ctx: ReplyStrategyContext & { card: AICardInstance },
): ReplyStrategy {
```

确保 `ctx` 中包含需要的信息（accountId, conversationId, quotedText）。如果 `ReplyStrategyContext` 已有这些字段，直接使用。

- [ ] **Step 3: 在 getReplyOptions 中添加 onModelSelected**

```typescript
getReplyOptions(): ReplyOptions {
  return {
    disableBlockStreaming: true,

    onAssistantMessageStart: async () => {
      await controller.notifyNewAssistantTurn();
    },

    onModelSelected: (ctx) => {
      updateSessionState(ctx.accountId, ctx.conversationId, {
        model: ctx.model,
        effort: ctx.thinkLevel,
      });
    },

    onPartialReply: config.cardRealTimeStream
      ? async (payload) => {
          if (payload.text) {
            await controller.updateAnswer(payload.text);
          }
        }
      : undefined,

    onReasoningStream: async (payload) => {
      if (payload.text) {
        await controller.updateThinking(payload.text);
      }
    },
  };
},
```

- [ ] **Step 4: 在 finalize 中组装 taskInfo**

找到 `finalize` 函数，在调用 `finishAICard` 前：

```typescript
const sessionState = getSessionState(ctx.accountId, ctx.conversationId || ctx.to);
const taskTime = getTaskTimeSeconds(ctx.accountId, ctx.conversationId || ctx.to);

const taskInfo: CardTaskInfo = {
  model: sessionState?.model,
  effort: sessionState?.effort,
  taskTime,
  dapi_usage: sessionState?.dapiCount,
};

// Log taskInfo for debugging
log?.debug?.(`[DingTalk][AICard] Finalizing with taskInfo: ${JSON.stringify(taskInfo)}`);
```

- [ ] **Step 5: 获取 blockList 并传递给 finishAICard**

```typescript
const blockList = controller.getBlockList();
await finishAICard(card, blockList, log, {
  quotedRef: ctx.replyQuotedRef,
});
```

- [ ] **Step 6: 运行类型检查**

Run: `pnpm run type-check`
Expected: No errors

- [ ] **Step 7: 运行测试**

Run: `pnpm vitest run tests/unit/reply-strategy-card.test.ts`
Expected: Tests may need updates - fix as needed

- [ ] **Step 8: Commit**

```bash
git add src/reply-strategy-card.ts
git commit -m "feat(reply-strategy-card): integrate onModelSelected and session state"
```

---

### Task 8: 修改 inbound-handler.ts 初始化 SessionState

**Files:**
- Modify: `src/inbound-handler.ts`

- [ ] **Step 1: 导入 session-state**

在文件顶部添加：

```typescript
import { initSessionState } from "./session-state";
```

- [ ] **Step 2: 在 handleDingTalkMessage 中初始化 session state**

在 `handleDingTalkMessage` 函数开头（获取 config 后）：

```typescript
// Initialize session state for this conversation
initSessionState(accountId, conversationId, log);
```

- [ ] **Step 3: 传递 quotedText 给 reply strategy**

在创建 reply strategy 时，如果存在引用消息（`quoted?.previewText`），需要传递给 `createCardReplyStrategy`。

这需要扩展 `ReplyStrategyContext` 或在 inbound-handler 中预处理。

- [ ] **Step 4: 运行类型检查**

Run: `pnpm run type-check`
Expected: No errors

- [ ] **Step 5: 运行测试**

Run: `pnpm vitest run tests/unit/inbound-handler.test.ts`
Expected: Tests should pass

- [ ] **Step 6: Commit**

```bash
git add src/inbound-handler.ts
git commit -m "feat(inbound-handler): initialize SessionState on message arrival"
```

---

### Task 9: 修改 config.ts 移除 cardTemplateId/cardTemplateKey

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/unit/config.test.ts`

- [ ] **Step 1: 从 mergeAccountWithDefaults 中移除相关字段**

找到 `mergeAccountWithDefaults` 函数，删除 `cardTemplateId` 和 `cardTemplateKey` 的合并逻辑。

- [ ] **Step 2: 从配置解析中移除**

搜索 `cardTemplateId` 和 `cardTemplateKey`，删除所有解析逻辑。

- [ ] **Step 3: 更新测试**

在 `config.test.ts` 中删除或更新与 `cardTemplateId`/`cardTemplateKey` 相关的测试用例。

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run tests/unit/config.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "refactor(config): remove cardTemplateId and cardTemplateKey configuration"
```

---

### Task 10: 修改 onboarding.ts 移除卡片模板配置引导

**Files:**
- Modify: `src/onboarding.ts`
- Modify: `tests/unit/onboarding.test.ts`

- [ ] **Step 1: 搜索并移除 cardTemplateId/cardTemplateKey 引导**

找到 onboarding 中关于卡片模板配置的步骤，删除相关代码。

- [ ] **Step 2: 更新测试**

更新 `onboarding.test.ts` 中相关测试。

- [ ] **Step 3: 运行测试**

Run: `pnpm vitest run tests/unit/onboarding.test.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/onboarding.ts tests/unit/onboarding.test.ts
git commit -m "refactor(onboarding): remove card template configuration steps"
```

---

### Task 11: 更新所有测试确保通过

**Files:**
- Multiple test files

- [ ] **Step 1: 运行全部测试**

Run: `pnpm test`
Expected: Identify any failing tests

- [ ] **Step 2: 修复失败的测试**

根据测试失败信息修复相关测试用例。主要关注：
- `card-service.test.ts` - streamAICard 参数变化
- `reply-strategy-card.test.ts` - 新的 blockList 逻辑
- `card-draft-controller.test.ts` - CardBlock 类型

- [ ] **Step 3: 再次运行测试确认全部通过**

Run: `pnpm test`
Expected: All 700+ tests pass

- [ ] **Step 4: 运行 lint 和 type-check**

Run: `pnpm run lint && pnpm run type-check`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test: update tests for CardBlock and session state changes"
```

---

### Task 12: 更新 CLAUDE.md 文档

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 Architecture 部分**

在 Architecture 部分添加 session-state 模块说明：

```markdown
- **`src/session-state.ts`** — Runtime session state (model, effort, dapiCount, taskTime) for AI Card v2 template.
```

- [ ] **Step 2: 更新 Key Patterns 部分**

添加 CardBlock 相关说明：

```markdown
- **CardBlock streaming**: AI Card now uses structured `blockList` via streaming API instead of single markdown content. Static params (taskInfo, hasQuote, btns) deployed at card creation.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for AI Card v2 architecture"
```

---

## Summary

本计划将 AI Card 从单一 markdown 流升级为结构化多 key streaming：

1. **新增类型** — `CardBlock`, `CardTaskInfo`, `CardBtn`, `CardStreamPayload`, `PRESET_CARD_TEMPLATE_ID`
2. **Session 状态** — 内存 Map 管理 model/effort/dapiCount/taskTime
3. **CardDraftController** — 使用 `CardBlock[]` 替代 `TimelineEntry[]`
4. **streamAICard** — 推送 `blockList` key
5. **createAndDeliver** — 部署静态参数（taskInfo, hasQuote, btns）
6. **onModelSelected** — 从 runtime 获取 model/effort
7. **配置简化** — 移除 `cardTemplateId`/`cardTemplateKey`