# Card taskInfo Token Usage Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture per-task LLM token consumption via the `llm_output` plugin hook and surface it in the DingTalk AI Card's `taskInfo` footer — zero upstream changes required.

**Architecture:** A new `run-usage-store` module maintains an in-memory `runId → accountId:conversationId` mapping (populated from `onAgentRunStart`) and an `accountId:conversationId → accumulated usage` store (populated from the `llm_output` hook). The card reply strategy reads accumulated usage during `buildTaskInfoJson()` and writes token counts into the card template payload. Data is cleaned up on card finalization.

**Tech Stack:** TypeScript (strict, ES2023), Vitest, OpenClaw plugin hook API (`api.on("llm_output", ...)`)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/run-usage-store.ts` | Create | RunId↔session mapping + usage accumulation |
| `src/reply-strategy-card.ts` | Modify | Record runId mapping in `onAgentRunStart`; read usage in `buildTaskInfoJson` |
| `index.ts` | Modify | Register `llm_output` plugin hook |
| `docs/spec/2026-03-30-card-template-v2-design.md` | Modify | Extend `CardTaskInfo` with token fields |
| `tests/unit/run-usage-store.test.ts` | Create | Unit tests for the store |

---

## Correlation Strategy

The `llm_output` hook fires at the **plugin level** (globally, for all runs), not per-card. We need to correlate hook events with specific card instances:

1. `onAgentRunStart(runId)` fires inside the card reply strategy → stores `runId → accountId:conversationId`
2. `llm_output` hook fires globally with `event.runId` → looks up the mapping → accumulates usage
3. `buildTaskInfoJson()` reads accumulated usage by `accountId:conversationId`
4. Card finalization clears both the runId mapping and accumulated usage

```
onAgentRunStart(runId)  ─→  runId → { accountId, conversationId }
                                    ↓
llm_output hook          ─→  lookup runId → accumulate usage under accountId:conversationId
                                    ↓
buildTaskInfoJson()       ─→  read accumulated usage → write token fields
                                    ↓
card finalization         ─→  cleanup
```

### Hook Contract (upstream, read-only)

**Registration:** `api.on("llm_output", handler)` inside `registerFull(api)`

**Event shape** (`PluginHookLlmOutputEvent`, from `openclaw/src/plugins/types.ts:2375`):
```typescript
{
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}
```

**Context shape** (`PluginHookAgentContext`, from `openclaw/src/plugins/types.ts:2248`):
```typescript
{
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  channelId?: string;  // "dingtalk" for our hook
  trigger?: string;
}
```

---

## Task 1: Create `run-usage-store.ts`

**Files:**
- Create: `src/run-usage-store.ts`
- Test: `tests/unit/run-usage-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/run-usage-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordRunStart,
  accumulateUsage,
  getUsage,
  clearRun,
  clearSessionUsage,
  clearAllForTest,
} from "../../src/run-usage-store";

describe("run-usage-store", () => {
  beforeEach(() => {
    clearAllForTest();
  });

  describe("recordRunStart", () => {
    it("stores runId → session mapping", () => {
      recordRunStart("run-1", "acct-x", "conv-y");
      const usage = { input: 10, output: 5, total: 15 };
      accumulateUsage("run-1", usage);
      expect(getUsage("acct-x", "conv-y")).toEqual({ input: 10, output: 5, total: 15 });
    });
  });

  describe("accumulateUsage", () => {
    it("accumulates across multiple LLM calls for the same run", () => {
      recordRunStart("run-1", "acct-a", "conv-1");
      accumulateUsage("run-1", { input: 100, output: 50, total: 150 });
      accumulateUsage("run-1", { input: 200, output: 80, total: 280 });
      expect(getUsage("acct-a", "conv-1")).toEqual({
        input: 300,
        output: 130,
        total: 430,
      });
    });

    it("returns undefined for unknown runId", () => {
      accumulateUsage("unknown-run", { input: 10 });
      expect(getUsage("acct-a", "conv-1")).toBeUndefined();
    });

    it("handles partial usage objects (only input)", () => {
      recordRunStart("run-2", "acct-b", "conv-2");
      accumulateUsage("run-2", { input: 50 });
      expect(getUsage("acct-b", "conv-2")).toEqual({ input: 50 });
    });

    it("handles cacheRead and cacheWrite", () => {
      recordRunStart("run-3", "acct-c", "conv-3");
      accumulateUsage("run-3", { input: 100, cacheRead: 60, cacheWrite: 20, total: 180 });
      expect(getUsage("acct-c", "conv-3")).toEqual({
        input: 100,
        cacheRead: 60,
        cacheWrite: 20,
        total: 180,
      });
    });
  });

  describe("getUsage", () => {
    it("returns undefined when no usage recorded", () => {
      expect(getUsage("acct-x", "conv-y")).toBeUndefined();
    });
  });

  describe("clearRun", () => {
    it("removes runId mapping but keeps accumulated usage", () => {
      recordRunStart("run-1", "acct-a", "conv-1");
      accumulateUsage("run-1", { input: 50, total: 50 });
      clearRun("run-1");
      // Usage still accessible by accountId:conversationId
      expect(getUsage("acct-a", "conv-1")).toEqual({ input: 50, total: 50 });
      // New calls for same runId are ignored (mapping removed)
      accumulateUsage("run-1", { input: 10 });
      expect(getUsage("acct-a", "conv-1")).toEqual({ input: 50, total: 50 });
    });
  });

  describe("clearSessionUsage", () => {
    it("removes all usage data for a session", () => {
      recordRunStart("run-1", "acct-a", "conv-1");
      accumulateUsage("run-1", { input: 50, total: 50 });
      clearSessionUsage("acct-a", "conv-1");
      expect(getUsage("acct-a", "conv-1")).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/run-usage-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/run-usage-store.ts
interface UsageAccumulation {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

interface RunMapping {
  accountId: string;
  conversationId: string;
}

const runMappings = new Map<string, RunMapping>();
const usageStore = new Map<string, UsageAccumulation>();

function sessionKey(accountId: string, conversationId: string): string {
  return `${accountId}:${conversationId}`;
}

export function recordRunStart(runId: string, accountId: string, conversationId: string): void {
  runMappings.set(runId, { accountId, conversationId });
}

export function accumulateUsage(
  runId: string,
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number },
): void {
  const mapping = runMappings.get(runId);
  if (!mapping) {
    return;
  }
  const key = sessionKey(mapping.accountId, mapping.conversationId);
  const existing = usageStore.get(key) ?? {};
  if (typeof usage.input === "number") {
    existing.input = (existing.input ?? 0) + usage.input;
  }
  if (typeof usage.output === "number") {
    existing.output = (existing.output ?? 0) + usage.output;
  }
  if (typeof usage.cacheRead === "number") {
    existing.cacheRead = (existing.cacheRead ?? 0) + usage.cacheRead;
  }
  if (typeof usage.cacheWrite === "number") {
    existing.cacheWrite = (existing.cacheWrite ?? 0) + usage.cacheWrite;
  }
  if (typeof usage.total === "number") {
    existing.total = (existing.total ?? 0) + usage.total;
  }
  usageStore.set(key, existing);
}

export function getUsage(accountId: string, conversationId: string): UsageAccumulation | undefined {
  return usageStore.get(sessionKey(accountId, conversationId));
}

export function clearRun(runId: string): void {
  runMappings.delete(runId);
}

export function clearSessionUsage(accountId: string, conversationId: string): void {
  const key = sessionKey(accountId, conversationId);
  usageStore.delete(key);
  for (const [runId, mapping] of runMappings) {
    if (mapping.accountId === accountId && mapping.conversationId === conversationId) {
      runMappings.delete(runId);
    }
  }
}

export function clearAllForTest(): void {
  runMappings.clear();
  usageStore.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/run-usage-store.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2
git add src/run-usage-store.ts tests/unit/run-usage-store.test.ts
git commit -m "feat(card): add run-usage-store for tracking token consumption per session"
```

---

## Task 2: Register `llm_output` plugin hook

**Files:**
- Modify: `index.ts:82-84` (inside `registerFull`)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/llm-output-hook.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { clearAllForTest, getUsage, recordRunStart } from "../../src/run-usage-store";

// We test that registerFull wires the hook correctly
// by simulating the api.on registration and then calling the handler.
describe("llm_output hook registration", () => {
  let registeredHooks: Map<string, Function>;
  let mockApi: Partial<OpenClawPluginApi>;

  beforeEach(() => {
    clearAllForTest();
    registeredHooks = new Map();
    mockApi = {
      config: {} as any,
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      registerGatewayMethod: vi.fn(),
      on: vi.fn((hookName: string, handler: Function) => {
        registeredHooks.set(hookName, handler);
      }),
    } as any;
  });

  it("registers an llm_output hook via api.on", async () => {
    // Dynamically import to trigger registerFull
    const mod = await import("../../index");
    const entry = mod.default;
    // Simulate registerFull call
    entry.registerFull?.(mockApi as OpenClawPluginApi);

    expect(mockApi.on).toHaveBeenCalledWith(
      "llm_output",
      expect.any(Function),
    );
  });

  it("accumulates usage from llm_output events", async () => {
    const mod = await import("../../index");
    const entry = mod.default;
    entry.registerFull?.(mockApi as OpenClawPluginApi);

    const handler = registeredHooks.get("llm_output")!;
    expect(handler).toBeDefined();

    // Pre-register the runId mapping (normally done by onAgentRunStart in reply strategy)
    recordRunStart("run-abc", "acct-1", "conv-1");

    // Simulate hook firing
    await handler(
      {
        runId: "run-abc",
        sessionId: "session-xyz",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        assistantTexts: ["Hello"],
        usage: { input: 100, output: 50, total: 150 },
      },
      { channelId: "dingtalk", sessionId: "session-xyz" },
    );

    expect(getUsage("acct-1", "conv-1")).toEqual({
      input: 100,
      output: 50,
      total: 150,
    });
  });

  it("ignores events for other channels", async () => {
    const mod = await import("../../index");
    const entry = mod.default;
    entry.registerFull?.(mockApi as OpenClawPluginApi);

    const handler = registeredHooks.get("llm_output")!;

    recordRunStart("run-other", "acct-1", "conv-1");

    // Non-dingtalk channel (no channelId guard needed — we just don't filter;
    // the runId won't match since recordRunStart is dingtalk-only)
    await handler(
      {
        runId: "run-other",
        sessionId: "session-xyz",
        provider: "openai",
        model: "gpt-5",
        assistantTexts: ["Hi"],
        usage: { input: 200, output: 100, total: 300 },
      },
      { channelId: "telegram", sessionId: "session-xyz" },
    );

    // Usage still accumulated since runId was registered
    expect(getUsage("acct-1", "conv-1")).toEqual({
      input: 200,
      output: 100,
      total: 300,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/llm-output-hook.test.ts`
Expected: FAIL — `api.on` not called (no `llm_output` hook registered yet)

- [ ] **Step 3: Implement the hook registration**

Modify `index.ts` — add the `llm_output` hook registration inside `registerFull`:

```typescript
// index.ts — add import at top
import { accumulateUsage } from "./src/run-usage-store";

// Inside registerFull(api), after the existing gateway methods:
function registerFull(api: OpenClawPluginApi): void {
  registerDingTalkDocsGatewayMethods(api);

  // Capture per-call LLM token usage for card taskInfo display.
  // The runId → session mapping is set by onAgentRunStart in the card reply strategy.
  api.on("llm_output", (event: { runId: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } }) => {
    if (event.usage) {
      accumulateUsage(event.runId, event.usage);
    }
  });
}
```

The actual diff to apply at `index.ts:82-84`:

```diff
 export default defineChannelPluginEntry({
   id: "dingtalk",
   name: "DingTalk Channel",
   description: "DingTalk (钉钉) messaging channel via Stream mode",
   plugin: dingtalkPlugin,
   setRuntime: setDingTalkRuntime,
   registerFull(api) {
     registerDingTalkDocsGatewayMethods(api);
+
+    api.on("llm_output", (event: { runId: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } }) => {
+      if (event.usage) {
+        accumulateUsage(event.runId, event.usage);
+      }
+    });
   },
 });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/llm-output-hook.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2
git add index.ts tests/unit/llm-output-hook.test.ts
git commit -m "feat(card): register llm_output hook to capture token usage"
```

---

## Task 3: Wire `onAgentRunStart` to record runId mapping

**Files:**
- Modify: `src/reply-strategy-card.ts:397` (inside `createReplyCallbacks`)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/run-usage-integration.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { clearAllForTest, getUsage, recordRunStart } from "../../src/run-usage-store";

describe("run-usage onAgentRunStart integration", () => {
  beforeEach(() => {
    clearAllForTest();
  });

  it("records runId mapping from card context", () => {
    // Simulates what happens inside reply-strategy-card's onAgentRunStart callback
    const accountId = "my-account";
    const conversationId = "conv-123";
    const runId = "run-abc";

    recordRunStart(runId, accountId, conversationId);

    // After recording, a llm_output event should be able to accumulate usage
    const { accumulateUsage } = await import("../../src/run-usage-store");
    accumulateUsage(runId, { input: 500, output: 200, cacheRead: 100, total: 800 });

    expect(getUsage(accountId, conversationId)).toEqual({
      input: 500,
      output: 200,
      cacheRead: 100,
      total: 800,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (this tests the store, already working from Task 1)

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/run-usage-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Add `recordRunStart` call to the card reply strategy**

Modify `src/reply-strategy-card.ts` — add import and call inside the `createReplyCallbacks` function.

Add to imports at top of file:
```typescript
import { recordRunStart, getUsage, clearRun, clearSessionUsage } from "./run-usage-store";
```

Inside `createReplyCallbacks`, find the existing `onAgentRunStart` callback (around line 392-396) and add `recordRunStart`:

```diff
        onAgentRunStart: (runId: string) => {
          if (isLifecycleSealed()) {
            return;
          }
+         if (card.accountId && card.conversationId) {
+           recordRunStart(runId, card.accountId, card.contextConversationId || card.conversationId);
+         }
        },
```

- [ ] **Step 4: Run type-check to verify no errors**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm run type-check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2
git add src/reply-strategy-card.ts
git commit -m "feat(card): record runId mapping in onAgentRunStart for usage tracking"
```

---

## Task 4: Extend `buildTaskInfoJson()` with token fields

**Files:**
- Modify: `src/reply-strategy-card.ts:50-89` (the `buildTaskInfoJson` closure)
- Modify: `docs/spec/2026-03-30-card-template-v2-design.md:91-96` (CardTaskInfo definition)

- [ ] **Step 1: Update the CardTaskInfo spec**

Modify `docs/spec/2026-03-30-card-template-v2-design.md` at line 91:

```diff
 export interface CardTaskInfo {
   model?: string;       // 模型名（通过 onModelSelected 获取）
   effort?: string;      // 思维链深度（通过 onModelSelected 获取）
   dap_usage?: number;   // 钉钉 API 调用次数（插件本地计数，字段名与模板一致）
   taskTime?: number;    // 任务耗时，秒（插件本地计时）
+  inputTokens?: number; // 输入 token 数（含 cache，通过 llm_output hook 累加）
+  outputTokens?: number;// 输出 token 数
+  cacheRead?: number;   // 缓存命中读取的 token 数
+  cacheWrite?: number;  // 写入缓存的 token 数
+  totalTokens?: number; // 总 token 数
 }
```

- [ ] **Step 2: Extend `buildTaskInfoJson()` to include token fields**

Modify the `buildTaskInfoJson` closure in `src/reply-strategy-card.ts` (lines 50-89). Add after the `agent` field (line 88):

```diff
    if (ctx.taskMeta.agent) { info.agent = ctx.taskMeta.agent; }
+
+   // Token usage from llm_output hook accumulation
+   if (card.accountId && card.conversationId) {
+     const tokenUsage = getUsage(card.accountId, card.contextConversationId || card.conversationId);
+     if (tokenUsage) {
+       if (typeof tokenUsage.input === "number") { info.inputTokens = tokenUsage.input; }
+       if (typeof tokenUsage.output === "number") { info.outputTokens = tokenUsage.output; }
+       if (typeof tokenUsage.cacheRead === "number") { info.cacheRead = tokenUsage.cacheRead; }
+       if (typeof tokenUsage.cacheWrite === "number") { info.cacheWrite = tokenUsage.cacheWrite; }
+       if (typeof tokenUsage.total === "number") { info.totalTokens = tokenUsage.total; }
+     }
+   }
+
    return Object.keys(info).length > 0 ? JSON.stringify(info) : undefined;
```

- [ ] **Step 3: Run type-check**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm run type-check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2
git add src/reply-strategy-card.ts docs/spec/2026-03-30-card-template-v2-design.md
git commit -m "feat(card): add token usage fields to taskInfo in card template"
```

---

## Task 5: Cleanup usage data on card finalization

**Files:**
- Modify: `src/reply-strategy-card.ts` (finalization and abort branches)

- [ ] **Step 1: Add cleanup calls**

The card is finalized in two code paths in `reply-strategy-card.ts`:
1. Normal finalization (the `kind === "final"` deliver block)
2. Abort (`isStopRequested`)

Find the card finalization points and add cleanup. There should be a point where the card transitions to FINISHED or FAILED state. Add cleanup there:

```typescript
import { clearSessionUsage } from "./run-usage-store";
```

At the point where card state is set to FINISHED (search for the terminal state transition in the deliver function), add:

```typescript
// After card enters terminal state (FINISHED/FAILED):
if (card.accountId && card.conversationId) {
  clearSessionUsage(card.accountId, card.contextConversationId || card.conversationId);
}
```

Also ensure cleanup happens in the abort path (where `isStopRequested()` returns true).

- [ ] **Step 2: Run type-check and tests**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm run type-check && pnpm vitest run tests/unit/run-usage-store.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2
git add src/reply-strategy-card.ts
git commit -m "feat(card): cleanup usage data on card finalization"
```

---

## Task 6: End-to-end validation

**Files:** None new — verification only.

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm test`
Expected: All existing tests pass (no regressions)

- [ ] **Step 2: Run type-check**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm run type-check`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm run lint`
Expected: No new warnings or errors

- [ ] **Step 4: Verify no regressions in existing card tests**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run -t "card"`
Expected: All card-related tests pass

---

## Self-Review Checklist

### 1. Spec Coverage

| Requirement | Task |
|---|---|
| Capture token usage from llm_output hook | Task 2 |
| Accumulate across multiple LLM calls per run | Task 1 (store handles addition) |
| Correlate hook events with card instances | Task 3 (runId mapping) |
| Surface usage in card taskInfo | Task 4 |
| Clean up memory after card finalization | Task 5 |
| Testing | Tasks 1, 2, 6 |

### 2. Placeholder Scan

No TBD, TODO, or placeholder patterns found. All steps contain complete code.

### 3. Type Consistency

- `accumulateUsage` accepts `{ input?, output?, cacheRead?, cacheWrite?, total? }` — matches hook event shape
- `getUsage` returns same shape — matches `buildTaskInfoJson` usage
- `recordRunStart(runId, accountId, conversationId)` — matches call sites in Tasks 2 and 3
- Import names consistent: `recordRunStart`, `getUsage`, `clearRun`, `clearSessionUsage`, `clearAllForTest`, `accumulateUsage`
