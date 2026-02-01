# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-31
**Type:** OpenClaw DingTalk Channel Plugin

## OVERVIEW

DingTalk (钉钉) enterprise bot channel plugin using Stream mode (WebSocket, no public IP required). Part of OpenClaw ecosystem.

## STRUCTURE

```
./
├── src/
│   ├── channel.ts        # Main plugin logic (API, messaging, AI Card) - 1076 lines
│   ├── types.ts          # 30+ type definitions - 493 lines
│   ├── runtime.ts        # Runtime getter/setter - 14 lines
│   └── config-schema.ts  # Zod validation schema - 58 lines
├── index.ts            # Plugin registration entry point - 18 lines
├── utils.ts            # Utilities (retry, masking, temp cleanup) - 107 lines
└── [config files]     # package.json, tsconfig.json, .eslintrc.json
```

## WHERE TO LOOK

| Task                   | Location               | Notes                         |
| ---------------------- | ---------------------- | ----------------------------- |
| Plugin registration    | `index.ts`             | Exports default plugin object |
| Channel implementation | `src/channel.ts`       | All DingTalk-specific logic   |
| Type definitions       | `src/types.ts`         | 30+ interfaces, AI Card types |
| Configuration schema   | `src/config-schema.ts` | Zod validation                |
| Utilities              | `utils.ts`             | Retry, data masking, cleanup  |
| Runtime access         | `src/runtime.ts`       | Getter/setter pattern         |

## CODE MAP

| Symbol                 | Type      | Location               | Role                            |
| ---------------------- | --------- | ---------------------- | ------------------------------- |
| dingtalkPlugin         | const     | src/channel.ts:862     | Main channel plugin definition  |
| createAICard           | function  | src/channel.ts:374     | Create AI Card instance         |
| streamAICard           | function  | src/channel.ts:475     | Stream AI Card content          |
| finishAICard           | function  | src/channel.ts:556     | Finalize AI Card                |
| handleDingTalkMessage  | function  | src/channel.ts:643     | Process inbound messages        |
| sendBySession          | function  | src/channel.ts:333     | Send via session webhook        |
| sendMessage            | function  | src/channel.ts:610     | Auto send (card/text/markdown)  |
| getAccessToken         | function  | src/channel.ts:156     | Get/cached DingTalk token       |
| downloadMedia          | function  | src/channel.ts:253     | Download media files            |
| DingTalkConfig         | interface | src/types.ts:17        | Plugin configuration            |
| DingTalkInboundMessage | interface | src/types.ts:100       | Inbound message from Stream API |
| AICardInstance         | interface | src/types.ts:424       | AI Card cache entry             |
| AICardStatus           | const     | src/types.ts:408       | Card state constants            |
| DingTalkConfigSchema   | const     | src/config-schema.ts:7 | Zod validation schema           |

## CONVENTIONS

**Code Style:**

- TypeScript strict mode enabled
- ES2020 target, ESNext modules
- 4-space indentation (Prettier)
- Export public API from `src/channel.ts` (sendBySession, createAICard, streamAICard, finishAICard, sendMessage, getAccessToken)

**Naming:**

- Private functions: camelCase (e.g., `normalizeAllowFrom`, `detectMarkdownAndExtractTitle`)
- Exported functions: camelCase
- Type interfaces: PascalCase (e.g., `DingTalkConfig`, `AICardInstance`)
- Constants: UPPER_SNAKE_CASE (e.g., `AICardStatus`, `CARD_CACHE_TTL`)

**Error Handling:**

- Use `try/catch` for all async API calls
- Log errors with structured format: `[DingTalk][Context] message`
- Return `{ ok: boolean, error?: string }` for send operations
- Retry with exponential backoff (max 3 retries) for 401/429/5xx errors

**State Management:**

- Access token cached in module-level variable with expiry
- AI Card instances cached in `Map<string, AICardInstance>`
- Card cache cleanup runs every 30 minutes (TTL: 1 hour for terminal states)
- Runtime stored via getter/setter pattern in `src/runtime.ts`

**Monorepo Structure:**

- Extends `../../tsconfig.json` (parent repo)
- Path mapping: `openclaw/plugin-sdk` → `../../src/plugin-sdk/index.ts`
- Dev dependency: `openclaw: workspace:*`

## ANTI-PATTERNS (THIS PROJECT)

**Prohibited:**

- Sending messages without access token (must call `getAccessToken()` first)
- Creating multiple AI Cards for same conversation (use cached instance)
- Hardcoding credentials (use config from `channels.dingtalk`)
- Suppressing type errors with `@ts-ignore` (use proper typing)
- Using `console.log` (use logger: `log?.info`, `log?.error`, etc.)
- Leaving temp files in OS temp directory (call `cleanupOrphanedTempFiles()`)
- Not masking sensitive data in logs (use `maskSensitiveData()`)

**Security:**

- Never log raw access tokens (masked to 3 chars)
- Validate `dmPolicy` before allowing DM messages
- Check `allowFrom` list for allowlist mode
- Normalize sender IDs (remove `dingtalk:`, `dd:`, `ding:` prefixes)

## UNIQUE STYLES

**AI Card Flow:**

1. Create card instance → cache with state=PROCESSING
2. Switch to INPUTING state on first stream update
3. Stream content via `/v1.0/card/streaming` API
4. Finalize with FINISHED state + isFinalize=true

**Message Processing Pipeline:**

1. Filter self-messages (senderId === chatbotUserId)
2. Extract content (text/richText/media)
3. Download media to temp dir if present
4. Check authorization (dmPolicy + allowFrom)
5. Route to agent via OpenClaw runtime
6. Create AI Card if messageType=card
7. Send "thinking..." message
8. Stream AI response via dispatcher

**Media Handling:**

- Download to `/tmp/dingtalk_<timestamp>.<ext>`
- Auto-delete temp files after use
- Clean up orphaned files (>24h old) on startup

**Markdown Detection:**

- Auto-detect: checks for `#`, `*`, `>`, `-`, `[`, `\n`
- Extract title from first line (strip `#*` prefix, limit to 20 chars)
- Fallback title: "Clawdbot 消息"

## COMMANDS

```bash
# Type check
npm run type-check

# Lint
npm run lint

# Lint + fix
npm run lint:fix
```

**Note:** No build script - plugin runs directly via OpenClaw runtime.

## NOTES

**OpenClaw Plugin Architecture:**

- Entry point: `index.ts` exports default plugin object
- Plugin register: `register(api: OpenClawPluginApi)` called by runtime
- Channel registration: `api.registerChannel({ plugin: dingtalkPlugin })`
- Configuration: Read from `cfg.channels.dingtalk`
- Multiple accounts supported via `accounts` object in config

**DingTalk API:**

- Base URL: `https://api.dingtalk.com`
- Token endpoint: `/v1.0/oauth2/accessToken`
- Media download: `/v1.0/robot/messageFiles/download`
- AI Card create: `/v1.0/card/instances`
- AI Card deliver: `/v1.0/card/instances/deliver`
- AI Card stream: `/v1.0/card/streaming`

**Package.json Issue:**

- `openclaw` configuration object duplicated (lines 37-63 and 64-90)

**Dependencies:**

- `dingtalk-stream` (v2.1.4) - WebSocket Stream client
- `axios` (v1.6.0) - HTTP client
- `zod` (v4.3.6) - Schema validation

**No Tests:**

- No test files or test configs present
- Testing likely done at OpenClaw monorepo root
