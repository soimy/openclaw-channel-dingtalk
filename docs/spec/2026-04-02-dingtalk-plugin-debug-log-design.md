# DingTalk Plugin Debug Log Design

This change introduces a plugin-owned debug logging path for the DingTalk channel so plugin-side debug evidence no longer depends on unstable runtime `ctx.log` injection.

## Goals

- Make plugin-side `debug` logs readable even when runtime logger injection is missing, stale, or only partially available.
- Keep the configuration switch on the existing DingTalk plugin `debug` flag instead of adding a second debug toggle.
- Provide both immediate stdout output and persistent per-account log files for real-device testing, timeline evidence, and plugin-side diagnosis.
- Add a plugin-side wrapper that stays compatible with the current `Logger` type surface and existing `getLogger()` consumers.
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

`closePluginDebugLog` closes and removes any cached writer for the target account and store scope. `gateway.startAccount` should call it from the returned `stop()` handler so long-lived gateway sessions release their file resources when stopped. A closed scope should not be reopened by an old wrapper instance after shutdown; only a fresh wrapper from a later lifecycle may reopen the sink.

Daily rotation is handled lazily by the key including the local date. No size-based rotation or retention policy is included in this change.

### 5. Integration Strategy

The wrapper should be introduced at the gateway assembly root instead of by mass-editing every service call site.

Primary integration path:

- `src/channel.ts`
  - `gateway.startAccount` creates `pluginLog` from `ctx.log`, `config.debug`, `accountId`, and `accountStorePath`
  - `gateway.startAccount` stores `pluginLog` into `logger-context` under the current `accountId`
- `src/inbound-handler.ts`
  - continue setting `setCurrentLogger(log, accountId)` but ensure the provided `log` is already the plugin wrapper
- `src/logger-context.ts`
  - keep storing the wrapped sink so `getLogger(accountId)` consumers automatically use the current account's plugin-owned debug sink
  - retain the latest global fallback only as a compatibility backstop for legacy call sites that still read `getLogger()` without an account

This keeps the integration surface intentionally small:

- gateway startup and inbound paths use the wrapped sink directly
- existing downstream modules that already read `getLogger()` continue to work without signature changes
- outbound paths can prefer `getLogger(accountId)` to retrieve the correct account-scoped plugin log without depending on a process-wide singleton
- action paths keep their current log acquisition style; this change does not add new explicit wrapper plumbing or new message-context persistence behavior there

### 6. Compatibility with Existing Logger Types

The repository currently defines:

- `ChannelLogSink` as the SDK log sink type
- `Logger` as a deprecated alias of `ChannelLogSink`

The wrapper should implement the `Logger`-compatible sink shape so it can be threaded through existing function signatures and `logger-context` without a broad type churn. This design explicitly does not require a repository-wide `Logger` removal.

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
- Add a focused unit test for account-scoped `logger-context` behavior.
- Add a focused boundary test for `actions.send` so this change does not silently add new `storePath` / `conversationId` persistence behavior there.
- Add focused outbound tests so `sendText` / `sendMedia` prefer the current account's plugin log over a stale logger from another account.
- Run:
  - `pnpm test tests/unit/utils.test.ts`
  - `pnpm test tests/unit/logger-context.test.ts`
  - `pnpm test tests/integration/gateway-start-flow.test.ts`
  - `pnpm test tests/unit/message-actions.test.ts`
  - `pnpm test tests/integration/send-lifecycle.test.ts tests/integration/send-media-flow.test.ts`
  - `npm run type-check`
