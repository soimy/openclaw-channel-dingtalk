# Card Configurable StatusLine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI Card footer (statusline) configurable via per-field boolean toggles, add a compact token usage display (`↑45.2k(C:32.1k) ↓28.7k`), and surface all 10 collected data fields through a WebUI-friendly config schema.

**Architecture:** Each statusline segment (model, effort, agent, taskTime, tokens, dapiUsage) is controlled by an independent `z.boolean()` config field. A new `statusline-renderer` pure-function module assembles enabled segments into a single string using fixed ordering and preset formatting. The rendered string is written into `taskInfo.statusLine` and read by the card template — all formatting logic stays Node-side, the template just displays the string. Token usage uses a compact fixed format: `↑{input}(C:{cached}) ↓{output}`.

**Tech Stack:** TypeScript (strict, ES2023), Zod, Vitest, DingTalk AI Card template v2

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/card/statusline-renderer.ts` | Create | Pure-function module: format individual segments, assemble statusline string |
| `src/config-schema.ts` | Modify | Add 6 `cardStatus*` boolean fields to `DingTalkAccountConfigShape` |
| `src/reply-strategy-card.ts` | Modify | Call `renderStatusLine()` in `buildTaskInfoJson()`, write `statusLine` field |
| `openclaw.plugin.json` | Modify | Add `cardStatus*` properties + uiHints to both top-level and accounts schema |
| `docs/assets/card-template-v2.json` | Modify | Add `statusLine` string variable to taskInfo schema; replace hardcoded footer text with `${taskInfo.statusLine}` |
| `tests/unit/statusline-renderer.test.ts` | Create | Unit tests for renderer |

---

## Segment Registry (fixed order)

| # | Segment | Config Key | Default | Format | Example |
|---|---------|-----------|---------|--------|---------|
| 1 | model | `cardStatusModel` | `true` | raw string | `claude-sonnet-4-20250514` |
| 2 | effort | `cardStatusEffort` | `true` | raw string | `high` |
| 3 | agent | `cardStatusAgent` | `true` | raw string | `MyBot` |
| 4 | taskTime | `cardStatusTaskTime` | `false` | seconds → `Xm Ys` / `Xs` | `2m 5s` |
| 5 | tokens | `cardStatusTokens` | `false` | `↑{in}(C:{cache}) ↓{out}` | `↑45.2k(C:32.1k) ↓28.7k` |
| 6 | dapiUsage | `cardStatusDapiUsage` | `false` | `API×{n}` | `API×23` |

Segments are joined with ` | `. Disabled or empty segments are skipped. No dangling separators.

Token sub-format rules:
- `cacheRead > 0`: `↑{input}(C:{cacheRead}) ↓{output}`
- `cacheRead` absent or 0: `↑{input} ↓{output}`
- Only `input` available: `↑{input}`
- Number formatting: `≥1M` → `{n/1M}.1fM`, `≥1k` → `{n/1k}.1fk`, else raw integer

---

## Task 1: Create `statusline-renderer.ts` — formatters + renderStatusLine

**Files:**
- Create: `src/card/statusline-renderer.ts`
- Test: `tests/unit/statusline-renderer.test.ts`

### Step 1: Write failing tests for `formatTokenCount`

- [ ] **Step 1a: Create test file with formatTokenCount tests**

```typescript
// tests/unit/statusline-renderer.test.ts
import { describe, it, expect } from "vitest";
import { formatTokenCount } from "../../src/card/statusline-renderer";

describe("formatTokenCount", () => {
  it("formats millions", () => {
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });

  it("formats exact million", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
  });

  it("formats thousands", () => {
    expect(formatTokenCount(12_500)).toBe("12.5k");
  });

  it("formats exact thousand", () => {
    expect(formatTokenCount(1_000)).toBe("1.0k");
  });

  it("keeps small numbers as-is", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(0)).toBe("0");
  });
});
```

- [ ] **Step 1b: Run test to verify it fails**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/statusline-renderer.test.ts`
Expected: FAIL — module not found

### Step 2: Implement `formatTokenCount`

- [ ] **Step 2a: Create the renderer module with formatTokenCount**

```typescript
// src/card/statusline-renderer.ts

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}k`; }
  return String(n);
}
```

- [ ] **Step 2b: Run test to verify it passes**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/statusline-renderer.test.ts`
Expected: PASS

### Step 3: Write failing tests for `formatDuration`

- [ ] **Step 3a: Add formatDuration tests**

Append to `tests/unit/statusline-renderer.test.ts`:

```typescript
import { formatDuration } from "../../src/card/statusline-renderer";

describe("formatDuration", () => {
  it("formats seconds only", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(125)).toBe("2m 5s");
  });

  it("formats exact minutes", () => {
    expect(formatDuration(120)).toBe("2m 0s");
  });

  it("handles zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});
```

- [ ] **Step 3b: Run test to verify it fails**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/statusline-renderer.test.ts`
Expected: FAIL — formatDuration not exported

### Step 4: Implement `formatDuration`

- [ ] **Step 4a: Add formatDuration to statusline-renderer.ts**

```typescript
export function formatDuration(seconds: number): string {
  if (seconds < 60) { return `${seconds}s`; }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
```

- [ ] **Step 4b: Run test to verify it passes**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/statusline-renderer.test.ts`
Expected: PASS

### Step 5: Write failing tests for `renderStatusLine`

- [ ] **Step 5a: Add renderStatusLine tests**

Append to `tests/unit/statusline-renderer.test.ts`:

```typescript
import { renderStatusLine } from "../../src/card/statusline-renderer";
import type { StatusLineData, StatusLineConfig } from "../../src/card/statusline-renderer";

describe("renderStatusLine", () => {
  const fullData: StatusLineData = {
    model: "claude-sonnet-4-20250514",
    effort: "high",
    agent: "MyBot",
    taskTime: 125,
    inputTokens: 45_200,
    outputTokens: 28_700,
    cacheRead: 32_100,
    dapi_usage: 23,
  };

  it("renders default config (model + effort + agent only)", () => {
    const config: StatusLineConfig = {};
    expect(renderStatusLine(fullData, config)).toBe(
      "claude-sonnet-4-20250514 | high | MyBot",
    );
  });

  it("renders all segments enabled", () => {
    const config: StatusLineConfig = {
      cardStatusModel: true,
      cardStatusEffort: true,
      cardStatusAgent: true,
      cardStatusTaskTime: true,
      cardStatusTokens: true,
      cardStatusDapiUsage: true,
    };
    expect(renderStatusLine(fullData, config)).toBe(
      "claude-sonnet-4-20250514 | high | MyBot | 2m 5s | ↑45.2k(C:32.1k) ↓28.7k | API×23",
    );
  });

  it("hides disabled segments", () => {
    const config: StatusLineConfig = {
      cardStatusModel: true,
      cardStatusEffort: false,
      cardStatusAgent: false,
      cardStatusTokens: true,
    };
    expect(renderStatusLine(fullData, config)).toBe(
      "claude-sonnet-4-20250514 | ↑45.2k(C:32.1k) ↓28.7k",
    );
  });

  it("omits cache parenthetical when cacheRead is 0", () => {
    const data: StatusLineData = {
      inputTokens: 1_200,
      outputTokens: 800,
      cacheRead: 0,
    };
    const config: StatusLineConfig = {
      cardStatusModel: false,
      cardStatusEffort: false,
      cardStatusAgent: false,
      cardStatusTokens: true,
    };
    expect(renderStatusLine(data, config)).toBe("↑1.2k ↓800");
  });

  it("omits cache parenthetical when cacheRead is undefined", () => {
    const data: StatusLineData = {
      inputTokens: 5_000,
      outputTokens: 2_000,
    };
    const config: StatusLineConfig = {
      cardStatusModel: false,
      cardStatusEffort: false,
      cardStatusAgent: false,
      cardStatusTokens: true,
    };
    expect(renderStatusLine(data, config)).toBe("↑5.0k ↓2.0k");
  });

  it("returns empty string when all segments disabled or empty", () => {
    const config: StatusLineConfig = {
      cardStatusModel: false,
      cardStatusEffort: false,
      cardStatusAgent: false,
    };
    expect(renderStatusLine({}, config)).toBe("");
  });

  it("skips segments whose data is missing even if enabled", () => {
    const config: StatusLineConfig = {
      cardStatusModel: true,
      cardStatusTaskTime: true,
      cardStatusTokens: true,
    };
    const data: StatusLineData = { model: "gpt-4o" };
    expect(renderStatusLine(data, config)).toBe("gpt-4o");
  });

  it("renders only model + tokens (minimal + tokens)", () => {
    const config: StatusLineConfig = {
      cardStatusModel: true,
      cardStatusEffort: false,
      cardStatusAgent: false,
      cardStatusTokens: true,
    };
    const data: StatusLineData = {
      model: "claude-sonnet-4-20250514",
      inputTokens: 12_500,
      outputTokens: 3_500,
      cacheRead: 8_100,
    };
    expect(renderStatusLine(data, config)).toBe(
      "claude-sonnet-4-20250514 | ↑12.5k(C:8.1k) ↓3.5k",
    );
  });
});
```

- [ ] **Step 5b: Run test to verify it fails**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/statusline-renderer.test.ts`
Expected: FAIL — renderStatusLine not exported

### Step 6: Implement `renderStatusLine`

- [ ] **Step 6a: Add types and renderStatusLine to statusline-renderer.ts**

```typescript
// Append to src/card/statusline-renderer.ts

export interface StatusLineData {
  model?: string;
  effort?: string;
  agent?: string;
  taskTime?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  dapi_usage?: number;
}

export interface StatusLineConfig {
  cardStatusModel?: boolean;
  cardStatusEffort?: boolean;
  cardStatusAgent?: boolean;
  cardStatusTaskTime?: boolean;
  cardStatusTokens?: boolean;
  cardStatusDapiUsage?: boolean;
}

interface Segment {
  configKey: keyof StatusLineConfig;
  defaultOn: boolean;
  render: (d: StatusLineData) => string | undefined;
}

function renderTokenSegment(data: StatusLineData): string | undefined {
  const parts: string[] = [];
  if (typeof data.inputTokens === "number") {
    let s = `↑${formatTokenCount(data.inputTokens)}`;
    if (typeof data.cacheRead === "number" && data.cacheRead > 0) {
      s += `(C:${formatTokenCount(data.cacheRead)})`;
    }
    parts.push(s);
  }
  if (typeof data.outputTokens === "number") {
    parts.push(`↓${formatTokenCount(data.outputTokens)}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

const SEGMENTS: Segment[] = [
  { configKey: "cardStatusModel",     defaultOn: true,  render: (d) => d.model || undefined },
  { configKey: "cardStatusEffort",    defaultOn: true,  render: (d) => d.effort || undefined },
  { configKey: "cardStatusAgent",     defaultOn: true,  render: (d) => d.agent || undefined },
  { configKey: "cardStatusTaskTime",  defaultOn: false, render: (d) => typeof d.taskTime === "number" ? formatDuration(d.taskTime) : undefined },
  { configKey: "cardStatusTokens",    defaultOn: false, render: renderTokenSegment },
  { configKey: "cardStatusDapiUsage", defaultOn: false, render: (d) => typeof d.dapi_usage === "number" ? `API×${d.dapi_usage}` : undefined },
];

export function renderStatusLine(data: StatusLineData, config: StatusLineConfig): string {
  return SEGMENTS
    .filter((seg) => config[seg.configKey] ?? seg.defaultOn)
    .map((seg) => seg.render(data))
    .filter(Boolean)
    .join(" | ");
}
```

- [ ] **Step 6b: Run tests to verify all pass**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/statusline-renderer.test.ts`
Expected: ALL PASS

- [ ] **Step 6c: Run type-check**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm run type-check`
Expected: PASS

### Step 7: Commit Task 1

- [ ] **Step 7: Commit**

```bash
git add src/card/statusline-renderer.ts tests/unit/statusline-renderer.test.ts
git commit -m "feat(card): add statusline-renderer with formatters and segment assembly"
```

---

## Task 2: Add `cardStatus*` config fields to Zod schema + manifest

**Files:**
- Modify: `src/config-schema.ts:21-159` (DingTalkAccountConfigShape)
- Modify: `openclaw.plugin.json` (schema + uiHints, both top-level and accounts)

### Step 1: Add Zod fields

- [ ] **Step 1a: Add 6 boolean fields to DingTalkAccountConfigShape**

In `src/config-schema.ts`, add after the `cardAtSender` field (line 158) and before the closing `} as const`:

```typescript
  /** Show model name in AI card status line footer. */
  cardStatusModel: z.boolean().optional().default(true),

  /** Show thinking effort level in AI card status line footer. */
  cardStatusEffort: z.boolean().optional().default(true),

  /** Show agent display name in AI card status line footer. */
  cardStatusAgent: z.boolean().optional().default(true),

  /** Show task elapsed time in AI card status line footer. */
  cardStatusTaskTime: z.boolean().optional().default(false),

  /** Show token usage summary (input/output/cache) in AI card status line footer. */
  cardStatusTokens: z.boolean().optional().default(false),

  /** Show DingTalk API call count in AI card status line footer. */
  cardStatusDapiUsage: z.boolean().optional().default(false),
```

- [ ] **Step 1b: Run type-check**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm run type-check`
Expected: PASS (DingTalkConfig type auto-infers from schema)

### Step 2: Add JSON Schema properties to openclaw.plugin.json

- [ ] **Step 2a: Add cardStatus* properties to top-level schema**

In `openclaw.plugin.json` → `channelConfigs.dingtalk.schema.properties`, add after `cardAtSender`:

```json
"cardStatusModel": {
  "type": "boolean",
  "default": true,
  "description": "Show model name in AI card status line footer."
},
"cardStatusEffort": {
  "type": "boolean",
  "default": true,
  "description": "Show thinking effort level in AI card status line footer."
},
"cardStatusAgent": {
  "type": "boolean",
  "default": true,
  "description": "Show agent display name in AI card status line footer."
},
"cardStatusTaskTime": {
  "type": "boolean",
  "default": false,
  "description": "Show task elapsed time in AI card status line footer."
},
"cardStatusTokens": {
  "type": "boolean",
  "default": false,
  "description": "Show token usage summary (input/output/cache) in AI card status line footer."
},
"cardStatusDapiUsage": {
  "type": "boolean",
  "default": false,
  "description": "Show DingTalk API call count in AI card status line footer."
}
```

- [ ] **Step 2b: Add same properties to accounts sub-schema**

In `openclaw.plugin.json` → `channelConfigs.dingtalk.schema.properties.accounts.additionalProperties.properties`, add the same 6 properties (identical JSON).

- [ ] **Step 2c: Add uiHints for all 6 fields**

In `openclaw.plugin.json` → `channelConfigs.dingtalk.uiHints`, add:

```json
"cardStatusModel": {
  "label": "Status: Model Name",
  "help": "Show the LLM model name in the AI card footer status line."
},
"cardStatusEffort": {
  "label": "Status: Thinking Effort",
  "help": "Show the thinking effort level (e.g. high, medium) in the AI card footer."
},
"cardStatusAgent": {
  "label": "Status: Agent Name",
  "help": "Show the agent display name in the AI card footer."
},
"cardStatusTaskTime": {
  "label": "Status: Task Time",
  "help": "Show elapsed task time in the AI card footer."
},
"cardStatusTokens": {
  "label": "Status: Token Usage",
  "help": "Show a compact token usage summary (input/output/cache) in the AI card footer."
},
"cardStatusDapiUsage": {
  "label": "Status: API Calls",
  "help": "Show the DingTalk API call count in the AI card footer."
}
```

### Step 3: Verify and commit

- [ ] **Step 3a: Run type-check + lint**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm run type-check && pnpm run lint`
Expected: PASS

- [ ] **Step 3b: Commit**

```bash
git add src/config-schema.ts openclaw.plugin.json
git commit -m "feat(config): add cardStatus* boolean toggles for statusline segments"
```

---

## Task 3: Wire `renderStatusLine` into `buildTaskInfoJson`

**Files:**
- Modify: `src/reply-strategy-card.ts:51-101` (buildTaskInfoJson)
- Test: `tests/unit/reply-strategy-card.test.ts` (add statusLine assertion)

### Step 1: Write failing test

- [ ] **Step 1a: Add test for statusLine in buildTaskInfoJson output**

The existing `tests/unit/reply-strategy-card.test.ts` tests the card strategy via `createCardReplyStrategy`. `buildTaskInfoJson` is a closure — test it indirectly through finalization. The test file uses `makeCard()`, `buildCtx()`, `commitAICardBlocksMock` (see lines 52-119 of the test file for patterns).

Add inside the existing `describe("reply-strategy-card", ...)` block:

```typescript
it("includes statusLine in taskInfoJson on finalize", async () => {
  const card = makeCard();
  const ctx = buildCtx(card, {
    taskMeta: { model: "claude-sonnet-4-20250514", effort: "high", agent: "TestBot" },
  });
  const strategy = createCardReplyStrategy(ctx);
  await strategy.deliver({ text: "Hello", mediaUrls: [], kind: "final" });
  await strategy.finalize();

  expect(commitAICardBlocksMock).toHaveBeenCalled();
  const taskInfoJson = commitAICardBlocksMock.mock.calls[0][1].taskInfoJson;
  const parsed = JSON.parse(taskInfoJson);
  expect(parsed.statusLine).toBe("claude-sonnet-4-20250514 | high | TestBot");
});
```

- [ ] **Step 1b: Run test to verify it fails**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/reply-strategy-card.test.ts`
Expected: FAIL — statusLine not present in taskInfoJson

### Step 2: Modify buildTaskInfoJson

- [ ] **Step 2a: Import renderStatusLine and wire it in**

In `src/reply-strategy-card.ts`, add import:

```typescript
import { renderStatusLine } from "./card/statusline-renderer";
import type { StatusLineData } from "./card/statusline-renderer";
```

In `buildTaskInfoJson()` (line 51-101), after the existing field assignments (line 98, after the token usage block closing brace), add:

```typescript
    // Assemble configurable statusline
    const statusLineData: StatusLineData = {
      model: info.model as string | undefined,
      effort: info.effort as string | undefined,
      agent: info.agent as string | undefined,
      taskTime: info.taskTime as number | undefined,
      inputTokens: info.inputTokens as number | undefined,
      outputTokens: info.outputTokens as number | undefined,
      cacheRead: info.cacheRead as number | undefined,
      dapi_usage: info.dapi_usage as number | undefined,
    };
    const statusLine = renderStatusLine(statusLineData, config);
    if (statusLine) { info.statusLine = statusLine; }
```

The `config` variable is already in scope — it's the `ctx.config` / `card.config` from the outer closure of `createCardReplyStrategy`.

- [ ] **Step 2b: Run test to verify it passes**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/reply-strategy-card.test.ts`
Expected: PASS

- [ ] **Step 2c: Run full test suite**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm test`
Expected: ALL PASS

### Step 3: Commit

- [ ] **Step 3: Commit**

```bash
git add src/reply-strategy-card.ts tests/unit/reply-strategy-card.test.ts
git commit -m "feat(card): wire renderStatusLine into buildTaskInfoJson"
```

---

## Task 4: Update card template to use `statusLine` variable

**Files:**
- Modify: `docs/assets/card-template-v2.json`

### Step 1: Add `statusLine` to template variable schema

- [ ] **Step 1a: Add statusLine string variable to taskInfo schema**

In the card template JSON, the taskInfo variable schema is defined inside `editorData`. Find the taskInfo schema array (contains `taskInfo.model`, `taskInfo.effort`, etc.) and append:

```json
{
  "id": "taskInfo.statusLine",
  "type": "string",
  "name": "statusLine",
  "private": false,
  "editorVarType": "variables",
  "description": "预渲染的状态行文本"
}
```

### Step 2: Replace hardcoded footer text with statusLine

- [ ] **Step 2a: Replace the model|effort|agent concat expression**

In the template, find the footer `BaseText` component that renders:

```
@concat{@toStr{@data{data.cardData.taskInfo.model}}, ' | ', @toStr{@data{data.cardData.taskInfo.effort}}, ' | ', @toStr{@data{data.cardData.taskInfo.agent}}}
```

Replace with:

```
@toStr{@data{data.cardData.taskInfo.statusLine}}
```

This appears in two places in the template (editor schema and widget rendering). Both must be updated.

Also update the `dynamicString` content from:
```
${taskInfo.model} | ${taskInfo.effort} | ${taskInfo.agent}
```
to:
```
${taskInfo.statusLine}
```

- [ ] **Step 2b: Update mock data**

In `docs/assets/card-data-mock-v2.json`, add `statusLine` to the taskInfo mock:

```json
"taskInfo": {
  "model": "gpt-5.4",
  "effort": "medium",
  "agent": "MyBot",
  "dapi_usage": 12,
  "taskTime": 45,
  "statusLine": "gpt-5.4 | medium | MyBot"
}
```

### Step 3: Commit

- [ ] **Step 3: Commit**

```bash
git add docs/assets/card-template-v2.json docs/assets/card-data-mock-v2.json
git commit -m "feat(card): use statusLine variable in card template footer"
```

---

## Task 5: Backward compatibility — early taskInfo updates before finalize

**Files:**
- Modify: `src/reply-strategy-card.ts:416-436` (onModelSelected callback)

### Context

`buildTaskInfoJson()` is called in two places:
1. **`onModelSelected`** (line 433) — early update when model/effort are known, before any LLM output
2. **`finalize()`** (line 697) — final update with all data including tokens and taskTime

The early call in `onModelSelected` won't have token data yet, but it should still render a statusLine with whatever data is available (model + effort + agent). This already works because `renderStatusLine` gracefully skips segments with missing data. No code change needed — just verify.

### Step 1: Write a test to verify early statusLine

- [ ] **Step 1a: Add test for early onModelSelected statusLine**

Add inside the existing `describe("reply-strategy-card", ...)` block:

```typescript
it("includes partial statusLine in early onModelSelected update", async () => {
  const card = makeCard();
  const ctx = buildCtx(card, {
    taskMeta: { model: "old-model", effort: "low", agent: "TestBot" },
  });
  const strategy = createCardReplyStrategy(ctx);
  const opts = strategy.getReplyOptions();

  // Trigger onModelSelected — this calls buildTaskInfoJson() + updateAICardTaskInfo()
  opts.onModelSelected?.({ model: "claude-sonnet-4-20250514", thinkLevel: "high" });

  expect(updateAICardTaskInfoMock).toHaveBeenCalled();
  const taskInfoJson = updateAICardTaskInfoMock.mock.calls[0][1];
  const parsed = JSON.parse(taskInfoJson);
  // Early update has model + effort + agent but no tokens or taskTime
  expect(parsed.statusLine).toBe("claude-sonnet-4-20250514 | high | TestBot");
  expect(parsed.statusLine).not.toContain("↑");
});
```

- [ ] **Step 1b: Run test**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm vitest run tests/unit/reply-strategy-card.test.ts`
Expected: PASS (no code change needed — renderStatusLine handles partial data)

### Step 2: Commit

- [ ] **Step 2: Commit**

```bash
git add tests/unit/reply-strategy-card.test.ts
git commit -m "test(card): verify early statusLine in onModelSelected update"
```

---

## Task 6: Full integration verification

**Files:**
- No new files — verification only

### Step 1: Run full test suite

- [ ] **Step 1: Run all tests**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm test`
Expected: ALL PASS

### Step 2: Run type-check + lint

- [ ] **Step 2: Type-check and lint**

Run: `cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/card-template-v2 && pnpm run type-check && pnpm run lint`
Expected: PASS

### Step 3: Manual verification checklist

- [ ] **Step 3a: Verify default behavior is backward-compatible**

With no `cardStatus*` fields in config, the statusline should render `model | effort | agent` — identical to the current hardcoded behavior.

- [ ] **Step 3b: Verify token format**

With `cardStatusTokens: true` and token data `{ input: 45200, output: 28700, cacheRead: 32100 }`, the statusline should include `↑45.2k(C:32.1k) ↓28.7k`.

- [ ] **Step 3c: Verify config fields render in WebUI**

The 6 `cardStatus*` boolean fields should appear as toggle switches in the OpenClaw WebUI config panel under the DingTalk channel settings.

---

## Summary

| Task | What | Commit message |
|------|------|----------------|
| 1 | `statusline-renderer.ts` — formatters + renderStatusLine | `feat(card): add statusline-renderer with formatters and segment assembly` |
| 2 | Zod schema + manifest `cardStatus*` booleans | `feat(config): add cardStatus* boolean toggles for statusline segments` |
| 3 | Wire renderer into `buildTaskInfoJson` | `feat(card): wire renderStatusLine into buildTaskInfoJson` |
| 4 | Card template uses `${taskInfo.statusLine}` | `feat(card): use statusLine variable in card template footer` |
| 5 | Backward compat test for early updates | `test(card): verify early statusLine in onModelSelected update` |
| 6 | Full integration verification | (no commit — verification only) |
