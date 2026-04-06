---
name: dingtalk-real-device-testing
description: Use when work in openclaw-channel-dingtalk involves DingTalk real-device validation, PR-scoped testing checklists, 验证 TODO drafting, or contributor guidance for this workflow.
---

# DingTalk Real-Device Testing

## Overview

Use this skill for repository-specific DingTalk real-device validation. Keep human-facing rules in `docs/contributor/testing.md`, and use this skill to turn a PR or change summary into a focused test checklist and PR verification note.

## When To Use

Use this skill when the task involves:

- DingTalk real-device testing or 联调
- PR-scoped validation for message-path changes
- drafting or updating PR `验证 TODO`
- updating contributor guidance for this workflow

Do not use this skill for pure unit-test work, docs-only edits unrelated to DingTalk behavior, or generic debugging that does not touch DingTalk real-device validation.

## Quick Workflow

1. Confirm the scope. Test only the DingTalk message-path behavior the PR actually changes: inbound handling, routing/context, outbound delivery, display, callbacks, quote/media recovery, or related user-visible paths.
2. Prepare the real-device environment before proposing any checklist:
   - use the globally running `openclaw`
   - ensure the plugin directory points at the current repo or worktree
   - update `~/.openclaw/openclaw.json` only as needed for the target path
   - run `openclaw gateway restart` so the latest code and config are live
   - immediately verify the restart with `openclaw channels status --probe --json`
   - if the first probe lands during restart and shows `1006 abnormal closure`, wait a few seconds and probe again instead of misdiagnosing a channel bug
   - do not start DingTalk-side testing until `channels.dingtalk.running=true` and `channelAccounts.dingtalk[0].connected=true`
3. Build a PR-scoped checklist. Do not invent a fixed baseline matrix. For each affected path, give:
   - scenario name
   - trigger steps in DingTalk
   - expected user-visible result
   - minimal observation points only if the result is unclear
4. Prefer objective probes. Choose prompts or interactions whose success can be checked externally. Avoid ambiguous prompts that the model could “guess” without exercising the changed path.
   - for proactive outbound or host-invoked send paths, prefer `openclaw message send --channel dingtalk --target '<target>' --message '<probe>' --json`
   - treat the CLI result as a first-pass gate only: confirm `handledBy: "plugin"` and `payload.ok: true`, then still check the DingTalk client for the actual rendered outcome when the PR changes user-visible delivery semantics
   - for reply-path validation, especially media / quote / callback / sessionWebhook behavior, do not rely on CLI send as a substitute for a real inbound callback; send from the DingTalk client so the changed reply path is actually exercised
   - when testing reply media, use deterministic prompts whose success is externally checkable, for example forcing the agent to emit an exact `MEDIA:` line or exact file path, and be ready to inspect whether the model emitted inline directive text, queued final text, or only a bare local path
5. If a result is off, narrow it in this order:
   - did the test input really cover the changed path
   - was the mismatch in inbound handling, routing/context, outbound delivery, client display, callback, or recovery
   - do `~/.openclaw/logs/gateway.log`, `openclaw logs`, or the relevant session transcript add evidence
   - for live triage, keep a `tail -n 0 -f ~/.openclaw/logs/gateway.log` session open so you can correlate the exact send time with final payload shape, media upload, proactive fallback, and card finalize / recall decisions
   - only use `scripts/dingtalk-connection-check.*` or `scripts/dingtalk-stream-monitor.mjs` when connection or stream intake itself is suspect
6. Draft PR `验证 TODO` wording that states:
   - the environment was switched to the current repo/worktree and restarted
   - which real-device scenarios were actually run
   - whether results matched the PR goal
   - any known gaps or limitations
7. End with cleanup guidance: restore the plugin directory target, revert temporary `~/.openclaw/openclaw.json` changes, and restart again if needed.

## Common Mistakes

- Testing unrelated scenarios just to “look thorough”
- Treating logs alone as success without confirming the DingTalk-side result
- Forgetting `openclaw gateway restart` after switching code or config
- Treating one failed `channels status --probe` during restart as evidence that DingTalk is broken
- Using `openclaw message send` to “verify” reply-path behavior that only happens after a real DingTalk inbound callback
- Using ambiguous prompts for reply-media tests, then concluding the plugin is broken when the model never emitted the required media directive or path
- Confirming only “heard a sound” without separately checking whether DingTalk actually rendered a voice bubble, a normal file, a lingering card, or a successfully recalled empty card
- Leaving the plugin path or temporary `openclaw.json` settings in a modified state
- Writing `验证 TODO` as “已测试” without naming the scenarios that were run

## Keep In Sync

If the task changes contributor-facing policy or wording, update `docs/contributor/testing.md` and this skill together so human guidance and agent workflow stay aligned.
