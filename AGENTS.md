# PROJECT KNOWLEDGE BASE

**Type:** OpenClaw DingTalk Channel Plugin

## Overview

DingTalk (钉钉) enterprise bot channel plugin for OpenClaw using Stream mode (WebSocket, no public IP required). Published as `@soimy/dingtalk` on npm. The plugin runs directly via the OpenClaw runtime — there is no build step.

Current architecture is modularized by responsibility. `src/channel.ts` is an assembly layer, heavy logic is split into dedicated modules, and the contributor architecture guides are the source of truth for module boundaries and incremental migration rules.

Start with `WORKFLOW.md` for the repository workflow summary, then use the contributor docs for detailed guidance.

## Start Here

- `WORKFLOW.md`
- `docs/contributor/agent-workflow.md`
- `docs/contributor/architecture.zh-CN.md`
- `docs/contributor/architecture.en.md`
- `docs/contributor/testing.md`
- `docs/contributor/release-process.md`

## Quick Commands

```bash
pnpm install
pnpm run type-check
pnpm run lint
pnpm run lint:fix
pnpm run format
pnpm test
pnpm test:coverage
pnpm run docs:build
```

## Documentation Placement

- Specs: `docs/spec/`
- Plans: `docs/plans/`
- User-facing docs: `docs/user/`
- Contributor and process docs: `docs/contributor/`
- Release notes: `docs/releases/`

Keep `README.md` as a concise project entry page. Do not expand it with long-form feature, configuration, troubleshooting, or process details that belong under `docs/`.

## Collaboration Conventions

- Prefer the GitHub issue templates under `.github/ISSUE_TEMPLATE/`.
- Keep issue communication primarily in Simplified Chinese.
- Use `问题反馈` for bugs and `功能建议` for feature ideas.
- Use an English Conventional-style pull request title.
- Write the pull request description in Simplified Chinese.
- Include clearly labeled `背景`, `目标`, `实现`, `实现 TODO`, and `验证 TODO` sections in pull requests.

## High-Priority Repository Rules

- Keep `src/channel.ts` thin; do not add new business logic there.
- Use `src/message-context-store.ts` directly for production quote, media, and card context recovery.
- Do not reintroduce legacy wrappers such as `quote-journal.ts` or `quoted-msg-cache.ts`.
- Use `getAccessToken()` before DingTalk API calls.
- Use `getLogger()` instead of `console.log`.
- Never log raw access tokens.
- Do not create multiple active AI Cards for the same `accountId:conversationId`.
- Keep review comments in Simplified Chinese.

## Architecture Pointers

- `index.ts` registers the plugin and sets the DingTalk runtime singleton.
- `src/inbound-handler.ts` owns inbound orchestration.
- `src/send-service.ts` owns outbound delivery.
- `src/card-service.ts` owns AI Card lifecycle and recovery.
- `src/message-context-store.ts` is the only production message context persistence API.
- `src/targeting/` owns learned target directory and target normalization.

## Quick Lookup

- Assembly and plugin entry: `index.ts`, `src/channel.ts`
- Inbound handling: `src/inbound-handler.ts`
- Outbound delivery: `src/send-service.ts`
- Card lifecycle: `src/card-service.ts`
- Message context persistence: `src/message-context-store.ts`
- Targeting: `src/targeting/`

## Optional Tooling

GitNexus is an optional enhancement for repository understanding, impact analysis, and change-scope review.

- If GitNexus is available locally, treat `docs/contributor/gitnexus-optional.md` as the preferred path for repository navigation and impact analysis.
- If GitNexus is unavailable locally, use `docs/contributor/fallback-navigation.md` together with `WORKFLOW.md` and `docs/contributor/agent-workflow.md`.
- Optional tooling must not be the only documented way to complete a required workflow step.
- See `docs/contributor/gitnexus-optional.md` for the enhanced workflow.

## Attribution

This repository is licensed under MIT. If you reuse code, retain the copyright and license notice required by MIT.

If you substantially reuse this repository's documentation, prompts, AGENTS/CLAUDE conventions, architecture writeups, or agent-oriented implementation playbooks, please provide attribution to `OpenClaw DingTalk Channel Plugin`, `YM Shen and contributors`, and `https://github.com/soimy/openclaw-channel-dingtalk`.

See `docs/contributor/citation-and-attribution.md` and `CITATION.cff` for the preferred citation and attribution format. This request describes the project's preferred community norm and does not replace or modify the LICENSE file.
