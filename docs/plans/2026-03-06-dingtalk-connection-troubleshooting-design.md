# DingTalk Connection Troubleshooting Design

## Goal

Improve diagnosis for DingTalk Stream initialization failures, especially recurring HTTP 400 cases, without modifying the upstream `dingtalk-stream` SDK.

## Scope

- Enhance plugin-side connection failure logging.
- Add minimal cross-platform troubleshooting scripts for `connections/open`.
- Add a dedicated troubleshooting manual under `docs/`.
- Link the troubleshooting manual from `README.md`.

Out of scope:

- Modifying or forking `dingtalk-stream`.
- Adding WebSocket handshake testing to the first version of the scripts.
- Changing normal message send/receive flows unrelated to connection initialization.

## Problem Summary

Current initialization failures often collapse to generic log output such as `Request failed with status code 400`, which makes it hard to distinguish between:

- DingTalk rejecting the `connections/open` request.
- A plugin-side request mismatch.
- A later network/proxy/WebSocket issue.
- User-side configuration mistakes.

The repository already has a standardized DingTalk error payload formatter in `src/utils.ts`, but connection startup paths in `src/connection-manager.ts` and `src/channel.ts` do not currently expose enough structured detail.

## Chosen Approach

### 1. Plugin-side logging improvements

Keep `dingtalk-stream` unchanged and improve the plugin's own failure reporting around connection setup.

Design points:

- Extend connection failure logs in `src/connection-manager.ts`.
- Preserve the existing message text, but append structured details when available.
- Reuse the existing payload formatting helpers from `src/utils.ts` instead of introducing a new log format.
- Continue to log raw `err.message` when the error is not Axios-shaped.

Expected logged fields when available:

- failure stage label
- HTTP status
- DingTalk `code`
- DingTalk `message`
- request ID if available
- sanitized error payload

Suggested stage labels:

- `connect.open` for initial open-connection style failures observed during startup
- `connect.runtime` for later runtime reconnect failures when distinguishable

The log should also point users toward the troubleshooting scripts and the new troubleshooting manual.

### 2. Minimal troubleshooting scripts

Add two scripts under `scripts/`:

- `scripts/dingtalk-connection-check.sh`
- `scripts/dingtalk-connection-check.ps1`

Purpose:

- Validate `POST https://api.dingtalk.com/v1.0/gateway/connections/open`
- Confirm whether credentials and basic DingTalk API reachability work from the user's environment
- Produce sanitized output that users can paste into issues

First-version constraint:

- Only test `connections/open`
- Do not perform WebSocket handshake checks yet

Why this boundary was chosen:

- It keeps the scripts stable and easy to run on macOS, Linux, and Windows.
- It isolates the highest-value diagnostic split first.
- It avoids proxy/WSS false negatives in the first version.

### 3. Input and config resolution rules

The scripts should support both direct credential input and reading from OpenClaw config.

Accepted inputs:

- `--client-id`
- `--client-secret`
- `--config`
- `--account-id`

Resolution priority:

1. explicit CLI parameters
2. config file specified by `--config`
3. default config path `~/.openclaw/openclaw.json`

Config lookup behavior:

- Default mode reads `channels.dingtalk.clientId` and `channels.dingtalk.clientSecret`.
- If `--account-id` is provided, the script looks for a matching entry in `channels.dingtalk.accounts`.
- This supports both simple and multi-account troubleshooting without forcing multi-account complexity into the default path.

Output requirements:

- Never print the full `clientSecret`.
- Never print a full `ticket`.
- Print enough metadata to help diagnosis, including masked identifiers, HTTP status, and response payload.

### 4. Dedicated troubleshooting manual

Add `docs/connection-troubleshooting.md`.

Planned contents:

- what initialization-time HTTP 400 usually means
- why HTTP 400 is not equivalent to generic network unreachability
- how to run the Bash and PowerShell scripts
- how default-account and `--account-id` lookup works
- examples of successful and failed output
- what to check if `connections/open` succeeds but the plugin still fails

That last section should explicitly direct users to inspect:

- proxy or corporate gateway behavior
- WSS access to DingTalk Stream endpoints
- DingTalk app publication state
- robot capability and Stream mode settings
- whether the tested credentials and the plugin's runtime credentials are actually the same account

### 5. README integration

The existing `README.md` connection-failure section is too brief.

It should be updated to:

- explain that HTTP 400 is not always just "network unavailable"
- link to `docs/connection-troubleshooting.md`
- point users to the diagnostic scripts
- keep the README concise and move detailed procedures into the dedicated manual

## Alternatives Considered

### Option A: Logging + minimal scripts + dedicated docs

Chosen.

Pros:

- Best diagnostic value for current issue pattern.
- Low implementation risk.
- Works across default and multi-account setups.
- Gives maintainers and users a shared, pasteable troubleshooting workflow.

Cons:

- Does not yet prove WSS handshake health.

### Option B: Also add WSS handshake testing now

Rejected for v1.

Pros:

- More complete end-to-end diagnosis.

Cons:

- Higher cross-platform complexity.
- More fragile in proxy/corporate environments.
- Harder to keep user output simple and reliable.

### Option C: Docs-only improvement

Rejected.

Pros:

- Fastest to ship.

Cons:

- Leaves users with weak self-service diagnostics.
- Does not address the current lack of structured connection failure logs.

## File Plan

Expected implementation touch points:

- Modify: `src/connection-manager.ts`
- Possibly modify: `src/channel.ts`
- Reuse helpers from: `src/utils.ts`
- Add: `scripts/dingtalk-connection-check.sh`
- Add: `scripts/dingtalk-connection-check.ps1`
- Add: `docs/connection-troubleshooting.md`
- Modify: `README.md`
- Add/update tests near existing connection-manager coverage in `tests/unit/connection-manager.test.ts`

## Validation Plan

Implementation should verify:

- connection logging still works for generic errors without `response`
- structured 400-style errors include sanitized status/payload details
- scripts support parameter input and config-file input
- scripts support default account and `--account-id`
- script output does not leak secrets
- documentation paths and examples match the actual files

Recommended verification commands after implementation:

- `npm run type-check`
- `npm run lint`
- targeted tests for connection manager behavior

## Success Criteria

This design is successful when:

- users can quickly tell whether `connections/open` works in their environment
- maintainers receive sanitized but useful error payloads instead of only `400`
- README provides a clear entry point to troubleshooting
- the plugin remains compatible with the existing upstream SDK

## Follow-up

After this design, the next step should be an implementation plan that breaks the work into testable, bite-sized tasks.
