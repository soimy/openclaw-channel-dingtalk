---
applyTo: "**"
excludeAgent: "coding-agent"
---

# Copilot Code Review Instructions

When reviewing pull requests in this repository, treat `CONTRIBUTING.md` and `docs/contributor/architecture.en.md` as the source of truth.

Write all review comments in Simplified Chinese. Keep the tone professional, direct, and collaborative.

Prioritize high-confidence findings about correctness, regressions, architecture boundary erosion, missing validation, reliability, and security. Do not spend review budget on minor style nits unless they hide a real defect.

Focus on these repository-specific checks:

- Keep `src/channel.ts` thin. Flag new business logic that should live in a focused module.
- Review against the documented domains: gateway for stream lifecycle and inbound entry, targeting for peer identity and target resolution, messaging for parsing/send/reply/message context, card for AI card lifecycle, platform for config/auth/runtime/logger/types.
- Flag changes that widen unrelated modules, create generic dumping grounds such as new `utils.ts` or root-level `*-service.ts` files, or mix target resolution with delivery logic.
- Prefer logical domain placement over broad file moves. Do not require repo-wide rearrangement when a small focused change would preserve boundaries.
- Target resolution must stay deterministic. `conversationId` and related DingTalk IDs should come from platform payloads, persisted indexes, or explicit operator input, not inference or guessing.
- Treat `dedup.processed-message`, `session.lock`, and `channel.inflight` as process-local memory state. Flag any PR that introduces cross-process persistence, shared locking, or behavior changes without explicit design discussion.
- Review inbound callback flow, connection lifecycle, deduplication, and ack timing very carefully for message loss, duplicate delivery, reconnect regressions, and race conditions.
- Review quoted message recovery across text, media, file, and AI card paths. New persistence for short-lived message recovery should use `src/message-context-store.ts` directly; flag reintroduction of legacy wrapper stores such as `quote-journal` or `quoted-msg-cache`.
- For outbound and card changes, check AI card create/stream/finalize behavior, markdown fallback, and the invariant that one active card should not be created repeatedly for the same target.
- Flag code that sends DingTalk requests without token retrieval, hardcodes credentials, uses `console.log`, logs raw access tokens, or suppresses type errors with `@ts-ignore`.
- Call out missing tests when risky paths change. Expect focused unit tests for parser/config/auth/dedup/service logic and integration tests when behavior crosses module boundaries.
- If runtime behavior changes, prefer review comments that ask for explicit validation evidence for direct chat, group chat, quoted replies, media handling, AI card fallback, and duplicate/retry behavior when relevant.
- If a PR touches known sensitive areas, ask for issue-specific evidence:
  - inbound callback / stream delivery changes: timestamps, message IDs, reconciliation notes, and monitor output when possible
  - `dingtalk-stream` integration or startup behavior: Node.js version, install method, package version, and reconnect verification
  - inbound parsing or multi-image handling: reproduction steps, payload shape, scenario type, and new tests

Prefer comments that explain the concrete user-visible risk and point to the expected repository rule or module boundary.
