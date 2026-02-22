# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-22
**Type:** OpenClaw DingTalk Channel Plugin

## OVERVIEW

DingTalk (钉钉) enterprise bot channel plugin using Stream mode (WebSocket, no public IP required). Part of OpenClaw ecosystem.

Current architecture is modularized by responsibility. `src/channel.ts` is now an assembly layer; heavy logic is split into dedicated modules.

## STRUCTURE

```
./
├── index.ts                   # Plugin registration entry point
├── src/
│   ├── channel.ts             # Channel definition + gateway wiring + public exports
│   ├── inbound-handler.ts     # Inbound pipeline (authz, routing, dispatch, card finalize)
│   ├── send-service.ts        # Outbound send (session/proactive/text/media/card fallback)
│   ├── card-service.ts        # AI Card lifecycle + cache + stream/finalize
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
| AI Card operations | `src/card-service.ts` | `createAICard`, `streamAICard`, `finishAICard` |
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
| `createAICard` | function | `src/card-service.ts` | Create and cache AI Card |
| `streamAICard` | function | `src/card-service.ts` | Stream updates to AI Card |
| `finishAICard` | function | `src/card-service.ts` | Finalize AI Card |
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
- Send APIs return `{ ok: boolean, error?: string }` where applicable
- Retry with exponential backoff for transient HTTP failures (401/429/5xx)

**State Management:**

- Access token cache in `src/auth.ts`
- AI Card caches in `src/card-service.ts` (`aiCardInstances`, `activeCardsByTarget`)
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

**Message Processing Pipeline:**

1. Dedup check by bot-scoped key (`robotKey:msgId`)
2. Filter self-messages
3. Extract text/media content
4. Authorization check (`dmPolicy` / `groupPolicy`)
5. Resolve route + session + workspace
6. Download media into agent workspace if present
7. Dispatch to runtime reply pipeline
8. Stream/finalize AI Card (or fallback to text/markdown)

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
