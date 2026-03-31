# DingTalk Real-Device Testing Guidance Design

This change adds a contributor-facing real-device testing guide and a project-local agent skill so humans and agents can follow the same DingTalk validation workflow.

## Goals

- Clarify that PRs touching DingTalk message-path behavior must be real-device tested by the PR author before merge.
- Keep `docs/contributor/testing.md` focused on contributor workflow, environment preparation, execution checklist, and PR reporting guidance.
- Move agent-oriented real-device testing prompting out of docs and into a reusable project-local skill.
- Make the real-device testing skill discoverable from both `AGENTS.md` and `CLAUDE.md`.

## Non-Goals

- Introducing a mandatory evidence archive format, screenshot requirement, or machine-readable real-device report for every PR.
- Creating a platform-specific skill directory layout tied only to Codex or only to Claude.
- Turning the contributor testing page into a full troubleshooting manual for every DingTalk edge case.

## Design

Update `docs/contributor/testing.md` so the real-device section is organized around contributor decisions instead of specific display toggles. The page should define the applicability rule, describe the recommended real-device environment, give a standard PR-scoped execution checklist, explain broad pass/fail judgment and lightweight diagnosis, and include a short `验证 TODO` example for PR authors.

Add a new repository-level skill at `skills/dingtalk-real-device-testing/SKILL.md`. The skill should trigger when an agent is asked to design or execute DingTalk real-device validation, prepare PR-scoped testing checklists, draft `验证 TODO` wording, or update related documentation. Its workflow should explicitly cover environment preparation with the globally running `openclaw`, plugin-directory switching, `~/.openclaw/openclaw.json` adjustments, `openclaw gateway restart`, PR-scoped scenario selection, objective probe design, PR verification-note drafting, and environment restoration after testing.

Extend `AGENTS.md` and `CLAUDE.md` with a short project-local skill rule that points agents at `skills/dingtalk-real-device-testing/SKILL.md` whenever the task involves DingTalk message-path real-device validation or related contributor workflow updates. This gives the skill a stable discovery path even if a given platform does not auto-scan repository-local skills.

## Verification

- Build the docs site with `npm run docs:build` to confirm the updated contributor guide renders cleanly.
- Inspect the new `skills/dingtalk-real-device-testing/SKILL.md`, `AGENTS.md`, and `CLAUDE.md` together to confirm the discovery path is explicit and internally consistent.
- Review the updated testing guide to ensure it stays contributor-facing and no longer embeds a direct LLM prompt template.
