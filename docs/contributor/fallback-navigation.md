# Fallback Navigation Without GitNexus

Use this document when GitNexus is unavailable locally and you need a manual way to find likely entry points or estimate impact before editing.

## When to Use This Document

Use this fallback guide when:

- You do not have local GitNexus access.
- GitNexus is temporarily unavailable or stale and you do not want to refresh it yet.
- You need a manual cross-check after using the base workflow.

If GitNexus is available locally, prefer `docs/contributor/gitnexus-optional.md` first.

## Manual Start Order

When you are unsure where to begin, read in this order:

1. `WORKFLOW.md`
2. `docs/contributor/agent-workflow.md`
3. `docs/contributor/architecture.zh-CN.md` or `docs/contributor/architecture.en.md`
4. The most likely feature entry point from the list below
5. Nearby unit tests and integration tests

## Where to Look First

- Plugin registration and channel assembly → `index.ts`, `src/channel.ts`
- Inbound pipeline and routing → `src/inbound-handler.ts`
- Outbound delivery and reply selection → `src/send-service.ts`, `src/reply-strategy.ts`
- AI Card lifecycle and callbacks → `src/card-service.ts`
- Message context and quote recovery → `src/message-context-store.ts`
- Targeting and learned directory behavior → `src/targeting/`

For repository rules, collaboration conventions, and validation expectations, see `docs/contributor/agent-workflow.md`.
For architecture boundaries and module placement, see `docs/contributor/architecture.zh-CN.md` or `docs/contributor/architecture.en.md`.
For test scope and real-device guidance, see `docs/contributor/testing.md`.

## Manual Impact Review Without GitNexus

When you are about to edit a symbol and GitNexus is unavailable:

1. Read the defining file first.
2. Search for direct imports and obvious callers.
3. Read nearby tests to understand expected behavior.
4. Check whether the change touches inbound handling, outbound delivery, card lifecycle, targeting, or persistence.
5. Expand validation if the change sits on one of those high-traffic paths.
