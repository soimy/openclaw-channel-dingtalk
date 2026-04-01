# SOURCE DIRECTORY

**Parent:** `../AGENTS.md`

## OVERVIEW

`src/` contains the full DingTalk channel implementation, now split by method category and runtime responsibility.
The current layout also includes a unified short-TTL message context store and strategy-based reply delivery modules. Legacy quote persistence wrappers have been removed from production code.

## STRUCTURE

```
src/
├── channel.ts             # Plugin assembly: config/outbound/gateway/status + exports
├── inbound-handler.ts     # Inbound workflow orchestration + quote/media context restore
├── send-service.ts        # Outbound messaging service + outbound message context persistence
├── card-service.ts        # AI Card state machine + createdAt fallback cache
├── message-context-store.ts # Unified message context persistence (`messages.context`)
├── reply-strategy.ts      # Reply strategy selection
├── reply-strategy-card.ts # AI Card delivery strategy
├── reply-strategy-markdown.ts # Markdown/text delivery strategy
├── reply-strategy-with-reaction.ts # Reaction-aware reply wrapper
├── auth.ts                # Access token management
├── access-control.ts      # DM/group policy helpers
├── message-utils.ts       # Content extraction + markdown detection
├── config.ts              # Config/account/path/target helper functions
├── dedup.ts               # Retry dedup map + cleanup strategy
├── logger-context.ts      # Shared logger context
├── media-utils.ts         # Media upload/type detection
├── connection-manager.ts  # Stream reconnect lifecycle
├── peer-id-registry.ts    # Case-preserving conversationId registry
├── onboarding.ts          # Onboarding adapter
├── runtime.ts             # Runtime setter/getter
├── config-schema.ts       # Zod schema
└── types.ts               # Shared types/constants
```

Domain subtrees used by current refactors:

```text
src/messaging/
├── attachment-text-extractor.ts # Text extraction for supported attachments
└── quoted-file-service.ts # Quote/file recovery helpers
src/targeting/
└── group-members-store.ts # Group member cache/persistence
```
## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Inbound processing main entry | `inbound-handler.ts` | `handleDingTalkMessage` |
| Inbound media download | `inbound-handler.ts` | `downloadMedia` |
| Session/proactive message send | `send-service.ts` | `sendBySession`, `sendProactive*` |
| Message mode auto-selection | `send-service.ts` | `sendMessage` card/markdown fallback |
| Reply strategy selection | `reply-strategy.ts` | `createReplyStrategy` |
| AI Card create/stream/finalize | `card-service.ts` | card lifecycle + cache |
| Unified message persistence | `message-context-store.ts` | `upsert*`, `resolveByMsgId`, `resolveByAlias`, `resolveByCreatedAtWindow` |
| Token cache | `auth.ts` | `getAccessToken` |
| Allowlist checks | `access-control.ts` | normalized allowFrom matching |
| Inbound payload parsing | `message-utils.ts` | `extractMessageContent` |
| Target/config/workspace helpers | `config.ts` | `getConfig`, `resolveRelativePath`, `stripTargetPrefix` |
| Plugin wiring | `channel.ts` | exports `dingtalkPlugin` |

## CONVENTIONS

- Keep `channel.ts` lightweight; add new behavior to service modules first.
- Cross-module reusable logic belongs in `*-service.ts` / `*-utils.ts`.
- Message quote/media/card recovery should go through `message-context-store.ts` directly.
- Preserve existing log prefix style: `[DingTalk]`, `[DingTalk][AICard]`, `[accountId]`.
- Prefer explicit comments for behavior-critical branches (authorization, retry/fallback, state transitions).

## ANTI-PATTERNS

**Prohibited:**

- Re-introducing large business logic blocks into `channel.ts`
- Bypassing token retrieval before DingTalk API calls
- Updating card cache state without terminal-state semantics
- Removing dedup guard from gateway callback path
- Re-introducing `quote-journal.ts` / `quoted-msg-cache.ts` compatibility wrappers in production paths

## UNIQUE STYLES

**Inbound Handler as Orchestrator:**

- `inbound-handler.ts` coordinates policy, routing, session recording, quote/media restoration, and reply dispatch.
- Lower-level calls are delegated to `reply-strategy.ts`, `send-service.ts`, `card-service.ts`, and `message-context-store.ts`.

**Unified Message Context Store:**

- `message-context-store.ts` is the only production persistence API for short-lived message quote/media/card context.
- Canonical `msgId` rules: inbound uses DingTalk `msgId`; outbound uses `messageId > processQueryKey > outTrackId`.
- Alias lookup covers `messageId`, `processQueryKey`, `outTrackId`, `cardInstanceId`, and inbound `msgId`.
- `createdAt` is only a scoped fallback index, not a primary key.

**Reply Strategy Design:**

- `reply-strategy.ts` selects between card and markdown/text delivery.
- `reply-strategy-card.ts` owns AI Card create/stream/finalize decisions.
- `reply-strategy-markdown.ts` owns markdown/text fallback delivery.
- `reply-strategy-with-reaction.ts` composes reaction behavior around a concrete strategy.

**Card Fallback Design:**

- If card stream fails, mark card `FAILED` and continue delivery via markdown/text path.
- Priority is no message loss over card rendering fidelity.

**No-storePath Fallback:**

- `message-context-store.ts` still supports scope-local in-memory state when `storePath` is absent.
- `card-service.ts` keeps a separate in-memory createdAt fallback bucket only for card-content recovery in no-persistence mode.

**Workspace-first Media Strategy:**

- Inbound media is persisted under the resolved agent workspace, not temp-only paths.
- This keeps files accessible to downstream sandboxed tools.
