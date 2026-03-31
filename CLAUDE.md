# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DingTalk (钉钉) enterprise bot channel plugin for OpenClaw. Uses Stream mode (WebSocket, no public IP required). Published as `@soimy/dingtalk` on npm. The plugin runs directly via the OpenClaw runtime — there is no build step.

## Commands

```bash
# Install dependencies
pnpm install

# Type-check (strict TypeScript)
pnpm run type-check

# Lint (oxlint with type-aware rules)
pnpm run lint

# Lint + auto-fix + format
pnpm run lint:fix

# Format only (oxfmt)
pnpm run format

# Run all tests
pnpm test

# Run a single test file
pnpm vitest run tests/unit/config.test.ts

# Run tests matching a pattern
pnpm vitest run -t "pattern"

# Coverage report
pnpm test:coverage

# Stream connection monitor (debugging)
pnpm run monitor:stream -- --duration 300 --summary-every 30 --probe-every 20
```

## Architecture

### Entry Point

`index.ts` — registers the plugin with OpenClaw via `api.registerChannel()` and `api.registerGatewayMethod()` (for docs API). Sets the DingTalk runtime singleton.

### Core Module Responsibilities

- **`src/channel.ts`** — Assembly layer only. Defines `dingtalkPlugin` (config, gateway, outbound, status, security, messaging, directory). Delegates all heavy logic to service modules. Keep this file thin.
- **`src/inbound-handler.ts`** — Inbound pipeline orchestrator: dedup → self-filter → content extraction → authorization → session routing → media download → message context persistence → reply dispatch.
- **`src/send-service.ts`** — All outbound delivery: session webhook, proactive text/markdown, proactive media, unified `sendMessage` with card/markdown fallback.
- **`src/card-service.ts`** — AI Card state machine (PROCESSING → INPUTING → FINISHED/FAILED), card instance cache, createdAt fallback cache, recovery of unfinished cards on restart.
- **`src/message-context-store.ts`** — Unified short-TTL message persistence under namespace `messages.context`. The **only** production API for quote/media/card context recovery.
- **`src/reply-strategy.ts`** + `reply-strategy-card.ts` + `reply-strategy-markdown.ts` + `reply-strategy-with-reaction.ts` — Strategy pattern for reply delivery.
- **`src/connection-manager.ts`** — Robust stream reconnect lifecycle with exponential backoff, jitter, cycle limits, and warm reconnection (creates fresh DWClient to minimize message-loss window).
- **`src/config.ts`** — Config resolution, multi-account merging, path resolution. `getConfig()` is the canonical way to read DingTalk config.
- **`src/auth.ts`** — Access token cache with clientId-scoped caching and retry.
- **`src/targeting/`** — Learned group/user displayName directory, target normalization, displayNameResolution gate.

### Key Patterns

- **Multi-account support**: `channels.dingtalk.accounts` allows multiple DingTalk bots. Named accounts inherit channel-level defaults with account-level overrides via `mergeAccountWithDefaults`.
- **Card fallback**: If card streaming fails, card is marked FAILED and delivery falls back to markdown/text. Priority: no message loss over card rendering fidelity.
- **Dedup + inflight protection**: `dedup.processed-message`, `session.lock`, and `channel.inflight` are process-local memory-only state. Never introduce cross-process persistence for these.
- **Peer SDK**: Types and APIs come from `openclaw/plugin-sdk`. The `tsconfig.json` paths resolve this from either `../openclaw/src/plugin-sdk` or `../../src/plugin-sdk`.

### Planned Domain Directories

New code should align with these logical boundaries (physical moves are incremental):
- `gateway/` — stream lifecycle, callbacks, inbound entry
- `targeting/` — peer identity, session aliasing, target resolution
- `messaging/` — content parsing, reply strategies, outbound delivery, message context
- `card/` — AI card lifecycle, recovery, caches
- `command/` — slash commands, feedback learning
- `platform/` — config, auth, runtime, logger, types
- `shared/` — persistence primitives, dedup, cross-domain helpers

## Code Conventions

- TypeScript strict mode, ES2023 target, ESNext modules
- 2-space indentation (oxfmt), no tabs
- Formatting: `oxfmt`; Linting: `oxlint` with unicorn/typescript/oxc plugins
- Structured log prefixes: `[DingTalk]`, `[DingTalk][AICard]`, `[accountId]`
- DingTalk API error payloads: `[DingTalk][ErrorPayload][<scope>]` with `code=... message=... payload=...`
- Send APIs return `{ ok: boolean, error?: string }`
- Use `getAccessToken()` before every DingTalk API call
- Use `getLogger()` for logging, never `console.log`
- Never suppress type errors with `@ts-ignore`
- Never log raw access tokens

## Testing

- Vitest with V8 coverage; tests in `tests/unit/` and `tests/integration/`
- All network calls are mocked (`vi.mock`) — no real DingTalk API access in tests
- Unit tests for parser, config, auth, dedup, and service logic
- Integration tests when behavior crosses module boundaries (gateway start, inbound dispatch, send lifecycle, persistence migration)
- `clearMocks`, `restoreMocks`, `mockReset` are all enabled globally in vitest config
- When work involves DingTalk real-device validation, PR-scoped test checklist generation, `验证 TODO` drafting, or contributor guidance for that workflow, read and follow `skills/dingtalk-real-device-testing/SKILL.md` first.

## Important Anti-Patterns

- Do not add business logic to `src/channel.ts`
- Do not re-introduce legacy `quote-journal.ts` or `quoted-msg-cache.ts` wrappers — use `message-context-store.ts` directly
- Do not create multiple active AI Cards for the same `accountId:conversationId`
- Do not hardcode credentials — read from `channels.dingtalk` config
- Write review comments in Simplified Chinese (per `.github/instructions/code-review.instructions.md`)
