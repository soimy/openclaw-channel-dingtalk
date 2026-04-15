# Contributor and Agent Workflow

This document defines the shared base workflow for contributors and coding agents in this repository. It must remain usable without optional local tools such as GitNexus.

## Purpose

Use this document as the authoritative workflow reference when changing code, docs, tests, or release-related assets in this repository.

## Core Principles

- Read before editing.
- Keep changes scoped to the request.
- Prefer existing architecture boundaries over ad hoc placement.
- Validate before claiming completion.
- Do not make optional tools the only documented path.

## Workflow

### 1. Understand the task

- Clarify the requested outcome before changing files.
- Read the relevant source files and supporting docs first.
- Use `docs/contributor/architecture.zh-CN.md` or `docs/contributor/architecture.en.md` as the source of truth for module boundaries.
- If the task produces design or implementation planning documents, write them to `docs/spec/` and `docs/plans/`.

### 2. Assess impact before editing

- Review direct callers, importers, and affected execution paths before changing a function, class, method, or public behavior.
- For refactors, renames, or broad workflow changes, inspect the surrounding modules and likely downstream consumers.
- If optional graph-aware tooling is available locally, prefer it for impact analysis. If not, perform the same reasoning manually by reading the code and tests.

### 3. Make the change

- Prefer editing existing files over creating new ones unless a new file clearly improves structure.
- Keep `src/channel.ts` as an assembly layer; do not move new business logic into it.
- Do not reintroduce legacy quote persistence wrappers such as `quote-journal.ts` or `quoted-msg-cache.ts`; use `src/message-context-store.ts` directly.
- Do not add unrelated refactors or speculative abstractions outside the requested scope.
- Follow the documented domain boundaries for gateway, targeting, messaging, card, command, platform, and shared logic.
- Preserve current user-visible delivery priorities, including card-to-markdown fallback when AI Card delivery fails.
- Keep repository-specific return shapes and structured logging conventions stable unless the task explicitly changes them.

### 4. Validate the change

- Run validation that matches the changed scope.
- For code changes, the typical baseline is `pnpm run type-check`, `pnpm run lint`, and relevant tests.
- For docs or workflow changes, also run `pnpm run docs:build`.
- If work affects DingTalk user-visible message behavior, follow the real-device testing guidance in `docs/contributor/testing.md` and use the dedicated real-device-testing skill when that workflow applies.

### 5. Prepare handoff

- Summarize what changed and why.
- State which validation steps were run.
- Call out any known limitations, follow-up work, or intentionally untested areas.

## Repository-Specific Rules

- Use `getAccessToken()` before DingTalk API calls.
- Use `getLogger()` instead of `console.log`.
- Never log raw access tokens.
- Do not create multiple active AI Cards for the same `accountId:conversationId`.
- Keep review comments in Simplified Chinese, following `.github/instructions/code-review.instructions.md`.
- Keep process-local memory-only state such as inbound dedup and inflight protection out of cross-process persistence.
- Treat `src/message-context-store.ts` as the only production API for quote, media, and card context persistence.
- Preserve the current multi-account model based on `channels.dingtalk.accounts`; account-level settings inherit channel defaults unless explicitly overridden.

## Documentation Conventions

- Keep `README.md` as a concise project entry page.
- Put user-facing details in `docs/user/`.
- Put contributor, process, testing, and architecture docs in `docs/contributor/`.
- Put release notes in `docs/releases/`.
- Do not create tool-specific doc roots such as `docs/superpowers/`.

## Collaboration Conventions

- Prefer the GitHub issue templates under `.github/ISSUE_TEMPLATE/`.
- Keep issue communication primarily in Simplified Chinese.
- Use an English Conventional-style pull request title.
- Write the pull request description in Simplified Chinese.
- Include clearly labeled `背景`, `目标`, `实现`, `实现 TODO`, and `验证 TODO` sections in pull requests.

## Optional Tooling Policy

Optional tools may strengthen navigation, impact analysis, and verification, but they are not required local dependencies.

- If optional tooling is available, contributors should use it to improve confidence and speed.
- If optional tooling is unavailable, contributors must continue with the base workflow instead of being blocked.
- Tool-specific commands must never be the only documented way to perform a required repository workflow step.
