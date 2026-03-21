# Real-Device Debugging

Chinese version: [`real-device-debugging.zh-CN.md`](real-device-debugging.zh-CN.md)

This document describes the repository's semi-automated real-device debugging workflow for the DingTalk channel plugin.

Use it when you need a reproducible test session that combines:

- `openclaw gateway restart`
- `openclaw logs`
- DingTalk desktop or real-device interaction
- structured evidence collection and judgment

This workflow intentionally stops at the boundary between repository automation and DingTalk client automation. The repository manages the debug session, artifacts, and judgment. A human operator or an external desktop agent performs the DingTalk-side interaction.

## Why Use A Debug Session

Use a debug session instead of ad-hoc terminal testing when:

- the plugin only shows its real behavior through the DingTalk app
- you need to compare "message reached plugin" vs "reply became visible in client"
- you need artifacts that can be attached to a PR, issue, or incident report
- you want a stable handoff contract for a human operator, Peekaboo-like desktop agent, or future DingTalk CLI

## Current Scope

The current repository implementation provides:

- session bootstrap and artifact directory creation
- a stable `manifest.json` contract
- `prepare` flow for connection check, optional stream monitor, `openclaw gateway restart`, and `openclaw logs`
- `observe` flow for operator/client observations
- `judge` flow for session summaries and machine-readable outcomes
- `run` flow that combines `start + prepare` and stops at operator handoff

The current repository implementation does **not**:

- drive the DingTalk desktop UI directly
- require OCR to complete a session
- change runtime message delivery behavior
- assume a DingTalk CLI already exists

## Session State Model

Conceptually, a full real-device session moves through these stages:

```text
created
  -> preflight_ok
  -> gateway_restarted
  -> probes_running
  -> message_sent
  -> reply_observed | timeout
  -> judged
  -> archived
```

The current implementation persists a simplified status model in `manifest.json`:

- `created`
- `probes_running`
- `message_sent`
- `reply_observed`
- `timeout`

`prepare` currently performs the preflight, gateway restart, and log capture setup before moving the session into `probes_running`.

## Artifact Layout

By default, every session lives under:

```text
.local/debug-sessions/<YYYY-MM-DD>/<sessionId>/
```

Example:

```text
.local/debug-sessions/2026-03-21/dtdbg-20260321-081530-dm-text-reply/
```

Common files:

- `manifest.json`: session metadata, current status, probe states, observations
- `timeline.json`: ordered session events
- `operator-steps.md`: the DingTalk-side action list
- `logs/connection-check.log`: output from `scripts/dingtalk-connection-check.sh`
- `logs/stream-monitor.log`: optional short stream monitor output
- `logs/gateway-restart.log`: output from `openclaw gateway restart`
- `logs/openclaw.log`: captured `openclaw logs`
- `logs/filtered.log`: filtered log slice used by `judge`
- `screenshots/`: screenshots copied in by the operator or desktop agent
- `judgment.json`: machine-readable outcome
- `summary.md`: human-readable session summary

## Commands

Install dependencies first:

```bash
pnpm install
```

All session commands are exposed through:

```bash
pnpm debug:session
```

### 1. Start A Session

Use `start` when you want to create a session directory and handoff doc without yet touching the running gateway.

```bash
pnpm debug:session start \
  --scenario dm-text-reply \
  --target-id <conversationId> \
  --target-label "Debug Chat"
```

This creates:

- `manifest.json`
- `timeline.json`
- `operator-steps.md`

### 2. Prepare Runtime Probes

Use `prepare` to run preflight checks and start terminal-side capture:

```bash
pnpm debug:session prepare --session-dir <sessionDir>
```

Use `--no-stream-monitor` if you want a faster session that skips the short stream monitor:

```bash
pnpm debug:session prepare --session-dir <sessionDir> --no-stream-monitor
```

`prepare` currently does:

- `bash scripts/dingtalk-connection-check.sh`
- optional `node scripts/dingtalk-stream-monitor.mjs --duration 20`
- `openclaw gateway restart`
- `openclaw logs`

### 3. Record Client-Side Observation

After the DingTalk-side action is performed, write an observation JSON file and pass it to `observe`:

```json
{
  "sentAt": "2026-03-21T08:16:00.000Z",
  "replyObservedAt": "2026-03-21T08:16:18.000Z",
  "sendStatus": "sent",
  "replyStatus": "visible",
  "replyPreview": "ok",
  "notes": "Reply rendered in the desktop client",
  "screenshots": [
    "/absolute/path/to/<sessionDir>/screenshots/reply-visible.png"
  ]
}
```

Then record it:

```bash
pnpm debug:session observe \
  --session-dir <sessionDir> \
  --observation-file /path/to/observation.json
```

`observe` normalizes screenshot paths into session-relative paths before writing them into `manifest.json`.

### 4. Judge The Session

After logs and observations are available, run:

```bash
pnpm debug:session judge --session-dir <sessionDir>
```

This writes:

- `judgment.json`
- `summary.md`

Current outcomes include:

- `no_inbound_evidence`
- `inbound_without_outbound`
- `outbound_not_visible_in_client`
- `end_to_end_success`
- `success_high_latency`

If `logs/filtered.log` is missing but `logs/openclaw.log` exists, `judge` will build the filtered log slice automatically.

### 5. One-Shot Start + Prepare

If you want to bootstrap a session and move it immediately to the handoff point:

```bash
pnpm debug:session run \
  --scenario dm-text-reply \
  --target-id <conversationId> \
  --target-label "Debug Chat" \
  --no-stream-monitor
```

`run` currently performs `start + prepare` and then stops. It prints the session location and the next operator action. It does **not** pretend to automate the DingTalk UI.

## Recommended Human Workflow

1. Run `pnpm debug:session run ...` or `start` followed by `prepare`.
2. Open `operator-steps.md`.
3. In DingTalk, send the exact probe message containing the session trace token.
4. Wait for the visible reply or timeout.
5. Copy screenshots into the session's `screenshots/` directory.
6. Write an observation JSON and run `observe`.
7. Run `judge`.
8. Attach `summary.md`, `judgment.json`, and selected screenshots to your PR or issue.

## External Desktop Agent Contract

This repository uses a stable adapter boundary so the desktop side can evolve independently.

Input for the external operator:

- `manifest.json`
- `operator-steps.md`

Expected output from the external operator:

- an observation JSON payload compatible with `observe`
- screenshots copied into the session directory

This makes the workflow compatible with:

- a human operator
- a Peekaboo-like desktop agent
- a future DingTalk CLI if DingTalk eventually exposes one

## Recommended PR Evidence

When your change affects runtime behavior, include:

- the `sessionId`
- the scenario you tested
- the final `outcome`
- whether the reply was visible in the client
- the attached `summary.md` or a short excerpt from it
- key screenshots when visibility is the disputed layer

## Related Files

- `scripts/dingtalk-debug-session.mjs`
- `scripts/real-device-debug/`
- `scripts/dingtalk-connection-check.sh`
- `scripts/dingtalk-stream-monitor.mjs`
- `docs/connection-troubleshooting.md`
