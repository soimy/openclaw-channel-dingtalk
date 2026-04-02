# DingTalk Plugin Debug Log Design

This change introduces a plugin-owned debug logging path for the DingTalk channel so plugin-side debug evidence no longer depends on unstable runtime `ctx.log` injection.

## Goals

- Make plugin-side `debug` logs readable even when runtime logger injection is missing, stale, or only partially available.
- Keep the configuration switch on the existing DingTalk plugin `debug` flag instead of adding a second debug toggle.
- Provide both immediate stdout output and persistent per-account log files for real-device testing, timeline evidence, and plugin-side diagnosis.
- Replace plugin-side log wrapping with a single wrapper flow that is compatible with the current `Logger` / `ChannelLogSink` shape.
- Keep runtime-facing `info` / `warn` / `error` behavior unchanged in this iteration.

## Non-Goals

- Replacing the upstream `dingtalk-stream` debug output or changing how `DWClient` uses `debug: true`.
- Turning every log level into plugin-owned persistence. This design only takes ownership of plugin-side `debug`.
- Introducing a large logging subsystem with log shipping, compression, retention, structured search, or size-based rotation.
- Rewriting every existing `log?.debug?.(...)` call site into a new API.

## Current Problem

The repository already emits a large number of plugin-side debug messages through `log?.debug?.(...)` and `getLogger()?.debug?.(...)`. Those debug anchors are useful for inbound routing, delivery fallback, card behavior, and real-device validation, but they currently rely on runtime-provided logger instances being present and correctly threaded through the request lifecycle.

When runtime logger injection is missing or stale, plugin-side debug output becomes incomplete or disappears entirely. This creates blind spots exactly where contributors need durable evidence: gateway startup, callback processing, real-device verification, and outbound behavior investigation.

## Design

### 1. Plugin-Owned Debug Wrapper

Add a new wrapper factory in `src/utils.ts`:

- `resolvePluginDebugLog(params)`
- `closePluginDebugLog(params)`

`resolvePluginDebugLog` returns an object compatible with the existing `Logger` / `ChannelLogSink` shape. It wraps an optional upstream sink (`baseLog`) but owns plugin-side `debug` behavior.

Behavior:

- `debug=false`
  - `debug()` only forwards to `baseLog?.debug`.
  - No stdout write, no file creation, no writer registry.
- `debug=true`
  - `debug()` writes a formatted line to plugin stdout.
  - `debug()` appends the same line to the plugin debug log file when `storePath` is available.
  - `debug()` then best-effort forwards the original message to `baseLog?.debug`.
- `info` / `warn` / `error`
  - forward to `baseLog` unchanged
  - are not persisted by the plugin debug sink in this iteration

This keeps the runtime interface stable while moving the actual debug evidence path into plugin-owned code.

### 2. Log File Placement

When `storePath` is available, the plugin debug file is stored under the same account-scoped persistence root already used by the plugin:

- base directory: `path.dirname(storePath)`
- log directory: `<base>/logs/dingtalk/<accountId>/`
- file name: `debug-YYYY-MM-DD.log`

Example:

- session store: `/data/openclaw/session-store.json`
- debug log: `/data/openclaw/logs/dingtalk/main/debug-2026-04-02.log`

When `storePath` is missing, the sink still writes to stdout and skips file persistence without throwing.

### 3. Log Format

Use one human-readable single-line format for both stdout and the persisted file:

```text
[2026-04-02 15:04:05.123+08:00] [debug] [dingtalk] [account:main] Peer ID registry preloaded from sessions
```

This format is intentionally optimized for:

- direct terminal readability
- `tail -f` workflows
- evidence excerpts in PRs, issues, and real-device validation notes

The wrapper should preserve the original message body as much as possible. Existing call sites remain responsible for any domain-specific masking they already perform.

### 4. Writer Registry and Lifecycle

Use an in-memory registry keyed by:

- `storePath`
- `accountId`
- local calendar date

The registry allows repeated `debug()` calls to reuse the same append target instead of recreating directories or handles for every line.

`closePluginDebugLog` closes and removes any cached writer for the target account and store scope. `gateway.startAccount` should call it from the returned `stop()` handler so long-lived gateway sessions release their file resources when stopped.

Daily rotation is handled lazily by the key including the local date. No size-based rotation or retention policy is included in this change.

### 5. Integration Strategy

The wrapper should be introduced at plugin entry points instead of by mass-editing every service call site.

Primary entry points:

- `src/channel.ts`
  - `gateway.startAccount`
  - `actions.handleAction`
  - `outbound.sendText`
  - `outbound.sendMedia`
- `src/inbound-handler.ts`
  - continue setting `setCurrentLogger(log)` but ensure the provided `log` is already the plugin wrapper
- `src/logger-context.ts`
  - keep storing the wrapped sink so `getLogger()` consumers automatically use plugin-owned debug

This gives near-complete plugin-side coverage with minimal behavioral churn:

- gateway and inbound paths use the wrapped sink
- outbound and action entry points use the wrapped sink even when no inbound request established `getLogger()`
- existing downstream modules keep their current `log?.debug?.(...)` calls

### 6. Compatibility with Existing Logger Types

The repository currently defines:

- `ChannelLogSink` as the SDK log sink type
- `Logger` as a deprecated alias of `ChannelLogSink`

The wrapper should implement the `ChannelLogSink` shape so it is immediately compatible with both names. The first implementation can keep existing function signatures intact. A later cleanup can replace the deprecated `Logger` alias throughout the codebase after the runtime behavior has already been stabilized.

## Failure Handling

Plugin debug persistence must never break message handling or gateway behavior.

Rules:

- stdout write failure must not throw into business logic
- file append failure must not throw into business logic
- upstream `baseLog.debug` failure must not throw into business logic
- when file persistence fails, emit a single warning through `baseLog?.warn` for that writer scope and suppress repeated warning spam
- if directory creation fails, continue with stdout and upstream debug forwarding only

## Verification

- Add focused unit tests for the wrapper in `tests/unit/utils.test.ts`.
- Extend gateway lifecycle tests so startup and stop paths initialize and close the plugin debug sink.
- Add coverage for action and outbound entry points so plugin debug still works even without prior inbound logger setup.
- Run:
  - `pnpm test tests/unit/utils.test.ts`
  - `pnpm test tests/integration/gateway-start-flow.test.ts`
  - targeted channel entry-point tests for action and outbound paths
  - `npm run type-check`
