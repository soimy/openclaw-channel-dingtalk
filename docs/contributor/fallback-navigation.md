# Fallback Navigation Without GitNexus

Use this document when GitNexus is unavailable locally and you need a manual way to understand repository structure, find likely entry points, or estimate impact before editing.

## When to Use This Document

Use this fallback guide when:

- You do not have local GitNexus access.
- GitNexus is temporarily unavailable or stale and you do not want to refresh it yet.
- You need a manual cross-check after using the base workflow.

If GitNexus is available locally, prefer `docs/contributor/gitnexus-optional.md` first.

## Manual Start Order

When you are unsure where to begin, read in this order:

1. `docs/contributor/architecture.zh-CN.md` or `docs/contributor/architecture.en.md`
2. `WORKFLOW.md`
3. `docs/contributor/agent-workflow.md`
4. The most likely feature entry point from the list below
5. Nearby unit tests and integration tests

## Where to Find Key Behaviors

### Plugin registration and channel assembly

- `index.ts` — plugin registration entry point
- `src/channel.ts` — channel assembly, public wiring, and root exports

### Inbound pipeline and routing

- `src/inbound-handler.ts` — inbound message pipeline orchestration
- `src/session-routing.ts` — session and peer routing helpers
- `src/access-control.ts` — DM and group allowlist logic
- `src/dedup.ts` — bot-scoped dedup logic

### Outbound delivery and reply selection

- `src/send-service.ts` — outbound send behavior
- `src/reply-strategy.ts` — reply strategy selection entry
- `src/reply-strategy-card.ts` — AI Card reply delivery
- `src/reply-strategy-markdown.ts` — markdown and text reply fallback
- `src/reply-strategy-with-reaction.ts` — reaction lifecycle wrapper

### AI Card lifecycle and callbacks

- `src/card-service.ts` — AI Card lifecycle, recovery, and caches
- `src/card-callback-service.ts` — card callback handling
- `src/card-draft-controller.ts` — card draft buffering and state transitions

### Message context and quote recovery

- `src/message-context-store.ts` — only production API for quote, media, and card context persistence
- `src/messaging/quoted-context.ts` — quoted context assembly
- `src/messaging/quoted-ref.ts` — structured quoted reference helpers
- `src/messaging/quoted-file-service.ts` — quote and file recovery helpers

### Targeting and learned directory behavior

- `src/targeting/target-directory-store.ts` — learned group and user target persistence
- `src/targeting/target-directory-adapter.ts` — directory bridge and `displayNameResolution` gate
- `src/targeting/target-input.ts` — target normalization and ID heuristics
- `src/peer-id-registry.ts` — case-sensitive conversation ID recovery

### Config, auth, and runtime

- `src/config.ts` — config resolution and path helpers
- `src/config-schema.ts` — config validation schema
- `src/auth.ts` — access token caching and retry
- `src/runtime.ts` — runtime getter and setter
- `src/logger-context.ts` — shared logger access

## Manual Impact Review Without GitNexus

When you are about to edit a symbol and GitNexus is unavailable:

1. Read the defining file first.
2. Search for direct imports and obvious callers.
3. Read nearby tests to understand expected behavior.
4. Check whether the symbol participates in inbound handling, outbound delivery, card lifecycle, targeting, or persistence.
5. Expand validation if the symbol sits on one of those high-traffic paths.

## High-Value Runtime Flows

### Inbound message processing

A typical inbound flow goes through:

1. Dedup check
2. Self-message filtering
3. Content extraction
4. Authorization check
5. Route and session resolution
6. Media download when needed
7. Message context persistence
8. Runtime dispatch
9. Reply delivery via selected strategy

Primary files:
- `src/inbound-handler.ts`
- `src/message-utils.ts`
- `src/access-control.ts`
- `src/session-routing.ts`
- `src/message-context-store.ts`
- `src/reply-strategy.ts`

### Reply delivery

A typical reply flow goes through:

1. `src/reply-strategy.ts` chooses the strategy
2. `src/reply-strategy-card.ts` handles AI Card create/stream/finalize logic
3. `src/reply-strategy-markdown.ts` handles markdown and text fallback
4. `src/reply-strategy-with-reaction.ts` wraps delivery with reaction lifecycle when enabled

### Message context and quote recovery

A typical quote and context flow goes through:

1. Inbound content is persisted in `src/message-context-store.ts`
2. Outbound sends persist aliases after success
3. Quote recovery first uses aliases and only falls back to looser matching when needed

## Key Repository Facts to Remember

- `src/channel.ts` is an assembly layer and should stay thin.
- `src/message-context-store.ts` is the only production message context persistence API.
- Do not reintroduce `quote-journal.ts` or `quoted-msg-cache.ts`.
- Use `getAccessToken()` before DingTalk API calls.
- Use `getLogger()` instead of `console.log`.
- Never log raw access tokens.
- `displayNameResolution` defaults to `disabled`; only `all` enables learned display name resolution.
- Multi-account behavior is centered on `channels.dingtalk.accounts`, where named accounts inherit channel-level defaults unless overridden.
- Card streaming failure should preserve delivery by falling back to markdown or text instead of dropping the reply.
- Dedup and inflight protection are process-local memory-only safeguards and should not be moved into cross-process persistence.

## Testing Pointers

- Unit tests live under `tests/unit/`.
- Integration tests live under `tests/integration/`.
- Network calls are mocked in tests; do not expect real DingTalk API access during automated test runs.
- For docs or workflow changes, run `pnpm run docs:build`.
- For code changes, the typical baseline is `pnpm run type-check`, `pnpm run lint`, and relevant tests.
- For DingTalk user-visible behavior changes, also follow `docs/contributor/testing.md`.
