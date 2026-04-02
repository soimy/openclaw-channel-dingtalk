# DingTalk Plugin Debug Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a plugin-owned DingTalk debug logging path that mirrors plugin-side `debug` messages to stdout and per-account files under the plugin store root without changing current `info` / `warn` / `error` behavior.

**Architecture:** Introduce a single debug wrapper in `src/utils.ts` that implements the current log sink shape and owns plugin-side debug persistence. Wire that wrapper only at plugin entry points in `src/channel.ts` and the logger context path so downstream modules keep their current `log?.debug?.(...)` usage while gaining stable stdout and file evidence.

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
- gateway debug call sites in this function use `pluginLog`
- the inbound callback passes `pluginLog` into `handleDingTalkMessage`
- the stop handler closes the plugin debug writer

Update `src/inbound-handler.ts` and `src/logger-context.ts` only as needed so `setCurrentLogger(log)` stores the already-wrapped sink without changing downstream behavior.

- [ ] **Step 4: Re-run the gateway lifecycle test**

Run: `pnpm test tests/integration/gateway-start-flow.test.ts`

Expected: PASS.

### Task 4: Cover action and outbound entry points that do not rely on inbound logger setup

**Files:**
- Modify: `src/channel.ts`
- Modify: existing channel action / outbound tests, or add focused tests under `tests/unit/`
- Read: `src/send-service.ts`

- [ ] **Step 1: Write failing tests for non-inbound plugin entry points**

Add or extend tests so the following paths prove they can resolve plugin debug independently:

- `actions.handleAction`
- `outbound.sendText`
- `outbound.sendMedia`

At least one test should cover the case where `getLogger()` was never set by inbound handling.

Example assertion shape:

```ts
expect(resolvePluginDebugLogMock).toHaveBeenCalledWith(
    expect.objectContaining({
        accountId: "default",
        storePath: expect.any(String),
    })
);
```

- [ ] **Step 2: Run the targeted channel tests and confirm they fail**

Run the specific files you updated, for example:

- `pnpm test tests/unit/channel-actions.test.ts`
- `pnpm test tests/unit/channel-outbound.test.ts`

Expected: FAIL because these entry points still depend on raw runtime log objects or `getLogger()` state.

- [ ] **Step 3: Wire the wrapper into those entry points**

In `src/channel.ts`:

- wrap the `log` passed into `actions.handleAction`
- wrap the `log` passed into `outbound.sendText`
- wrap the `log` passed into `outbound.sendMedia`
- prefer the wrapped sink for direct debug statements in those paths

Do not rewrite downstream service APIs. Keep the integration at the entry point boundary.

- [ ] **Step 4: Re-run the targeted channel tests**

Run the same focused test files from Step 2.

Expected: PASS.

### Task 5: Remove the deprecated `Logger` alias after behavior is stable

**Files:**
- Modify: `src/types.ts`
- Modify: all TypeScript files that import `Logger`
- Run: repository-wide type check

- [ ] **Step 1: Write the smallest possible safety test if one is needed**

If a focused compile-oriented test is helpful, add one small test that imports a representative function using the new `ChannelLogSink` type. If existing tests already exercise those signatures well, skip adding a new test and proceed directly to the type-only refactor.

- [ ] **Step 2: Replace `Logger` imports with `ChannelLogSink`**

Change signatures such as:

```ts
log?: Logger;
```

to:

```ts
log?: ChannelLogSink;
```

Keep this as a mechanical refactor only. Do not mix new behavior into this step.

- [ ] **Step 3: Remove the deprecated alias from `src/types.ts`**

Delete:

```ts
/**
 * @deprecated Use ChannelLogSink instead
 */
export type Logger = ChannelLogSink;
```

- [ ] **Step 4: Run type check and focused tests**

Run:

- `npm run type-check`
- `pnpm test tests/unit/utils.test.ts`
- `pnpm test tests/integration/gateway-start-flow.test.ts`
- the focused channel tests updated in Task 4

Expected: PASS for all commands.

### Task 6: Final verification sweep

**Files:**
- No new code files

- [ ] **Step 1: Run the complete verification set**

Run:

- `npm run type-check`
- `pnpm test tests/unit/utils.test.ts`
- `pnpm test tests/integration/gateway-start-flow.test.ts`
- `pnpm test`

Expected: PASS. If `pnpm test` is too slow for the active iteration, at minimum record exactly which focused suites passed and why the full suite was deferred.

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
git add src/utils.ts src/channel.ts src/logger-context.ts src/inbound-handler.ts src/types.ts tests/unit/utils.test.ts tests/integration/gateway-start-flow.test.ts docs/spec/2026-04-02-dingtalk-plugin-debug-log-design.md docs/plans/2026-04-02-dingtalk-plugin-debug-log-implementation.md
git commit -m "feat(logging): add plugin-owned dingtalk debug sink"
```
