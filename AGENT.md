# DingTalk Channel Extension - Agent Analysis & Development Guide

**Date**: 2026-01-27  
**Status**: Repository initialized with comprehensive agent analysis framework  
**Project**: DingTalk/钉钉 Integration Channel for clawd  

---

## Quick Start

This repository is a **DingTalk plugin extension** for the clawd platform. It provides DingTalk/钉钉 messaging channel integration.

### Key Files
- `index.js` - Original plugin bootstrap
- `plugin.ts` - TypeScript implementation (main)
- `clawdbot.plugin.json` - Plugin manifest
- `package.json` - Dependencies & config
- `README.md` - Project documentation

---

## Discovery Map

### File Structure
```
dingtalk-channel/
├── index.js                   # Plugin entry point
├── plugin.ts                  # Main TypeScript implementation
├── clawdbot.plugin.json      # Plugin metadata & config
├── package.json              # Dependencies
├── package-lock.json         # Locked versions
├── README.md                 # Documentation
├── test.js                   # Test suite
├── node_modules/             # Dependencies
└── .git/                      # Version control
```

### Technology Stack
- **Language**: TypeScript / JavaScript (Node.js)
- **Plugin System**: clawd plugin architecture
- **Integration**: DingTalk API (钉钉)
- **Runtime**: Node.js
- **Package Manager**: npm

---

## Development Workflow

### Phase 1: Search & Analysis (EXHAUSTIVE)
This guide uses parallel background agents to understand:

1. **Codebase Patterns** - Internal structure, conventions, implementations
2. **Architecture** - How components interact, data flow
3. **External Dependencies** - DingTalk SDK behavior, clawd plugin API
4. **Conventions** - Naming, error handling, testing patterns

### Phase 2: Context Synthesis
Before implementation, gather:
- Existing authentication patterns
- Error handling strategies
- Testing frameworks
- Type safety approach (TypeScript enforcement)
- DingTalk API integration patterns

### Phase 3: Implementation
Follow established codebase patterns. Match:
- Code style and conventions
- Error handling approach
- Type definitions
- Test organization

---

## Important Notes

### TypeScript Enforcement
- Project uses TypeScript (`plugin.ts`)
- NO `as any`, `@ts-ignore`, `@ts-expect-error` allowed
- Type errors must be resolved properly

### Git Workflow
- Changes are NOT auto-committed
- Explicit `git commit` requests required
- No force pushes without explicit approval

### Testing
- Test suite exists (`test.js`)
- Run tests before marking tasks complete
- Pre-existing test failures should be noted

---

## Background Agent Tasks - COMPLETED ✅

### Agent Results Summary

#### [EXPLORE-1] Codebase Patterns & TypeScript Usage ✅
- **Key Finding**: Single-file TypeScript plugin using DingTalk Stream mode (WebSocket)
- **Type System**: Uses external types from `clawdbot/plugin-sdk`; defines `MessageContent` interface
- **Error Handling**: Try/catch blocks with graceful degradation (media downloads return null on failure)
- **Async Pattern**: Modern async/await throughout; no callbacks except where required by libraries
- **Config Pattern**: Module-level variables for runtime, accessToken cache with TTL

#### [EXPLORE-2] Plugin Architecture & Entry Points ✅
- **Entry Point**: `plugin.ts` exports default plugin object with `register(api)` method
- **Lifecycle**: 
  - `gateway.startAccount()` - Initializes DWClient, connects via WebSocket, sets up message listener
  - `abortSignal` - Graceful shutdown on system abort
- **Channel Definition**: `dingtalkPlugin` object implements channel interface with capabilities, security, routing
- **Messaging**: Direct and group chats supported; replies via sessionWebhook or proactive OpenAPI

#### [EXPLORE-3] Test & Build Configuration ✅
- **Testing**: Manual integration testing via `test.js` (echo bot pattern)
- **Build**: No pre-build step; uses `jiti` to load TypeScript at runtime
- **Quality Gates**: Currently lacking automated QA; relies on manual execution
- **Scripts**: `npm test` runs test.js; `npm run build` is a no-op

#### [EXPLORE-4] Message Flow & Data Transformation ✅
- **Inbound Chain**: WebSocket message → JSON parse → extractMessageContent → downloadMedia → resolveAgentRoute → recordInboundSession → finalizeInboundContext → Clawdbot AI pipeline
- **Outbound Chain**: AI response → createReplyDispatcher → deliver callback → sendBySession → sessionWebhook POST
- **Media Handling**: Downloads to temp files; auto-cleanup in finally block
- **Session Management**: Records inbound sessions using Clawdbot session API

#### [LIBRARIAN-1] DingTalk SDK & API Patterns ✅
- **SDK**: `dingtalk-stream` v2.1.4 (WebSocket-based, no public IP required)
- **Authentication**: AppKey/AppSecret OAuth → access token with 7200s TTL and cache
- **Message Types**: text, richText, picture, audio, video, file (all supported)
- **APIs**:
  - `GET /v1.0/oauth2/accessToken` - Token refresh
  - `POST /v1.0/robot/messageFiles/download` - Media download
  - `POST /v1.0/robot/groupMessages/send` - Group message
  - `POST /v1.0/robot/oToMessages/send` - Direct message
- **Rate Limits**: ~20 messages/min; implement backoff for error 88
- **Error Codes**: 300001 (token expired), 40003 (invalid auth), 88 (rate limit)

#### [EXPLORE-5] Security & Configuration ✅
- **Credentials**: clientId, clientSecret, robotCode loaded from ClawdbotConfig
- **Token Management**: In-memory cache with 60s buffer before expiry (prevents race conditions)
- **Token Refresh**: POST to `/v1.0/oauth2/accessToken` with credentials
- **Policies**: dmPolicy (open/pairing/allowlist), groupPolicy (open/allowlist)
- **Filtering**: Self-message filtering to prevent infinite loops; mention requirements in groups
- **Validation**: Explicit check in startAccount; probe method for health check
- **API Security**: Uses access tokens in headers `x-acs-dingtalk-access-token`
- **Vulnerabilities Found**:
  - Debug logging includes full JSON (PII risk) - disable in production
  - Temp file cleanup on crash - consider startup cleanup routine
  - Token expiry race in high-concurrency - implement 401 retry
- **Recommendations**:
  - Mask sensitive fields before logging
  - Deprecate index.js in favor of plugin-native testing
  - Add background cleanup for orphaned temp files

#### [LIBRARIAN-2] Clawdbot Plugin API ✅
- **Plugin Structure**: TypeScript modules with `plugin.ts` entry point
- **Manifest**: `clawdbot.plugin.json` defines id, name, version, configSchema
- **Registration**: `register(api: ClawdbotPluginApi)` receives runtime API
- **Channels**: `api.registerChannel({plugin: channelDefinition})` registers messaging surface
- **Gateway Methods**: `api.registerGatewayMethod(name, handler)` for RPC-style calls
- **Configuration**: `api.config` provides typed config from host config file
- **Lifecycle**: Startup phase, shutdown phase, config reload support
- **Message Ingestion**: Push messages via `api.runtime.ingress.pushMessage()`
- **Conventions**: snake_case for tools, kebab-case for plugin IDs, try-catch everywhere

---

## Architecture Summary

### Message Flow Diagram
```
DingTalk API (WebSocket Stream)
    ↓
plugin.ts: registerCallbackListener(TOPIC_ROBOT)
    ↓
handleDingTalkMessage({cfg, accountId, data, sessionWebhook})
    ├─→ extractMessageContent() → MessageContent
    ├─→ downloadMedia() → local temp path
    ├─→ rt.channel.routing.resolveAgentRoute() → {agentId, sessionKey}
    ├─→ rt.channel.session.recordInboundSession()
    └─→ rt.channel.reply.dispatchReplyFromConfig()
        ├─→ AI Processing
        └─→ createReplyDispatcher()
            └─→ deliver() → sendBySession() → sessionWebhook
                └─→ POST to DingTalk sessionWebhook
                    ↓
                DingTalk Sends Message to User
```

### File Structure & Responsibilities
```
plugin.ts (392 LOC) - MAIN PLUGIN
├─ Constants
│  ├─ id = 'dingtalk'
│  ├─ runtime: PluginRuntime (module-level)
│  ├─ accessToken + TTL cache (module-level)
│
├─ Core Functions (6 async, 5 sync)
│  ├─ getRuntime() - Runtime getter with null check
│  ├─ getConfig(cfg) - Extract dingtalk config from global config
│  ├─ isConfigured(cfg) - Check if clientId/clientSecret present
│  ├─ getAccessToken(config) - OAuth with caching
│  ├─ sendProactiveMessage(config, target, text) - OpenAPI send
│  ├─ downloadMedia(config, downloadCode) - Media fetch to temp
│  ├─ sendBySession(config, webhook, text, options) - Webhook send
│  └─ handleDingTalkMessage(params) - Main message processor
│
├─ Type Definitions
│  └─ MessageContent interface
│
└─ Plugin Definition
   ├─ dingtalkPlugin: { id, meta, capabilities, config, security, ... }
   └─ plugin: { id, name, description, register(api) }

index.js (248 LOC) - LEGACY STANDALONE
├─ DingTalkChannel class - Original implementation
└─ Test runner (if require.main === module)

clawdbot.plugin.json - METADATA
├─ id, name, version, channels
├─ configSchema for root
└─ channelConfigSchema for channel-specific config

package.json - BUILD & DEPS
├─ name, version, type: "module"
├─ scripts: test, build
├─ dependencies: dingtalk-stream, axios
└─ clawdbot manifest (extension path, channel metadata)
```

---

## Implementation Patterns

### Pattern 1: Access Token Management
```typescript
let accessToken: string | null = null;
let accessTokenExpiry = 0;

async function getAccessToken(config: any): Promise<string> {
  const now = Date.now();
  if (accessToken && accessTokenExpiry > now + 60000) {
    return accessToken; // Cache hit with 60s buffer
  }
  // Refresh: POST to /v1.0/oauth2/accessToken
  accessToken = response.data.accessToken;
  accessTokenExpiry = now + (response.data.expireIn * 1000);
  return accessToken;
}
```

### Pattern 2: Message Normalization
```typescript
interface MessageContent {
  text: string;
  mediaPath?: string;
  mediaType?: string;
  messageType: string;
}

function extractMessageContent(data: any): MessageContent {
  const msgtype = data.msgtype || 'text';
  switch(msgtype) {
    case 'text': return { text: data.text?.content?.trim() || '', messageType: 'text' };
    case 'richText': /* join text and @mentions */
    case 'picture': return { text: '[图片]', mediaPath: downloadCode, ... };
    // ... other types
  }
}
```

### Pattern 3: Message Processing Pipeline
```typescript
async function handleDingTalkMessage(params: {cfg, accountId, data, sessionWebhook, log, dingtalkConfig}) {
  // 1. Filter: self-messages
  // 2. Normalize: extractMessageContent
  // 3. Download: media if present
  // 4. Route: resolveAgentRoute → {agentId, sessionKey}
  // 5. Format: finalizeInboundContext with Clawdbot envelope
  // 6. Store: recordInboundSession
  // 7. Dispatch: dispatchReplyFromConfig with custom deliver callback
  // 8. Cleanup: unlink temp media files
}
```

---

## COMPREHENSIVE SYNTHESIS

### High-Level Architecture
The DingTalk channel is a **Clawdbot plugin** that provides messaging integration via DingTalk's **Stream Mode** (WebSocket). It follows the plugin SDK architecture and integrates tightly with Clawdbot's message routing, session management, and AI dispatch pipeline.

**Technology Stack**:
- **Language**: TypeScript (runtime-loaded via jiti)
- **DingTalk SDK**: `dingtalk-stream` v2.1.4 (WebSocket client)
- **HTTP Client**: axios (for OpenAPI calls)
- **Plugin System**: Clawdbot Plugin SDK (ClawdbotPluginApi, PluginRuntime)
- **Build/Runtime**: Node.js, jiti (no pre-compilation needed)

### Core Responsibilities (Plugin.ts - 392 LOC)

| Component | Responsibility | Code Location |
|-----------|----------------|-------------------|
| **Configuration** | Load and validate dingtalk config from ClawdbotConfig | `getConfig()`, `isConfigured()` |
| **Authentication** | OAuth token lifecycle with caching | `getAccessToken()` |
| **Credential Storage** | Module-level runtime ref, token cache with TTL | Module variables (lines 17-29) |
| **Message Parsing** | Normalize DingTalk message types to unified interface | `extractMessageContent()` |
| **Media Handling** | Download user-sent files/images to temp directory | `downloadMedia()` |
| **Message Routing** | Resolve agent and session using Clawdbot APIs | `handleDingTalkMessage()` → rt.channel.routing |
| **Session Management** | Record inbound sessions, track conversation state | `handleDingTalkMessage()` → rt.channel.session |
| **Reply Dispatch** | Integrate with Clawdbot's AI pipeline for responses | `createReplyDispatcherWithTyping()` |
| **Outbound Send** | Send messages back via sessionWebhook or OpenAPI | `sendBySession()`, `sendProactiveMessage()` |
| **Security** | Apply DM/group policies, filter self-messages | dmPolicy, groupPolicy in config |
| **Health Check** | Probe endpoint for status monitoring | `status.probe()` |
| **Gateway Integration** | Connect DingTalk Stream on startup, cleanup on shutdown | `gateway.startAccount()` |

### Data Flow Walkthrough (End-to-End)

```
1. USER SENDS MESSAGE IN DINGTALK
   └─ DingTalk API routes to plugin via WebSocket

2. INBOUND PROCESSING
   plugin.ts:348 → registerCallbackListener(TOPIC_ROBOT)
   ├─ Parse JSON from res.data
   ├─ Check if self-message (filtered at line 205)
   ├─ extractMessageContent(data) → normalized text + optional media
   ├─ downloadMedia() → save to /tmp if image/audio/video/file
   └─ Acknowledge to DingTalk immediately

3. ROUTING & SESSION
   handleDingTalkMessage() → rt.channel.routing.resolveAgentRoute()
   ├─ Resolve {agentId, sessionKey} based on peer (dm/group)
   ├─ rt.channel.session.recordInboundSession() → persist session
   └─ Read previousTimestamp for conversation context

4. ENVELOPE FORMATTING
   rt.channel.reply.formatInboundEnvelope()
   ├─ Wrap normalized text in channel-specific format
   ├─ Include sender name, timestamp, chat type
   └─ Return formatted body

5. CONTEXT FINALIZATION
   rt.channel.reply.finalizeInboundContext()
   ├─ Merge formatted body, raw body, command body, metadata
   ├─ Set SessionKey, From, To, MediaPath, etc.
   └─ Return complete context object

6. AI DISPATCH
   rt.channel.reply.dispatchReplyFromConfig({ctx, cfg, dispatcher, replyOptions})
   ├─ Pass context to Clawdbot's main AI pipeline
   ├─ AI processes request, generates response
   └─ Response funneled to dispatcher.deliver()

7. RESPONSE DELIVERY
   createReplyDispatcherWithTyping() → deliver callback
   ├─ Optionally send "thinking" status first (if showThinking enabled)
   ├─ sendBySession(dingtalkConfig, sessionWebhook, text, options)
   ├─ POST to sessionWebhook with markdown/text body
   ├─ Include @mention for group chats (if isDirect=false)
   └─ Return { ok: true }

8. CLEANUP
   finally block in handleDingTalkMessage()
   └─ fs.unlinkSync(mediaPath) if temp file exists
```

### Key Integrations with Clawdbot

| Clawdbot API | Usage | Purpose |
|---|---|---|
| `rt.channel.routing.resolveAgentRoute()` | Resolve agent & session key | Route message to correct agent |
| `rt.channel.session.resolveStorePath()` | Get storage path for session | Persist conversation history |
| `rt.channel.session.readSessionUpdatedAt()` | Get last update timestamp | Context window for conversation |
| `rt.channel.session.recordInboundSession()` | Save inbound message | Update conversation history |
| `rt.channel.reply.resolveEnvelopeFormatOptions()` | Get formatting rules | Apply channel-specific format |
| `rt.channel.reply.formatInboundEnvelope()` | Format message for display | Human-readable channel format |
| `rt.channel.reply.finalizeInboundContext()` | Complete context object | Full info for AI processing |
| `rt.channel.reply.dispatchReplyFromConfig()` | Dispatch to AI pipeline | Core request-response loop |
| `rt.channel.reply.createReplyDispatcherWithTyping()` | Create dispatcher with status | Handle response with typing indicator |
| `rt.channel.activity.record()` | Log channel activity | Monitor channel health |

### Configuration Schema

```json
{
  "enabled": boolean,
  "clientId": string (required),
  "clientSecret": string (required),
  "robotCode": string (optional, defaults to clientId),
  "corpId": string (optional),
  "agentId": string (optional),
  "dmPolicy": "open" | "pairing" | "allowlist",
  "allowFrom": string[] (list of allowed user IDs),
  "groupPolicy": "open" | "allowlist",
  "debug": boolean,
  "showThinking": boolean (default: true)
}
```

### Testing & Quality

**Current State**:
- ✅ Manual integration test via `test.js` (echo bot pattern)
- ❌ No automated unit tests
- ❌ No CI/CD pipeline
- ❌ No linting/formatting rules
- ❌ No tsconfig.json

**Recommendations**:
- Add Vitest or Jest for unit testing message parsing (`extractMessageContent`)
- Add ESLint + Prettier for code consistency
- Add GitHub Actions for type-checking on PRs
- Create `tsconfig.json` for explicit type checking
- Add E2E tests using mock DingTalk API

---

## Implementation Guidelines

### When Adding New Features

1. **New Message Types**: Extend `extractMessageContent()` function (line 123)
2. **New Security Policies**: Extend `dmPolicy`/`groupPolicy` enum and implement in `handleDingTalkMessage()`
3. **New Outbound APIs**: Add new function following pattern of `sendBySession()` and `sendProactiveMessage()`
4. **New Fields in Context**: Add to `finalizeInboundContext()` call (line 246)
5. **New Config Options**: Add to `clawdbot.plugin.json` schema, then `getConfig()`

### Code Patterns to Follow

**Async Functions**:
- Always return `Promise<T>` with explicit types
- Use try/catch for error handling
- Use `ctx.log?.info/debug/error()` for logging (respects log level)
- Never use `@ts-ignore` - fix type issues properly

**Function Comments**:
```typescript
// [What it does]
// [How it's used]
async function myFunction(param: Type): Promise<ReturnType> {
  // Implementation
}
```

**Error Handling**:
```typescript
try {
  const result = await someAsync();
  return result;
} catch (err: any) {
  log?.error?.(`[DingTalk] Operation failed: ${err.message}`);
  return { ok: false, error: err.message };
}
```

### Testing New Code

Run manual integration test:
```bash
# Set credentials first
export DINGTALK_CLIENT_ID=your-id
export DINGTALK_CLIENT_SECRET=your-secret

# Run test
npm test
```

---

## Common Troubleshooting

| Problem | Likely Cause | Solution |
|---------|--------------|----------|
| "DingTalk runtime not initialized" | Plugin not registered | Ensure `register()` is called by Clawdbot |
| Token expired errors | Cache not refreshed | Check `accessTokenExpiry` logic |
| Temp files not cleaned up | Crash during processing | Implement startup cleanup routine |
| Messages not received | Wrong TOPIC_ROBOT | Verify SDK version matches docs |
| PII in logs | Debug mode enabled | Set `debug: false` in production |
| Markdown not rendering | Message format issue | Check `sendBySession()` detection logic |

---

## Next Steps

1. ✅ **Parallel exploration complete** - All 7 background agents finished
2. ✅ **Comprehensive synthesis** - This AGENT.md contains full architectural overview
3. 🚀 **Ready for implementation** - Ask for specific enhancements or bug fixes using this guide as reference

**Quick Links**:
- **TypeScript Patterns**: See [Implementation Patterns](#implementation-patterns) section
- **Message Flow**: See [Data Flow Walkthrough](#data-flow-walkthrough-end-to-end) section
- **Configuration**: See [Configuration Schema](#configuration-schema) section
- **API Reference**: See [Clawdbot Integrations](#key-integrations-with-clawdbot) section
- **Security**: See [EXPLORE-5] results in [Agent Results Summary](#agent-results-summary) section

---

## Commands

### Common Development Tasks
```bash
# Install dependencies
npm install

# Run tests
npm test

# Build TypeScript (if configured)
npm run build

# Check for linting issues
npm run lint  # if configured

# Git workflow
git status
git diff
git log
```

### Useful Git Commands
```bash
# See recent changes
git log --oneline -10

# Check uncommitted changes
git status

# View specific file history
git log --oneline -- plugin.ts
```

---

## Reference

**Plugin Metadata**: See `clawdbot.plugin.json` for manifest details  
**Dependencies**: See `package.json` for complete list  
**Main Implementation**: `plugin.ts` - TypeScript source  
**Legacy Bootstrap**: `index.js` - Original entry point  

---

## Questions During Development

Refer to:
1. **Architecture**: See results from [EXPLORE-2] above
2. **DingTalk SDK**: See results from [LIBRARIAN-1] above
3. **clawd Plugin API**: See results from [LIBRARIAN-2] above
4. **Code Patterns**: See results from [EXPLORE-1] above

---

**Last Updated**: 2026-01-27 22:30 UTC+8
