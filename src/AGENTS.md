# SOURCE DIRECTORY

**Parent:** `../AGENTS.md`

## OVERVIEW

`src/` contains the full DingTalk channel implementation, physically organized by the logical domains defined in `docs/contributor/architecture.en.md` (Chinese: `../docs/contributor/architecture.zh-CN.md`).
`channel.ts` is the only file left at the `src/` root; it stays as the thin assembly layer.
The layout also includes a unified short-TTL message context store and strategy-based reply delivery modules. Legacy quote persistence wrappers have been removed from production code.

## STRUCTURE

```
src/
├── channel.ts                    # Plugin assembly: config/outbound/gateway/status + exports
├── ack-reaction/                  # Ack/thinking reaction classification + delivery
│   ├── ack-reaction-classifier.ts
│   ├── ack-reaction-service.ts
│   ├── dynamic-ack-reaction-controller.ts
│   └── dynamic-ack-reaction-progress.ts
├── card/                         # AI Card lifecycle, drafts, task progress, ask-user cards
│   ├── card-service.ts           # AI Card state machine + createdAt fallback cache
│   ├── card-callback-service.ts
│   ├── card-draft-controller.ts
│   ├── draft-stream-loop.ts
│   └── run-usage-store.ts
├── command/                      # Slash commands and feedback learning
│   ├── card-stop-command.ts
│   ├── inbound-command-dispatch-service.ts
│   ├── feedback-learning-service.ts
│   ├── feedback-learning-store.ts
│   ├── learning-command-service.ts
│   └── session-command-service.ts
├── gateway/                      # Stream lifecycle, inbound pipeline, session dispatch
│   ├── channel-gateway.ts
│   ├── connection-manager.ts     # Stream reconnect lifecycle
│   ├── inbound-handler.ts        # Inbound workflow orchestration + quote/media context restore
│   ├── session-lock.ts
│   ├── docs-service.ts
│   ├── inbound-session-queue.ts
│   ├── inbound-session-queue-dispatcher.ts
│   └── reply-session-conflict.ts
├── messaging/                    # Inbound extraction, reply strategies, outbound delivery
│   ├── send-service.ts           # Outbound messaging service + outbound message context persistence
│   ├── message-utils.ts          # Content extraction + markdown detection
│   ├── message-context-store.ts  # Unified message context persistence (`messages.context`)
│   ├── media-utils.ts            # Media upload/type detection
│   ├── reply-strategy.ts         # Reply strategy selection
│   ├── reply-strategy-card.ts    # AI Card delivery strategy
│   ├── reply-strategy-markdown.ts # Markdown/text delivery strategy
│   ├── reply-strategy-with-reaction.ts # Reaction-aware reply wrapper
│   └── reply-strategy-types.ts
├── platform/                     # Config, auth, runtime, logger, shared types
│   ├── access-control.ts         # DM/group policy helpers
│   ├── auth.ts                   # Access token management
│   ├── config.ts                 # Config/account/path/target helper functions
│   ├── config-schema.ts          # Zod schema
│   ├── logger-context.ts         # Shared logger context
│   ├── onboarding.ts             # Onboarding adapter
│   ├── runtime.ts                # Runtime setter/getter
│   ├── session-state.ts          # Per-session model/effort state
│   ├── secret-input.ts
│   └── types.ts                  # Shared types/constants
├── shared/                       # Persistence primitives, dedup, generic helpers
│   ├── dedup.ts                  # Retry dedup map + cleanup strategy
│   ├── http-client.ts            # Shared axios client policy
│   ├── path-utils.ts
│   ├── persistence-store.ts
│   └── utils.ts
└── targeting/                    # Peer identity, session aliasing, target resolution
    ├── agent-name-matcher.ts
    ├── agent-routing.ts
    ├── group-members-store.ts    # Group member cache/persistence
    ├── peer-id-registry.ts       # Case-preserving conversationId registry
    ├── session-peer-store.ts
    ├── session-routing.ts
    ├── target-directory-adapter.ts
    ├── target-directory-store.ts
    └── target-input.ts
```

## WHERE TO LOOK

| Task                            | Location                             | Notes                                                                     |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| Inbound processing main entry   | `gateway/inbound-handler.ts`         | `handleDingTalkMessage`                                                   |
| Inbound media download          | `gateway/inbound-handler.ts`         | `downloadMedia`                                                           |
| Session/proactive message send  | `messaging/send-service.ts`          | `sendBySession`, `sendProactive*`                                         |
| Message mode auto-selection     | `messaging/send-service.ts`          | `sendMessage` card/markdown fallback                                      |
| Reply strategy selection        | `messaging/reply-strategy.ts`        | `createReplyStrategy`                                                     |
| AI Card create/stream/finalize  | `card/card-service.ts`               | card lifecycle + cache                                                    |
| Unified message persistence     | `messaging/message-context-store.ts` | `upsert*`, `resolveByMsgId`, `resolveByAlias`, `resolveByCreatedAtWindow` |
| Token cache                     | `platform/auth.ts`                   | `getAccessToken`                                                          |
| Allowlist checks                | `platform/access-control.ts`         | normalized allowFrom matching                                             |
| Inbound payload parsing         | `messaging/message-utils.ts`         | `extractMessageContent`                                                   |
| Target/config/workspace helpers | `platform/config.ts`                 | `getConfig`, `resolveRelativePath`, `stripTargetPrefix`                   |
| Plugin wiring                   | `channel.ts`                         | exports `dingtalkPlugin`                                                  |

## CONVENTIONS

- Keep `channel.ts` lightweight; add new behavior to the domain module first.
- New files land in the domain directory (`gateway/`, `targeting/`, `messaging/`, `card/`, `command/`, `platform/`, `shared/`) that answers the question the code is responsible for; do not add new `src/` root-level modules.
- Cross-module reusable logic belongs in `shared/`.
- Message quote/media/card recovery should go through `messaging/message-context-store.ts` directly.
- Preserve existing log prefix style: `[DingTalk]`, `[DingTalk][AICard]`, `[accountId]`.
- Prefer explicit comments for behavior-critical branches (authorization, retry/fallback, state transitions).

## ANTI-PATTERNS

**Prohibited:**

- Re-introducing large business logic blocks into `channel.ts`
- Adding new flat modules at the `src/` root
- Bypassing token retrieval before DingTalk API calls
- Updating card cache state without terminal-state semantics
- Removing dedup guard from gateway callback path
- Re-introducing `quote-journal.ts` / `quoted-msg-cache.ts` compatibility wrappers in production paths

## UNIQUE STYLES

**Inbound Handler as Orchestrator:**

- `gateway/inbound-handler.ts` coordinates policy, routing, session recording, quote/media restoration, and reply dispatch.
- Lower-level calls are delegated to `messaging/reply-strategy.ts`, `messaging/send-service.ts`, `card/card-service.ts`, and `messaging/message-context-store.ts`.

**Unified Message Context Store:**

- `messaging/message-context-store.ts` is the only production persistence API for short-lived message quote/media/card context.
- Canonical `msgId` rules: inbound uses DingTalk `msgId`; outbound uses `messageId > processQueryKey > outTrackId`.
- Alias lookup covers `messageId`, `processQueryKey`, `outTrackId`, `cardInstanceId`, and inbound `msgId`.
- `createdAt` is only a scoped fallback index, not a primary key.

**Reply Strategy Design:**

- `messaging/reply-strategy.ts` selects between card and markdown/text delivery.
- `messaging/reply-strategy-card.ts` owns AI Card create/stream/finalize decisions.
- `messaging/reply-strategy-markdown.ts` owns markdown/text fallback delivery.
- `messaging/reply-strategy-with-reaction.ts` composes reaction behavior around a concrete strategy.

**Card Fallback Design:**

- If card stream fails, mark card `FAILED` and continue delivery via markdown/text path.
- Priority is no message loss over card rendering fidelity.

**No-storePath Fallback:**

- `messaging/message-context-store.ts` still supports scope-local in-memory state when `storePath` is absent.
- `card/card-service.ts` keeps a separate in-memory createdAt fallback bucket only for card-content recovery in no-persistence mode.

**Workspace-first Media Strategy:**

- Inbound media is persisted under the resolved agent workspace, not temp-only paths.
- This keeps files accessible to downstream sandboxed tools.
