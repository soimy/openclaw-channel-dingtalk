# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-18
**Type:** OpenClaw DingTalk Channel Plugin

## OVERVIEW

DingTalk (钉钉) enterprise bot channel plugin using Stream mode (WebSocket, no public IP required). Part of OpenClaw ecosystem.

Current architecture is modularized by responsibility. `src/channel.ts` is now an assembly layer; heavy logic is split into dedicated modules.
Recent refactors unified short-lived message persistence into `src/message-context-store.ts` and split reply delivery selection into dedicated `reply-strategy*` modules.

## STRUCTURE

```
./
├── index.ts                   # Plugin registration entry point
├── src/
│   ├── channel.ts             # Channel definition + gateway wiring + public exports
│   ├── inbound-handler.ts     # Inbound pipeline (authz, routing, quote restore, dispatch orchestration)
│   ├── send-service.ts        # Outbound send (session/proactive/text/media/card fallback)
│   ├── card-service.ts        # AI Card lifecycle + cache + createdAt fallback cache
│   ├── message-context-store.ts # Unified short-TTL message context persistence
│   ├── reply-strategy.ts      # Reply strategy selection entry
│   ├── reply-strategy-card.ts # AI Card reply strategy
│   ├── reply-strategy-markdown.ts # Markdown/text reply strategy
│   ├── reply-strategy-with-reaction.ts # Reply wrapper for reaction lifecycle
│   ├── auth.ts                # Access token cache + retry
│   ├── access-control.ts      # allowFrom normalization + allowlist checks
│   ├── message-utils.ts       # markdown/title detection + inbound content extraction
│   ├── config.ts              # config/account/agent workspace/target prefix helpers
│   ├── dedup.ts               # inbound message dedup with TTL + lazy cleanup
│   ├── logger-context.ts      # shared logger getter/setter
│   ├── media-utils.ts         # media type detect + upload
│   ├── connection-manager.ts  # robust stream connection lifecycle
│   ├── peer-id-registry.ts    # preserve case-sensitive conversationId mapping
│   ├── onboarding.ts          # channel onboarding adapter
│   ├── runtime.ts             # runtime getter/setter
│   ├── config-schema.ts       # Zod validation schema
│   └── types.ts               # shared types/constants
└── [config files]             # package.json, tsconfig.json, .eslintrc.json
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Plugin registration | `index.ts` | Exports default plugin object |
| Channel assembly | `src/channel.ts` | Defines `dingtalkPlugin`; wires gateway/outbound/status |
| Inbound message handling | `src/inbound-handler.ts` | `handleDingTalkMessage`, `downloadMedia` |
| Text/media sending | `src/send-service.ts` | `sendBySession`, `sendProactive*`, `sendMessage` |
| Reply strategy selection | `src/reply-strategy.ts` | `createReplyStrategy` |
| AI Card operations | `src/card-service.ts` | `createAICard`, `streamAICard`, `finishAICard` |
| Message context persistence | `src/message-context-store.ts` | `upsertInboundMessageContext`, `upsertOutboundMessageContext`, `resolveByMsgId`, `resolveByAlias` |
| Token management | `src/auth.ts` | `getAccessToken` with clientId-scoped cache |
| Access control | `src/access-control.ts` | DM/group allowlist helpers |
| Message parsing | `src/message-utils.ts` | quote parsing + richText/media extraction |
| Config/path helpers | `src/config.ts` | `getConfig`, `resolveRelativePath`, `stripTargetPrefix` |
| Deduplication | `src/dedup.ts` | message retry dedup keys |
| Type definitions | `src/types.ts` | DingTalk and plugin types/constants |

## CODE MAP

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `dingtalkPlugin` | const | `src/channel.ts` | Main channel plugin definition |
| `handleDingTalkMessage` | function | `src/inbound-handler.ts` | Process inbound messages end-to-end |
| `downloadMedia` | function | `src/inbound-handler.ts` | Download inbound media via runtime media service |
| `sendBySession` | function | `src/send-service.ts` | Send replies via session webhook |
| `sendMessage` | function | `src/send-service.ts` | Auto send (card/text/markdown fallback) |
| `sendProactiveMedia` | function | `src/send-service.ts` | Proactive media send |
| `createReplyStrategy` | function | `src/reply-strategy.ts` | Select reply implementation by mode/capability |
| `createAICard` | function | `src/card-service.ts` | Create and cache AI Card |
| `streamAICard` | function | `src/card-service.ts` | Stream updates to AI Card |
| `finishAICard` | function | `src/card-service.ts` | Finalize AI Card |
| `upsertInboundMessageContext` | function | `src/message-context-store.ts` | Persist inbound message context by canonical msgId |
| `upsertOutboundMessageContext` | function | `src/message-context-store.ts` | Persist outbound message context + delivery aliases |
| `resolveByMsgId` | function | `src/message-context-store.ts` | Resolve unified message record by canonical/inbound msgId |
| `resolveByAlias` | function | `src/message-context-store.ts` | Resolve outbound record by `messageId/processQueryKey/outTrackId/cardInstanceId` |
| `getAccessToken` | function | `src/auth.ts` | Get/cached DingTalk token |
| `extractMessageContent` | function | `src/message-utils.ts` | Normalize inbound msg payload |
| `normalizeAllowFrom` | function | `src/access-control.ts` | Normalize allowlist entries |
| `isMessageProcessed` | function | `src/dedup.ts` | Message dedup check |
| `DingTalkConfigSchema` | const | `src/config-schema.ts` | Zod validation schema |
| `AICardStatus` | const | `src/types.ts` | AI Card state constants |

## CONVENTIONS

**Code Style:**

- TypeScript strict mode enabled
- ES2020 target, ESNext modules
- 4-space indentation (Prettier)
- Public low-level API exported from `src/channel.ts` (re-exported from service modules)

**Naming:**

- Private functions: camelCase
- Exported functions: camelCase
- Type interfaces: PascalCase
- Constants: UPPER_SNAKE_CASE

**Error Handling:**

- Use `try/catch` for async API calls
- Log with structured prefixes (e.g. `[DingTalk]`, `[DingTalk][AICard]`)
- For DingTalk API error payloads, use unified prefix format:
  - Standard: `[DingTalk][ErrorPayload][<scope>]`
  - AI Card: `[DingTalk][AICard][ErrorPayload][<scope>]`
  - Include `code=<...> message=<...> payload=<...>` for fast diagnosis
- Send APIs return `{ ok: boolean, error?: string }` where applicable
- Retry with exponential backoff for transient HTTP failures (401/429/5xx)

**State Management:**

- Access token cache in `src/auth.ts`
- AI Card caches in `src/card-service.ts` (`aiCardInstances`, `activeCardsByTarget`)
- Unified short-TTL message contexts in `src/message-context-store.ts` under namespace `messages.context`
- Card createdAt fallback keeps an in-memory-only bucket in `src/card-service.ts` when no `storePath` is available
- Message dedup state in `src/dedup.ts`
- Runtime stored via getter/setter in `src/runtime.ts`

## ANTI-PATTERNS (THIS PROJECT)

**Prohibited:**

- Sending messages without token retrieval (`getAccessToken`)
- Creating multiple active AI Cards for same `accountId:conversationId`
- Hardcoding credentials (must read `channels.dingtalk`)
- Suppressing type errors with `@ts-ignore`
- Using `console.log` (use logger)
- Logging raw sensitive token data
- Re-introducing `quote-journal.ts` / `quoted-msg-cache.ts`-style wrapper persistence layers instead of using `message-context-store` directly

**Security:**

- Validate `dmPolicy` / `groupPolicy` before command dispatch
- Respect allowlist (`allowFrom`) in allowlist modes
- Normalize sender IDs (strip `dingtalk:`, `dd:`, `ding:` prefixes)

## UNIQUE STYLES

**AI Card Flow:**

1. Create card and cache with `PROCESSING`
2. Stream updates with full replacement (`isFull=true`)
3. Transition state to `INPUTING` on first stream
4. Finalize with `isFinalize=true` and `FINISHED`
5. Fallback to markdown send when card stream fails

**Reply Delivery Flow:**

1. `inbound-handler.ts` builds reply context and selects a strategy via `createReplyStrategy`
2. `reply-strategy-card.ts` owns AI Card creation/stream/finalize decisions
3. `reply-strategy-markdown.ts` handles markdown/text send fallback
4. `reply-strategy-with-reaction.ts` wraps strategy execution with reaction lifecycle when enabled

**Unified Message Context Flow:**

1. Inbound messages persist text/media into `messages.context` keyed by canonical `msgId`
2. Outbound messages persist after send succeeds using `messageId > processQueryKey > outTrackId` as canonical fallback
3. Alias lookup supports `messageId`, `processQueryKey`, `outTrackId`, `cardInstanceId`, and inbound `msgId`
4. Quote recovery prefers alias lookup and only uses `createdAt` window as fallback
5. Old persistence wrappers are removed; production code should call `message-context-store` directly

**Message Processing Pipeline:**

1. Dedup check by bot-scoped key (`robotKey:msgId`)
2. Filter self-messages
3. Extract text/media content
4. Authorization check (`dmPolicy` / `groupPolicy`)
5. Resolve route + session + workspace
6. Download media into agent workspace if present
7. Persist inbound quote/media context into `messages.context`
8. Dispatch to runtime reply pipeline
9. Deliver via selected reply strategy

**Media Handling:**

- Inbound media saved to `<agent-workspace>/media/inbound`
- Outbound media uploaded then sent by DingTalk media template messages
- Orphaned temp cleanup at gateway startup

## COMMANDS

```bash
# Type check
npm run type-check

# Lint
npm run lint

# Lint + fix
npm run lint:fix

# Unit + integration tests
pnpm test

# Coverage report (V8)
pnpm test:coverage
```

**Note:** No build script; plugin runs directly via OpenClaw runtime.

## NOTES

**OpenClaw Plugin Architecture:**

- `index.ts` registers `dingtalkPlugin`
- Runtime set once via `setDingTalkRuntime(api.runtime)`
- Multi-account config supported via `channels.dingtalk.accounts`
- Message quote/media recovery is unified through `messages.context`; no backward-compatible read path exists for removed legacy namespaces

**DingTalk API Endpoints Used:**

- Token: `/v1.0/oauth2/accessToken`
- Media download: `/v1.0/robot/messageFiles/download`
- Proactive send: `/v1.0/robot/groupMessages/send`, `/v1.0/robot/oToMessages/batchSend`
- AI Card create+deliver: `/v1.0/card/instances/createAndDeliver`
- AI Card stream: `/v1.0/card/streaming`

**Testing:**

- Vitest test suite is initialized with unit + integration coverage under `tests/`
- Network calls are mocked in tests (`vi.mock`), no real DingTalk API requests are made
- CI should run `pnpm test` on every push and pull request
- Coverage can be generated with `pnpm test:coverage`
