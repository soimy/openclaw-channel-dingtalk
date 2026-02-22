# SOURCE DIRECTORY

**Parent:** `../AGENTS.md`

## OVERVIEW

`src/` contains the full DingTalk channel implementation, now split by method category and runtime responsibility.

## STRUCTURE

```
src/
├── channel.ts             # Plugin assembly: config/outbound/gateway/status + exports
├── inbound-handler.ts     # Inbound workflow orchestration
├── send-service.ts        # Outbound messaging service
├── card-service.ts        # AI Card state machine + cache
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

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Inbound processing main entry | `inbound-handler.ts` | `handleDingTalkMessage` |
| Inbound media download | `inbound-handler.ts` | `downloadMedia` |
| Session/proactive message send | `send-service.ts` | `sendBySession`, `sendProactive*` |
| Message mode auto-selection | `send-service.ts` | `sendMessage` card/markdown fallback |
| AI Card create/stream/finalize | `card-service.ts` | card lifecycle + cache |
| Token cache | `auth.ts` | `getAccessToken` |
| Allowlist checks | `access-control.ts` | normalized allowFrom matching |
| Inbound payload parsing | `message-utils.ts` | `extractMessageContent` |
| Target/config/workspace helpers | `config.ts` | `getConfig`, `resolveRelativePath`, `stripTargetPrefix` |
| Plugin wiring | `channel.ts` | exports `dingtalkPlugin` |

## CONVENTIONS

- Keep `channel.ts` lightweight; add new behavior to service modules first.
- Cross-module reusable logic belongs in `*-service.ts` / `*-utils.ts`.
- Preserve existing log prefix style: `[DingTalk]`, `[DingTalk][AICard]`, `[accountId]`.
- Prefer explicit comments for behavior-critical branches (authorization, retry/fallback, state transitions).

## ANTI-PATTERNS

**Prohibited:**

- Re-introducing large business logic blocks into `channel.ts`
- Bypassing token retrieval before DingTalk API calls
- Updating card cache state without terminal-state semantics
- Removing dedup guard from gateway callback path

## UNIQUE STYLES

**Inbound Handler as Orchestrator:**

- `inbound-handler.ts` coordinates policy, routing, session recording, reply dispatch, and AI Card finalization.
- Lower-level calls are delegated to `send-service.ts` and `card-service.ts`.

**Card Fallback Design:**

- If card stream fails, mark card `FAILED` and continue delivery via markdown/text path.
- Priority is no message loss over card rendering fidelity.

**Workspace-first Media Strategy:**

- Inbound media is persisted under the resolved agent workspace, not temp-only paths.
- This keeps files accessible to downstream sandboxed tools.
