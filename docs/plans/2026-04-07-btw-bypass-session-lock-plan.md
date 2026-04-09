# `/btw` Bypass Session Lock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/btw <question>` work in dingtalk channel by detecting it before `acquireSessionLock` and dispatching it directly, mirroring the existing `/stop` bypass branch. BTW reply is always delivered as independent markdown with a `> [<sender>: ]/btw <question>` blockquote header.

**Architecture:** Add a new bypass branch in `inbound-handler.ts` immediately after the `/stop` branch. Detection uses a soft-imported `isBtwRequestText` from `openclaw/plugin-sdk/reply-runtime` (guarded by `typeof === "function"` so old openclaw versions degrade gracefully). Delivery is factored into a new `src/messaging/btw-deliver.ts` module with two pure helpers (`buildBtwBlockquote`) and one delivery function (`deliverBtwReply`).

**Tech Stack:** TypeScript strict, vitest, oxlint/oxfmt, openclaw plugin-sdk peer dep.

**Spec:** `docs/plans/2026-04-07-btw-bypass-session-lock-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/messaging/btw-deliver.ts` | **Create** | Pure `buildBtwBlockquote` helper + `deliverBtwReply` send function. No card APIs. ~80 lines. |
| `tests/unit/btw-deliver.test.ts` | **Create** | Unit tests for blockquote builder + deliverBtwReply (mocked send-service). |
| `src/inbound-handler.ts` | **Modify** | Add `isBtwRequestText` soft import (line 2 area). Add BTW bypass branch after the `/stop` branch (~line 1437). |
| `tests/unit/inbound-handler.btw-bypass.test.ts` | **Create** | Unit test asserting session lock NOT acquired on `/btw`, soft-import degradation, mention stripping. |
| `tests/integration/inbound-btw.test.ts` | **Create** | Integration: `/btw` arrives while a fake main lock is held by another caller, BTW dispatches without waiting. |
| `TODO.md` | **Modify** | Add 验证 TODO checklist for real-device testing. |

Each task below is self-contained: write the test, watch it fail, write the minimum code, watch it pass, commit.

---

## Task 1: `buildBtwBlockquote` helper — happy path

**Files:**
- Create: `src/messaging/btw-deliver.ts`
- Create: `tests/unit/btw-deliver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/btw-deliver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildBtwBlockquote } from "../../src/messaging/btw-deliver";

describe("buildBtwBlockquote", () => {
  it("formats a normal /btw question with sender prefix", () => {
    const result = buildBtwBlockquote("王滨", "/btw 这个函数为什么慢");
    expect(result).toBe("> 王滨: /btw 这个函数为什么慢\n\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/unit/btw-deliver.test.ts
```

Expected: FAIL — `Cannot find module '../../src/messaging/btw-deliver'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/messaging/btw-deliver.ts`:

```ts
export function buildBtwBlockquote(senderName: string, rawQuestion: string): string {
  const senderPrefix = senderName ? `${senderName}: ` : "";
  return `> ${senderPrefix}${rawQuestion}\n\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run tests/unit/btw-deliver.test.ts
```

Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/messaging/btw-deliver.ts tests/unit/btw-deliver.test.ts
git commit -m "feat(btw): buildBtwBlockquote skeleton with sender prefix"
```

---

## Task 2: `buildBtwBlockquote` — empty sender, mention stripping, truncation

**Files:**
- Modify: `src/messaging/btw-deliver.ts`
- Modify: `tests/unit/btw-deliver.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/btw-deliver.test.ts` inside the same `describe` block:

```ts
  it("omits sender prefix when senderName is empty", () => {
    const result = buildBtwBlockquote("", "/btw foo");
    expect(result).toBe("> /btw foo\n\n");
  });

  it("strips a single leading @mention", () => {
    const result = buildBtwBlockquote("王滨", "@Bot /btw foo");
    expect(result).toBe("> 王滨: /btw foo\n\n");
  });

  it("strips multiple leading @mentions", () => {
    const result = buildBtwBlockquote("王滨", "@Bot @Other /btw foo");
    expect(result).toBe("> 王滨: /btw foo\n\n");
  });

  it("truncates question over 80 characters with ellipsis", () => {
    const longQuestion = "/btw " + "a".repeat(200);
    const result = buildBtwBlockquote("王滨", longQuestion);
    // 80 chars (including "/btw " prefix) + …
    expect(result.startsWith("> 王滨: ")).toBe(true);
    expect(result).toContain("…\n\n");
    // The cleaned question portion (after "> 王滨: ") should be exactly 80 chars + …\n\n
    const inner = result.slice("> 王滨: ".length, -2); // strip "\n\n"
    expect(inner).toHaveLength(81); // 80 + …
    expect(inner.endsWith("…")).toBe(true);
  });

  it("does not truncate question at exactly 80 characters", () => {
    const exact80 = "/btw " + "a".repeat(75); // total 80 chars
    const result = buildBtwBlockquote("王滨", exact80);
    expect(result).toBe(`> 王滨: ${exact80}\n\n`);
    expect(result).not.toContain("…");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run tests/unit/btw-deliver.test.ts
```

Expected: 4 FAIL (mention stripping, truncation), 2 PASS (happy path, empty sender — empty sender already passes by accident).

- [ ] **Step 3: Update implementation**

Replace the contents of `src/messaging/btw-deliver.ts` with:

```ts
const MAX_QUESTION_LENGTH = 80;
const LEADING_MENTIONS_RE = /^(?:@\S+\s+)*/u;

export function buildBtwBlockquote(senderName: string, rawQuestion: string): string {
  const stripped = rawQuestion.replace(LEADING_MENTIONS_RE, "");
  const truncated =
    stripped.length > MAX_QUESTION_LENGTH ? `${stripped.slice(0, MAX_QUESTION_LENGTH)}…` : stripped;
  const senderPrefix = senderName ? `${senderName}: ` : "";
  return `> ${senderPrefix}${truncated}\n\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run tests/unit/btw-deliver.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/messaging/btw-deliver.ts tests/unit/btw-deliver.test.ts
git commit -m "feat(btw): mention stripping and 80-char truncation in blockquote"
```

---

## Task 3: `deliverBtwReply` — sessionWebhook path

**Files:**
- Modify: `src/messaging/btw-deliver.ts`
- Modify: `tests/unit/btw-deliver.test.ts`

**Context:** `sendBySession(config, sessionWebhook, text, opts)` is the existing API in `src/send-service.ts:42` import. It returns `{ ok: boolean; error?: string }`.

- [ ] **Step 1: Write failing test**

Append to `tests/unit/btw-deliver.test.ts`:

```ts
import { vi } from "vitest";

vi.mock("../../src/send-service", () => ({
  sendBySession: vi.fn(async () => ({ ok: true })),
  sendMessage: vi.fn(async () => ({ ok: true })),
}));

import { deliverBtwReply } from "../../src/messaging/btw-deliver";
import { sendBySession, sendMessage } from "../../src/send-service";

describe("deliverBtwReply", () => {
  beforeEach(() => {
    vi.mocked(sendBySession).mockClear();
    vi.mocked(sendMessage).mockClear();
  });

  it("uses sendBySession when sessionWebhook is provided", async () => {
    const result = await deliverBtwReply({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?token=abc",
      conversationId: "cidXXX",
      to: "userA",
      senderName: "王滨",
      rawQuestion: "/btw foo",
      replyText: "the answer",
      log: undefined,
    });

    expect(result.ok).toBe(true);
    expect(sendBySession).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    const call = vi.mocked(sendBySession).mock.calls[0];
    expect(call[2]).toBe("> 王滨: /btw foo\n\nthe answer");
  });
});
```

Note: `beforeEach` needs to be imported: add `beforeEach` to the existing `import { describe, expect, it } from "vitest"` line.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run tests/unit/btw-deliver.test.ts -t "sendBySession"
```

Expected: FAIL — `deliverBtwReply` not exported.

- [ ] **Step 3: Implement `deliverBtwReply`**

Append to `src/messaging/btw-deliver.ts`:

```ts
import { sendBySession, sendMessage } from "../send-service";
import type { DingTalkConfig, Logger } from "../types";

export interface DeliverBtwReplyArgs {
  config: DingTalkConfig;
  sessionWebhook: string | undefined;
  conversationId: string;
  to: string;
  senderName: string;
  rawQuestion: string;
  replyText: string;
  log: Logger | undefined;
  accountId?: string;
  storePath?: string;
}

export async function deliverBtwReply(
  args: DeliverBtwReplyArgs,
): Promise<{ ok: boolean; error?: string }> {
  const blockquote = buildBtwBlockquote(args.senderName, args.rawQuestion);
  const fullText = `${blockquote}${args.replyText}`;

  try {
    if (args.sessionWebhook) {
      return await sendBySession(args.config, args.sessionWebhook, fullText, {
        log: args.log,
        accountId: args.accountId,
        storePath: args.storePath,
      });
    }
    return await sendMessage(args.config, args.to, fullText, {
      log: args.log,
      accountId: args.accountId,
      storePath: args.storePath,
      conversationId: args.conversationId,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    args.log?.warn?.(`[DingTalk] BTW reply delivery failed: ${error}`);
    return { ok: false, error };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run tests/unit/btw-deliver.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/messaging/btw-deliver.ts tests/unit/btw-deliver.test.ts
git commit -m "feat(btw): deliverBtwReply with sendBySession path"
```

---

## Task 4: `deliverBtwReply` — proactive sendMessage fallback + send failure handling

**Files:**
- Modify: `tests/unit/btw-deliver.test.ts`

The implementation already supports both paths (Task 3). This task only adds the missing test coverage.

- [ ] **Step 1: Write failing tests**

Append to the `describe("deliverBtwReply", ...)` block:

```ts
  it("uses sendMessage when sessionWebhook is undefined", async () => {
    const result = await deliverBtwReply({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      sessionWebhook: undefined,
      conversationId: "cidXXX",
      to: "userA",
      senderName: "",
      rawQuestion: "/btw bar",
      replyText: "answer",
      log: undefined,
    });

    expect(result.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendBySession).not.toHaveBeenCalled();
    expect(vi.mocked(sendMessage).mock.calls[0][2]).toBe("> /btw bar\n\nanswer");
  });

  it("returns ok=false when send throws", async () => {
    vi.mocked(sendBySession).mockRejectedValueOnce(new Error("network down"));
    const result = await deliverBtwReply({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      sessionWebhook: "https://example",
      conversationId: "cidXXX",
      to: "userA",
      senderName: "王滨",
      rawQuestion: "/btw foo",
      replyText: "answer",
      log: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
pnpm vitest run tests/unit/btw-deliver.test.ts
```

Expected: PASS (9 tests). Implementation already supports both paths from Task 3.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/btw-deliver.test.ts
git commit -m "test(btw): cover sendMessage path and send failure"
```

---

## Task 5: Soft import `isBtwRequestText` in inbound-handler

**Files:**
- Modify: `src/inbound-handler.ts:2`

- [ ] **Step 1: Update the import**

Change `src/inbound-handler.ts:2` from:

```ts
import { isAbortRequestText } from "openclaw/plugin-sdk/reply-runtime";
```

to:

```ts
import { isAbortRequestText, isBtwRequestText } from "openclaw/plugin-sdk/reply-runtime";
```

- [ ] **Step 2: Type-check**

```bash
pnpm run type-check
```

Expected: PASS. (`isBtwRequestText` is exported from `openclaw/src/plugin-sdk/reply-runtime.ts:32`.)

- [ ] **Step 3: Commit**

```bash
git add src/inbound-handler.ts
git commit -m "feat(btw): import isBtwRequestText from plugin-sdk"
```

---

## Task 6: BTW bypass branch in inbound-handler — first failing test

**Files:**
- Create: `tests/unit/inbound-handler.btw-bypass.test.ts`

**Context:** The bypass branch will be inserted right after the abort branch's `return;` at `inbound-handler.ts:1437`. Before adding it, write a test that asserts current behavior (acquireSessionLock IS called for `/btw`) — this becomes our regression baseline. Then we'll add the branch and the test inverts.

- [ ] **Step 1: Skim the existing abort bypass test for the pattern**

```bash
pnpm vitest run tests/unit/ -t "Abort" 2>&1 | grep -E "^\s*(✓|✗|✘)" | head -10
```

Find an existing test file (e.g., `tests/unit/inbound-handler.test.ts`) that already mocks `acquireSessionLock` and `dispatchReplyWithBufferedBlockDispatcher`. Reuse the mock setup pattern verbatim. If no existing test mocks these symbols, copy the mock structure from the abort branch tests.

Run:

```bash
pnpm vitest run tests/unit/inbound-handler.test.ts -t "abort" 2>&1 | tail -20
```

If abort tests exist, read them:

```bash
grep -n "acquireSessionLock\|dispatchReplyWithBufferedBlockDispatcher\|isAbortRequestText" tests/unit/inbound-handler.test.ts
```

Use the shape they establish.

- [ ] **Step 2: Write the failing test for BTW bypass**

Create `tests/unit/inbound-handler.btw-bypass.test.ts`. Use the same imports and `vi.mock(...)` setup as the existing abort test in `tests/unit/inbound-handler.test.ts`. The test asserts:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// MIRROR the mock setup from tests/unit/inbound-handler.test.ts here.
// Specifically, mock these modules:
//   - "openclaw/plugin-sdk/reply-runtime" — provide both isAbortRequestText and isBtwRequestText as vi.fn()
//   - "../../src/session-lock" — acquireSessionLock as vi.fn()
//   - "../../src/messaging/btw-deliver" — deliverBtwReply as vi.fn(async () => ({ ok: true }))
//   - any other modules the existing abort test mocks (config loader, runtime, etc.)

import { isBtwRequestText, isAbortRequestText } from "openclaw/plugin-sdk/reply-runtime";
import { acquireSessionLock } from "../../src/session-lock";
import { deliverBtwReply } from "../../src/messaging/btw-deliver";
import { handleInboundMessage } from "../../src/inbound-handler"; // or whichever export exists

describe("inbound-handler /btw bypass", () => {
  beforeEach(() => {
    vi.mocked(isAbortRequestText).mockReturnValue(false);
    vi.mocked(isBtwRequestText).mockReturnValue(true);
    vi.mocked(acquireSessionLock).mockResolvedValue(() => {});
    vi.mocked(deliverBtwReply).mockResolvedValue({ ok: true });
  });

  it("does NOT acquire session lock when /btw is matched", async () => {
    // Build a minimal inbound message fixture using the same helper that existing
    // inbound-handler tests use. Copy verbatim from tests/unit/inbound-handler.test.ts.
    // Then call handleInboundMessage(...).
    await invokeWithFakeInbound("/btw foo");
    expect(acquireSessionLock).not.toHaveBeenCalled();
  });
});
```

**Important:** The test fixture (`invokeWithFakeInbound` or whatever name the existing tests use) is project-specific. Read `tests/unit/inbound-handler.test.ts` first and **copy the existing helper verbatim** rather than inventing a new one. If the existing tests use inline construction, do the same.

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm vitest run tests/unit/inbound-handler.btw-bypass.test.ts -t "does NOT acquire session lock"
```

Expected: FAIL — currently `acquireSessionLock` IS called for `/btw` because the bypass branch doesn't exist yet.

- [ ] **Step 4: Add the BTW bypass branch in `inbound-handler.ts`**

Locate the abort branch's closing `return;` at `src/inbound-handler.ts:1436` (the `return;` inside `if (isAbortRequestText(textForAbortCheck)) { ... return; }`). Immediately after the closing `}` of that if-block (line 1437), insert:

```ts
  // ---- Pre-lock BTW: bypass session lock for /btw side questions ----
  // /btw runs an isolated, tool-less side query in openclaw without polluting
  // the main run's transcript. The dispatch must NOT acquire the session lock,
  // otherwise it would queue behind the in-flight main task and lose its "side
  // question" semantics.
  //
  // isBtwRequestText is soft-imported: older openclaw versions do not export it,
  // in which case the typeof guard skips the bypass and the message falls through
  // to the normal session-lock path (degraded UX, no crash).
  const textForBtwCheck = inboundText.replace(/^(?:@\S+\s+)*/u, "").trim();
  if (typeof isBtwRequestText === "function" && isBtwRequestText(textForBtwCheck)) {
    log?.info?.(
      `[DingTalk] BTW request detected, bypassing session lock for session=${route.sessionKey}`,
    );
    const btwSenderName = data.senderNick || "";
    try {
      await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg,
        dispatcherOptions: {
          responsePrefix: "",
          deliver: async (payload) => {
            if (!payload.text) {
              log?.debug?.(`[DingTalk] BTW deliver received non-text payload, skipping`);
              return;
            }
            await deliverBtwReply({
              config: dingtalkConfig,
              sessionWebhook,
              conversationId: groupId,
              to,
              senderName: btwSenderName,
              rawQuestion: inboundText,
              replyText: payload.text,
              log,
              accountId,
              storePath: accountStorePath,
            });
          },
        },
      });
    } catch (btwErr) {
      log?.warn?.(`[DingTalk] BTW dispatch failed: ${getErrorMessage(btwErr)}`);
    }
    return;
  }
```

Add the import at the top of `src/inbound-handler.ts` (in the existing imports area, near line 42):

```ts
import { deliverBtwReply } from "./messaging/btw-deliver";
```

**Verify the closure variables exist at the insertion point.** Read `inbound-handler.ts` lines 1366-1437 (the abort branch) and confirm these are in scope: `inboundText`, `route`, `log`, `data`, `dingtalkConfig`, `sessionWebhook`, `groupId`, `to`, `accountId`, `accountStorePath`, `ctx`, `cfg`, `rt`, `getErrorMessage`. They should all be — abort branch uses the same set. If any name differs in the actual code, **rename in the snippet to match**, do not invent new variables.

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm vitest run tests/unit/inbound-handler.btw-bypass.test.ts
```

Expected: PASS.

- [ ] **Step 6: Type-check + lint**

```bash
pnpm run type-check && pnpm run lint
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/inbound-handler.ts tests/unit/inbound-handler.btw-bypass.test.ts
git commit -m "feat(btw): bypass session lock for /btw side questions"
```

---

## Task 7: BTW bypass — verify dispatcher called and deliverBtwReply invoked

**Files:**
- Modify: `tests/unit/inbound-handler.btw-bypass.test.ts`

- [ ] **Step 1: Write failing test**

Append to the same `describe` block in `tests/unit/inbound-handler.btw-bypass.test.ts`:

```ts
  it("dispatches via dispatchReplyWithBufferedBlockDispatcher with a custom deliver", async () => {
    // Mock rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher to capture the deliver callback
    const dispatchSpy = vi.fn(async ({ dispatcherOptions }: any) => {
      // Simulate openclaw streaming back a payload
      await dispatcherOptions.deliver({ text: "side answer" });
    });
    // Wire dispatchSpy into the runtime mock — pattern depends on existing test helper.
    // Reuse the same approach the abort test uses for spying on dispatch.

    await invokeWithFakeInbound("/btw foo", { senderNick: "王滨" });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(deliverBtwReply).toHaveBeenCalledTimes(1);
    const call = vi.mocked(deliverBtwReply).mock.calls[0][0];
    expect(call.senderName).toBe("王滨");
    expect(call.rawQuestion).toBe("/btw foo");
    expect(call.replyText).toBe("side answer");
  });
```

- [ ] **Step 2: Run test**

```bash
pnpm vitest run tests/unit/inbound-handler.btw-bypass.test.ts -t "dispatches via"
```

Expected: PASS (the bypass branch from Task 6 already calls both).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/inbound-handler.btw-bypass.test.ts
git commit -m "test(btw): assert dispatch + deliverBtwReply wiring"
```

---

## Task 8: BTW bypass — soft-import degradation

**Files:**
- Modify: `tests/unit/inbound-handler.btw-bypass.test.ts`

- [ ] **Step 1: Write failing test**

Append:

```ts
  it("falls through to normal path when isBtwRequestText is undefined (old openclaw)", async () => {
    // Override the mock for this single test
    vi.mocked(isBtwRequestText).mockImplementation(undefined as unknown as () => boolean);
    // Some test runners reject reassigning to undefined; alternative:
    // vi.doMock("openclaw/plugin-sdk/reply-runtime", () => ({
    //   isAbortRequestText: vi.fn(() => false),
    //   isBtwRequestText: undefined,
    // }));
    // Use whichever pattern works in the existing test infrastructure.

    await invokeWithFakeInbound("/btw foo");
    expect(acquireSessionLock).toHaveBeenCalledTimes(1);
    expect(deliverBtwReply).not.toHaveBeenCalled();
  });
```

**Note:** if module-level reassignment is awkward in the test runner, use `vi.doMock` at the top of the test file with a flag, or split into a second test file with a different module mock. Pick whichever the existing test infrastructure supports — do not fight the test runner.

- [ ] **Step 2: Run test**

```bash
pnpm vitest run tests/unit/inbound-handler.btw-bypass.test.ts -t "falls through"
```

Expected: PASS — `typeof isBtwRequestText === "function"` is `false`, branch is skipped, normal path runs.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/inbound-handler.btw-bypass.test.ts
git commit -m "test(btw): soft-import degradation for old openclaw"
```

---

## Task 9: BTW bypass — mention stripping in detection

**Files:**
- Modify: `tests/unit/inbound-handler.btw-bypass.test.ts`

- [ ] **Step 1: Write failing test**

```ts
  it("matches /btw even with leading @mention (group chat)", async () => {
    // The bypass branch strips @mentions before passing to isBtwRequestText.
    // Verify by checking the isBtwRequestText spy receives the cleaned text.
    vi.mocked(isBtwRequestText).mockClear();
    vi.mocked(isBtwRequestText).mockReturnValue(true);

    await invokeWithFakeInbound("@Bot /btw foo");
    expect(isBtwRequestText).toHaveBeenCalledWith("/btw foo");
    expect(acquireSessionLock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test**

```bash
pnpm vitest run tests/unit/inbound-handler.btw-bypass.test.ts -t "leading @mention"
```

Expected: PASS — Task 6's `textForBtwCheck = inboundText.replace(/^(?:@\S+\s+)*/u, "").trim();` strips the mention before the function call.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/inbound-handler.btw-bypass.test.ts
git commit -m "test(btw): assert mention stripping before detection"
```

---

## Task 10: BTW bypass — abort wins over BTW

**Files:**
- Modify: `tests/unit/inbound-handler.btw-bypass.test.ts`

- [ ] **Step 1: Write failing test**

```ts
  it("abort branch runs before BTW branch", async () => {
    vi.mocked(isAbortRequestText).mockReturnValue(true);
    vi.mocked(isBtwRequestText).mockReturnValue(true);

    await invokeWithFakeInbound("/stop");

    // Abort branch returns early — BTW deliver must NOT be invoked
    expect(deliverBtwReply).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test**

```bash
pnpm vitest run tests/unit/inbound-handler.btw-bypass.test.ts -t "abort branch runs before"
```

Expected: PASS — abort branch is structurally before BTW branch and returns.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/inbound-handler.btw-bypass.test.ts
git commit -m "test(btw): assert abort branch precedence"
```

---

## Task 11: BTW bypass — empty payload skipped

**Files:**
- Modify: `tests/unit/inbound-handler.btw-bypass.test.ts`

- [ ] **Step 1: Write failing test**

```ts
  it("skips delivery when payload.text is empty", async () => {
    // Configure dispatch mock to deliver an empty payload
    const dispatchSpy = vi.fn(async ({ dispatcherOptions }: any) => {
      await dispatcherOptions.deliver({ text: "" });
    });
    // Wire dispatchSpy in via the same mechanism as Task 7

    await invokeWithFakeInbound("/btw foo");
    expect(deliverBtwReply).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test**

```bash
pnpm vitest run tests/unit/inbound-handler.btw-bypass.test.ts -t "skips delivery when payload"
```

Expected: PASS — Task 6's `if (!payload.text) { ...; return; }` short-circuits.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/inbound-handler.btw-bypass.test.ts
git commit -m "test(btw): skip delivery for empty payload"
```

---

## Task 12: BTW bypass — dispatcher throw is caught

**Files:**
- Modify: `tests/unit/inbound-handler.btw-bypass.test.ts`

- [ ] **Step 1: Write failing test**

```ts
  it("catches and logs dispatcher errors without re-throwing", async () => {
    const dispatchSpy = vi.fn(async () => {
      throw new Error("dispatcher boom");
    });
    // Wire dispatchSpy in

    await expect(invokeWithFakeInbound("/btw foo")).resolves.not.toThrow();
    expect(deliverBtwReply).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test**

```bash
pnpm vitest run tests/unit/inbound-handler.btw-bypass.test.ts -t "catches and logs dispatcher"
```

Expected: PASS — Task 6's `try { ... } catch (btwErr) { log?.warn?.(...); }` swallows.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/inbound-handler.btw-bypass.test.ts
git commit -m "test(btw): swallow dispatcher errors"
```

---

## Task 13: Integration test — BTW arrives while main lock held

**Files:**
- Create: `tests/integration/inbound-btw.test.ts`

**Context:** Use the existing integration test pattern from `tests/integration/`. Find the most similar one (probably `tests/integration/inbound-handler.*.test.ts` if present) and follow its setup verbatim.

- [ ] **Step 1: Find a template**

```bash
ls tests/integration/ | head -20
```

Pick the closest existing inbound integration test as a template. Read its full setup once.

- [ ] **Step 2: Write the test**

Create `tests/integration/inbound-btw.test.ts`. Reuse the chosen template's bootstrap (config, runtime, send-service mocks). Add a test that:

1. Acquires `acquireSessionLock(sessionKey)` from a "fake main run" (do not release)
2. Triggers `handleInboundMessage` with a `/btw foo` message on the same `sessionKey`
3. Asserts `deliverBtwReply` was called within a short timeout (e.g., 100ms)
4. Asserts the main lock is still held (was never touched by BTW)

```ts
import { describe, expect, it, vi } from "vitest";
import { acquireSessionLock } from "../../src/session-lock";
// ...other imports per template

describe("inbound /btw integration", () => {
  it("dispatches /btw without waiting for held session lock", async () => {
    const release = await acquireSessionLock("session:cidXXX");
    try {
      // Trigger inbound /btw on the same session
      const start = Date.now();
      await invokeRealInboundPipeline("/btw foo", { sessionKey: "session:cidXXX" });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500); // No lock-wait stall
      // Assert deliverBtwReply was called (mock the module)
    } finally {
      release();
    }
  });
});
```

The exact `invokeRealInboundPipeline` helper name depends on the template; use whatever the chosen template uses.

- [ ] **Step 3: Run test**

```bash
pnpm vitest run tests/integration/inbound-btw.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/inbound-btw.test.ts
git commit -m "test(btw): integration test for lock bypass under contention"
```

---

## Task 14: Real-device 验证 TODO

**Files:**
- Modify: `TODO.md`

- [ ] **Step 1: Read existing TODO format**

```bash
head -50 TODO.md
```

Match the existing entry style.

- [ ] **Step 2: Append BTW验证 entry**

Add a new section to `TODO.md` (preserve existing entries):

```markdown
## /btw bypass session lock — 验证 TODO (PR #TBD)

- [ ] DM `/btw 这个函数为什么慢` while bot is idle → blockquote + answer rendered correctly
- [ ] DM `/btw <question>` while a main run is in PROCESSING → BTW answer arrives without waiting for main run
- [ ] Group `@Bot /btw <question>` while main run in PROCESSING → mention stripped from blockquote, sender nickname displayed
- [ ] `/btw` (no question) → openclaw usage error rendered with `> [<sender>: ]/btw` blockquote prefix
- [ ] Long question (> 80 chars) → blockquote shows truncated form with `…`
- [ ] After upgrading to openclaw with `isBtwRequestText` exported, BTW activates without channel config change
- [ ] On older openclaw (no `isBtwRequestText`), `/btw` is treated as normal chat (degraded but no crash)
```

- [ ] **Step 3: Commit**

```bash
git add TODO.md
git commit -m "docs(btw): real-device 验证 TODO checklist"
```

---

## Task 15: Full test suite + lint + format gate

**Files:**
- (none — verification only)

- [ ] **Step 1: Run full test suite**

```bash
pnpm test 2>&1 | tail -20
```

Expected: all tests pass, no regressions in the existing 856-test baseline (now should be ~870+).

- [ ] **Step 2: Type-check**

```bash
pnpm run type-check
```

Expected: PASS.

- [ ] **Step 3: Lint**

```bash
pnpm run lint
```

Expected: PASS.

- [ ] **Step 4: Format check**

```bash
pnpm run format
```

If files were reformatted, commit the formatting changes:

```bash
git add -u
git commit -m "style: oxfmt"
```

- [ ] **Step 5: Final review of git log**

```bash
git log --oneline main..HEAD
```

Verify the commit history reads as a clean, reviewable sequence.

---

## Done

After all tasks complete, the branch is ready for the `superpowers:finishing-a-development-branch` skill to handle PR creation and the contributor real-device handoff.
