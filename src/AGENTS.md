# SOURCE DIRECTORY

**Parent:** `./AGENTS.md`

## OVERVIEW

All DingTalk plugin implementation logic.

## STRUCTURE

```
src/
├── channel.ts        # Main plugin definition, API calls, message handling, AI Card
├── types.ts          # Type definitions (30+ interfaces, AI Card types)
├── runtime.ts        # Runtime getter/setter pattern
└── config-schema.ts  # Zod validation for configuration
```

## WHERE TO LOOK

| Task                      | Location               | Notes                                        |
| ------------------------- | ---------------------- | -------------------------------------------- |
| Channel plugin definition | `channel.ts:862`       | `dingtalkPlugin` export                      |
| AI Card operations        | `channel.ts:374-600`   | createAICard, streamAICard, finishAICard     |
| Message sending           | `channel.ts:520-700`   | sendMessage, sendBySession                   |
| Token management          | `channel.ts:156-177`   | getAccessToken with cache                    |
| Message processing        | `channel.ts:643-859`   | handleDingTalkMessage, extractMessageContent |
| Type exports              | `types.ts`             | All interfaces/constants                     |
| Public API exports        | `channel.ts:1068-1076` | sendBySession, createAICard, etc.            |

## CONVENTIONS

Same as root. No src-specific deviations.

## ANTI-PATTERNS

**Prohibited:**

- Mutating module-level state outside of initialized functions
- Creating multiple AI Card instances for same conversationId (use cached)
- Calling DingTalk APIs without access token
- Suppressing errors in async handlers

## UNIQUE STYLES

**AI Card State Machine:**

- States: PROCESSING → INPUTING → FINISHED/FAILED
- Cached in `Map<string, AICardInstance>` with TTL cleanup
- Terminal states (FINISHED/FAILED) cleaned after 1 hour

**Access Token Caching:**

- Module-level variables: `accessToken`, `accessTokenExpiry`
- Refresh 60s before expiry
- Retry logic for 401/429/5xx errors

**Message Type Handling:**

- `text`: Plain text messages
- `richText`: Extract text + @mentions
- `picture/audio/video/file`: Download to `/tmp/dingtalk_*`
- Auto-detect Markdown syntax for auto-formatting
