# DingTalk Plugin Debug Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a plugin-owned DingTalk debug logging path that mirrors plugin-side `debug` messages to stdout and per-account files under the plugin store root without changing current `info` / `warn` / `error` behavior or forcing broad logging API churn.

**Architecture:** Introduce a single debug wrapper in `src/utils.ts` that implements the current `Logger`-compatible sink shape and owns plugin-side debug persistence. Create and inject that wrapper in `gateway.startAccount`, then rely on `logger-context` / `getLogger()` to carry the plugin-owned sink through existing downstream paths instead of explicitly rewiring every action and outbound entry point.

**Tech Stack:** TypeScript, Node.js `fs` / `path`, Vitest, existing DingTalk config and gateway lifecycle code.

---

### Task 1: Lock the debug wrapper contract with failing unit tests

**Files:**
- Modify: `tests/unit/utils.test.ts`
- Read: `src/utils.ts`
- Read: `src/types.ts`

- [ ] **Step 1: Write the failing tests for the new wrapper**

Add focused tests that define the target behavior:

```ts
import {
    closePluginDebugLog,
    resolvePluginDebugLog,
} from "../../src/utils";

it("writes plugin debug lines to stdout and the per-account daily log file when debug is enabled", () => {
    const baseLog = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const pluginLog = resolvePluginDebugLog({
        accountId: "main",
        storePath,
        debug: true,
        baseLog,
        now: new Date("2026-04-02T07:04:05.123Z"),
    });

    pluginLog.debug?.("[DingTalk] test line");

    expect(readFileSync(expectedLogFile, "utf8")).toContain("[account:main] [DingTalk] test line");
    expect(baseLog.debug).toHaveBeenCalledWith("[DingTalk] test line");
});

it("skips file creation when debug is disabled and only forwards to upstream debug", () => {
    const baseLog = { debug: vi.fn(), warn: vi.fn() };
    const pluginLog = resolvePluginDebugLog({
        accountId: "main",
        storePath,
        debug: false,
        baseLog,
    });

    pluginLog.debug?.("disabled path");

    expect(baseLog.debug).toHaveBeenCalledWith("disabled path");
    expect(existsSync(expectedLogFile)).toBe(false);
});
```

- [ ] **Step 2: Run the focused unit test and confirm it fails**

Run: `pnpm test tests/unit/utils.test.ts`

Expected: FAIL because `resolvePluginDebugLog` and `closePluginDebugLog` do not exist yet.

- [ ] **Step 3: Implement the minimal wrapper in `src/utils.ts`**

Implement only the minimum needed to satisfy the new tests:

- build a wrapper compatible with the current log sink shape
- format a single debug line for stdout and file output
- derive the file path from `path.dirname(storePath)/logs/dingtalk/<accountId>/debug-YYYY-MM-DD.log`
- no-op file persistence when `storePath` is missing
- provide an explicit close helper for cached writers

- [ ] **Step 4: Re-run the focused unit test**

Run: `pnpm test tests/unit/utils.test.ts`

Expected: PASS.

### Task 2: Harden the wrapper with failure-path and lifecycle tests

**Files:**
- Modify: `tests/unit/utils.test.ts`
- Modify: `src/utils.ts`

- [ ] **Step 1: Add failing tests for degraded paths**

Add tests for:

- file append failure only warns once
- missing `storePath` still writes stdout and does not throw
- `info` / `warn` / `error` only forward upstream and do not persist
- calling `closePluginDebugLog` allows a fresh writer to be created later

Suggested test shape:

```ts
it("warns once and keeps debug forwarding when file persistence fails", () => {
    const baseLog = { debug: vi.fn(), warn: vi.fn() };
    const pluginLog = resolvePluginDebugLog({
        accountId: "main",
        storePath,
        debug: true,
        baseLog,
        fsImpl: failingFs,
    });

    pluginLog.debug?.("one");
    pluginLog.debug?.("two");

    expect(baseLog.warn).toHaveBeenCalledTimes(1);
    expect(baseLog.debug).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the focused unit test and confirm the new cases fail first**

Run: `pnpm test tests/unit/utils.test.ts`

Expected: FAIL on the newly added assertions.

- [ ] **Step 3: Extend the implementation just enough to pass**

Add:

- per-writer failure memoization to suppress warning spam
- safe stdout and file-write guards
- explicit close-and-evict behavior for the writer registry

- [ ] **Step 4: Re-run the focused unit test**

Run: `pnpm test tests/unit/utils.test.ts`

Expected: PASS.

### Task 3: Wire the wrapper into gateway startup and logger context

**Files:**
- Modify: `src/channel.ts`
- Modify: `src/logger-context.ts`
- Modify: `src/inbound-handler.ts`
- Modify: `tests/integration/gateway-start-flow.test.ts`

- [ ] **Step 1: Write failing lifecycle tests for gateway startup**

Extend the gateway lifecycle tests so they lock in:

- `startAccount` resolves a plugin debug wrapper from `ctx.log`
- the wrapper is used for startup debug calls
- the returned `stop()` path closes the account-scoped writer

Suggested assertions:

```ts
expect(resolvePluginDebugLogMock).toHaveBeenCalledWith(
    expect.objectContaining({
        accountId: "main",
        debug: false,
    })
);
expect(closePluginDebugLogMock).toHaveBeenCalledWith(
    expect.objectContaining({
        accountId: "main",
    })
);
```

- [ ] **Step 2: Run the gateway lifecycle test and confirm it fails**

Run: `pnpm test tests/integration/gateway-start-flow.test.ts`

Expected: FAIL because `channel.ts` does not yet initialize or close the plugin debug wrapper.

- [ ] **Step 3: Implement minimal gateway wiring**

Update `src/channel.ts` so:

- `gateway.startAccount` resolves `accountStorePath`
- it creates `pluginLog` once from `ctx.log`, `config.debug`, `account.accountId`, and `accountStorePath`
- it stores `pluginLog` into `logger-context`
- gateway debug call sites in this function use `pluginLog`
- the inbound callback passes `pluginLog` into `handleDingTalkMessage`
- the stop handler closes the plugin debug writer

Update `src/inbound-handler.ts` and `src/logger-context.ts` only as needed so `setCurrentLogger(log)` stores the already-wrapped sink without changing downstream behavior.

- [ ] **Step 4: Re-run the gateway lifecycle test**

Run: `pnpm test tests/integration/gateway-start-flow.test.ts`

Expected: PASS.

### Task 4: Lock the reduced integration boundary so actions do not grow new behavior

**Files:**
- Modify: `tests/unit/message-actions.test.ts`
- Read: `src/channel.ts`

- [ ] **Step 1: Write failing boundary tests**

Add or extend tests so `actions.send` explicitly proves this change does not introduce new message-context persistence behavior:

```ts
expect(sendMessageMock).toHaveBeenCalledWith(
    expect.any(Object),
    "user_abc",
    "hello",
    expect.not.objectContaining({
        storePath: expect.anything(),
        conversationId: expect.anything(),
    })
);
```

- [ ] **Step 2: Run the focused action test and confirm it fails**

Run:

- `pnpm test tests/unit/message-actions.test.ts`

Expected: FAIL because the current implementation still forwards more behavior than intended.

- [ ] **Step 3: Remove the unintended extra behavior**

In `src/channel.ts`:

- keep `actions.send` on its original log acquisition path
- do not pass new `storePath` / `conversationId` fields from `actions.send`
- keep outbound and downstream service behavior unchanged unless required by the gateway-injected `getLogger()` path

- [ ] **Step 4: Re-run the focused action test**

Run:

- `pnpm test tests/unit/message-actions.test.ts`

Expected: PASS.

### Task 5: Keep the `Logger` compatibility surface intact

**Files:**
- Modify: `src/types.ts`
- Modify: `src/logger-context.ts`
- Run: repository-wide type check

- [ ] **Step 1: Preserve `Logger` compatibility**

Make sure:

- `Logger` remains exported from `src/types.ts`
- `logger-context` keeps storing and returning `Logger`
- the new plugin debug sink remains assignable to existing `Logger` consumers

- [ ] **Step 2: Run type check and focused tests**

Run:

- `npm run type-check`
- `pnpm test tests/unit/utils.test.ts`
- `pnpm test tests/integration/gateway-start-flow.test.ts`
- `pnpm test tests/unit/message-actions.test.ts`

Expected: PASS for all commands.

### Task 6: Final verification sweep

**Files:**
- No new code files

- [ ] **Step 1: Run the complete verification set**

Run:

- `npm run type-check`
- `pnpm test tests/unit/utils.test.ts`
- `pnpm test tests/integration/gateway-start-flow.test.ts`
- `pnpm test tests/unit/message-actions.test.ts`
- `git ls-files tests | rg '\.test\.ts$|\.test-structure\.test\.ts$' | xargs pnpm vitest run`

Expected: PASS. If a local untracked temporary test file makes bare `pnpm test` noisy, record that clearly and use the tracked-test command as the trustworthy project-wide verification source.

- [ ] **Step 2: Review generated log-path behavior manually**

Confirm the implementation matches the design:

- debug file path is rooted at `path.dirname(storePath)`
- per-account subdirectory is used
- daily file naming is correct
- file creation is lazy
- missing `storePath` degrades to stdout only

- [ ] **Step 3: Commit with a focused message**

Use a Conventional-style commit message, for example:

```bash
git add src/utils.ts src/channel.ts src/logger-context.ts src/types.ts tests/unit/utils.test.ts tests/integration/gateway-start-flow.test.ts tests/unit/message-actions.test.ts docs/spec/2026-04-02-dingtalk-plugin-debug-log-design.md docs/plans/2026-04-02-dingtalk-plugin-debug-log-implementation.md
git commit -m "feat(logging): add plugin-owned dingtalk debug sink"
```
