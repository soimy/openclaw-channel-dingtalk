# Hybrid Streaming Correct Merge Plan

> **Date:** 2026-04-04
> **Status:** Planning
> **Goal:** Merge PR branch features with hybrid streaming API routing

## Timeline Analysis

### PR Branch (card-template-v2-clean) - Features ✅, API Routing ❌

**What's CORRECT:**
1. **CardBlock[] structure** - Proper data model with type field (0=answer, 1=thinking, 2=tool)
2. **taskInfo tracking** - Per-card dap_usage, taskTime + session-level model/effort
3. **session-state.ts** - Shares model/effort across cards in same conversation
4. **Recovery system** - `lastContent` persistence + `appendRecoveryMarkerBlock`
5. **Helper functions** - `renderFallbackBlocks`, `extractAnswerTextFromBlockContent`, etc.
6. **onModelSelected callback** - Syncs model/effort to all active cards

**What's WRONG:**
- Uses streaming API for `blockList` → **Returns 500** for complex loopArray types
- Template `9a9138ed` may not have proper `content` key for streaming

### Main Branch - API Routing ✅, Features ❌

**What's CORRECT:**
1. **Hybrid API routing**:
   - `blockList` → instances API (avoids 500 error)
   - `content` → streaming API (real-time preview)
2. **New template** `5db37f25` supports streaming for `content` key
3. **Dual-path output** in controller when `cardRealTimeStream=true`

**What's MISSING:**
- No CardBlock[] structure (uses plain markdown)
- No taskInfo tracking
- No session-state module
- No recovery markers
- No per-card DAP counting
- No onModelSelected callback

## Correct Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Data Layer                                      │
│  CardBlock[] (PR branch) - KEEP THIS                                        │
│  - type: 0=answer, 1=thinking, 2=tool                                       │
│  - text, markdown, mediaId, btns                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                            API Routing (main branch)                         │
│                                                                              │
│  blockList (loopArray) ─────► instances API ─────► Persistent storage       │
│  taskInfo (string) ─────────► streaming API ─────► Footer metadata          │
│  content (string) ──────────► streaming API ─────► Real-time preview        │
│                               (when cardRealTimeStream=true)                │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Merge Strategy

### Phase 1: Update Template Configuration

**File:** `src/card/card-template.ts`

**Action:** Use main branch version (new template ID + key mapping)

```typescript
const BUILTIN_TEMPLATE_ID = "5db37f25-ac9e-4250-9c1d-c4ddba6e16e9.schema";
const BUILTIN_BLOCKLIST_KEY = "blockList";   // instances API
const BUILTIN_STREAMING_KEY = "content";      // streaming API
const BUILTIN_COPY_KEY = "content";           // copy action
const BUILTIN_TASKINFO_KEY = "taskInfo";      // streaming API (simple JSON)

export interface DingTalkCardTemplateContract {
  templateId: string;
  blockListKey: string;    // → instances API
  streamingKey: string;    // → streaming API
  copyKey: string;
  taskInfoKey: string;     // NEW: for streaming taskInfo
  /** @deprecated Use blockListKey */
  contentKey: string;
}
```

### Phase 2: Update card-service.ts - Hybrid Functions

**Keep from PR branch:**
- `incrementCardDapiCount()`
- `getCardTaskTimeSeconds()`
- `streamTaskInfo()` - **MODIFY** to use streaming API (it already does)
- `updatePendingCardLastContent()`
- All CardBlock-related types
- Recovery logic with `lastContent` field

**Add from main branch:**
- `updateAICardBlockList()` - Uses instances API for blockList
- `streamAICardContent()` - Uses streaming API for content preview
- `clearAICardStreamingContent()` - Clears content at boundaries
- `commitAICardBlocks()` - Finalize with both content sync + blockList update

**Modify `streamAICard()`:**
```typescript
// OLD (PR branch): Uses streaming API for blockList → 500 error
await putAICardStreamingField(card, template.contentKey, content, finished, log);

// NEW (hybrid): Use instances API for blockList
export async function streamAICard(
  card: AICardInstance,
  content: string,  // CardBlock[] JSON
  finished: boolean = false,
  log?: Logger,
): Promise<void> {
  // ... state checks ...

  // Use instances API for blockList (not streaming API)
  if (finished) {
    await commitAICardBlocks(card, content, true, log);
  } else {
    await updateAICardBlockList(card, content, log);
  }
}
```

**Modify `finishAICard()`:**
```typescript
export async function finishAICard(
  card: AICardInstance,
  content: string,  // CardBlock[] JSON
  log?: Logger,
  options: { quotedRef?: QuotedRef } = {},
): Promise<void> {
  // 1. Push final taskInfo (streaming API, simple type)
  if (card.taskInfo) {
    try {
      await streamTaskInfo(card, {
        dap_usage: card.taskInfo.dap_usage,
        taskTime: getCardTaskTimeSeconds(card),
      }, log);
    } catch (taskInfoErr) {
      log?.debug?.(`Non-critical: failed to push final taskInfo`);
    }
  }

  // 2. Commit blocks (instances API) + sync content (streaming API)
  await commitAICardBlocks(card, content, true, log);

  // 3. Cache for recovery (uses extractAnswerTextFromBlockContent from PR branch)
  // ... existing cache logic ...
}
```

### Phase 3: Update card-draft-controller.ts

**Keep from PR branch:**
- CardBlock[] rendering (`entryToBlock`, `kindToBlockType`, `renderTimeline`)
- `renderFallbackBlocks()`
- `extractAnswerTextFromBlockContent()`
- `appendRecoveryMarkerBlock()`
- `appendStopMarkerBlock()`
- `onEveryNSends` callback for `updatePendingCardLastContent`
- All timeline entry management

**Add from main branch:**
- `realTimeStreamEnabled` parameter
- `streamContentToCard()` helper - streams answer to `content` key
- `clearStreamingContentFromCard()` helper
- Dual-path `queueRender()` - stream to content AND update blockList
- `flushBoundaryFrame()` clearing - clear content before block commit

**Key change in `createDraftStreamLoop` callback:**
```typescript
const loop = createDraftStreamLoop({
    throttleMs: effectiveThrottleMs,
    isStopped: () => stopped || failed,
    sendOrEditStreamMessage: async (content: string) => {
        try {
            // CHANGED: Use instances API for blockList (not streaming API)
            await updateAICardBlockList(params.card, content, params.log);
            lastSentContent = content;
            lastAnswerContent = getFinalAnswerContent();
        } catch (err) {
            failed = true;
            // ...
        }
    },
    // KEEP: Periodic persistence for recovery
    onEveryNSends: (_count, content) => {
        updatePendingCardLastContent(params.card, content, params.log);
    },
    persistInterval: 5,
});
```

### Phase 4: Update reply-strategy-card.ts

**Keep from PR branch:**
- `onModelSelected` callback - updates session state + syncs to all cards
- `getFinalBlocks()` helper
- All timeline management

**Add from main branch:**
- `realTimeStreamEnabled: config.cardRealTimeStream ?? false` parameter
- `clearStreamingContent()` call in finalize before flush

### Phase 5: Keep All PR Branch Features

**Do NOT modify (keep as-is from PR branch):**
- `src/session-state.ts` - Complete file
- `src/types.ts` - CardBlock, CardBlockType, CardTaskInfo, CardStreamPayload
- `src/reply-strategy.ts` - ModelSelectedContext, onModelSelected
- `src/inbound-handler.ts` - session state init, contextConversationId
- `src/card/card-run-registry.ts` - `listActiveCardsByConversation()`
- `src/card/card-stop-handler.ts` - Uses `appendStopMarkerBlock`
- `src/draft-stream-loop.ts` - `onEveryNSends`, `persistInterval`
- Test files - Update mocks but keep test logic

## API Routing Summary

| Variable | Type | API | Purpose |
|----------|------|-----|---------|
| `blockList` | loopArray | instances | Structured content (avoids 500) |
| `content` | string | streaming | Real-time preview (cardRealTimeStream=true) |
| `taskInfo` | JSON string | streaming | Footer metadata |
| `stop_action` | string | instances | Stop button visibility |

## Files to Modify

1. `src/card/card-template.ts` - New template ID + taskInfoKey
2. `src/card-service.ts` - Hybrid functions + keep PR features
3. `src/card-draft-controller.ts` - Dual-path output + keep PR rendering
4. `src/reply-strategy-card.ts` - realTimeStreamEnabled + keep onModelSelected

## Files to Keep from PR Branch (no changes needed)

1. `src/session-state.ts`
2. `src/types.ts` (CardBlock types)
3. `src/reply-strategy.ts` (onModelSelected)
4. `src/inbound-handler.ts` (session init)
5. `src/card/card-run-registry.ts`
6. `src/card/card-stop-handler.ts`
7. `src/draft-stream-loop.ts`

## Test Updates

1. Add `updateAICardBlockList` mock
2. Add `streamAICardContent` mock
3. Add `clearAICardStreamingContent` mock
4. Update assertions to use `updateAICardBlockList` instead of `streamAICard`
5. Keep all existing test logic for CardBlock[], taskInfo, recovery

## Verification Checklist

- [ ] CardBlock[] structure preserved
- [ ] taskInfo streaming works (model, effort, dap_usage, taskTime)
- [ ] Recovery with `lastContent` and marker blocks
- [ ] Session-level model/effort sharing
- [ ] onModelSelected syncs to all active cards
- [ ] blockList updates via instances API (no 500 errors)
- [ ] content streaming via streaming API (when enabled)
- [ ] Block boundary clears content before blockList commit
- [ ] Finalize syncs content for copy action
- [ ] All tests pass
