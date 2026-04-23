# Inbound Handler Test Refactor Design

**Date:** 2026-04-06
**Author:** AI Agent
**Status:** Approved

## Summary

Refactor `tests/unit/inbound-handler.test.ts` (7770 lines, 156 tests) into ~10 domain-focused files with shared mock fixtures, while updating project documentation with test file scale control guidelines.

## Background

The `inbound-handler.test.ts` file has grown to 7770 lines, making it:
- Difficult to navigate and maintain
- Slow to load in editors and CI
- Hard to identify which tests cover specific features

Previous handoff document noted the split was deferred due to `vi.hoisted()` cross-file export limitations. This design addresses that constraint with a shared mock factory approach.

## Goals

1. Split the 7770-line test file into ~10 domain-focused files (each <400 lines)
2. Extract shared mock setup into a reusable fixture module
3. Clean redundant tests that validate identical behavior ≥3 times
4. Update project documentation with test file scale control guidelines
5. Maintain all 156 tests passing after refactor

## Non-Goals

- Changing test behavior or assertions
- Adding new test coverage
- Physical file moves of source code

## Design

### Mock Factory Module

**Location:** `tests/unit/fixtures/inbound-handler-fixture.ts`

**Structure:**

```typescript
export function createInboundHandlerMocks() {
  return vi.hoisted(() => ({
    // Send service mocks
    sendBySessionMock: vi.fn(),
    sendMessageMock: vi.fn(),
    sendProactiveMediaMock: vi.fn(),
    uploadMediaMock: vi.fn(),

    // Card service mocks
    createAICardMock: vi.fn(),
    finishAICardMock: vi.fn(),
    commitAICardBlocksMock: vi.fn(),
    streamAICardMock: vi.fn(),
    updateAICardBlockListMock: vi.fn(),
    streamAICardContentMock: vi.fn(),
    clearAICardStreamingContentMock: vi.fn(),
    isCardInTerminalStateMock: vi.fn(),
    formatContentForCardMock: vi.fn((s: string) => s),

    // Message handling mocks
    extractMessageContentMock: vi.fn(),
    downloadGroupFileMock: vi.fn(),
    getUnionIdByStaffIdMock: vi.fn(),
    resolveQuotedFileMock: vi.fn(),
    extractAttachmentTextMock: vi.fn(),
    prepareMediaInputMock: vi.fn(),
    resolveOutboundMediaTypeMock: vi.fn(),

    // Runtime and lock mocks
    getRuntimeMock: vi.fn(),
    acquireSessionLockMock: vi.fn(),
    isAbortRequestTextMock: vi.fn(),
  }));
}

export function applyInboundHandlerMocks(mocks: ReturnType<typeof createInboundHandlerMocks>) {
  vi.mock("axios", () => ({
    default: { post: vi.fn(), get: vi.fn() },
    isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
  }));

  vi.mock("../../src/auth", () => ({
    getAccessToken: vi.fn().mockResolvedValue("token_abc"),
  }));

  vi.mock("../../src/runtime", () => ({
    getDingTalkRuntime: mocks.getRuntimeMock,
  }));

  vi.mock("../../src/send-service", () => ({
    sendBySession: mocks.sendBySessionMock,
    sendMessage: mocks.sendMessageMock,
    sendProactiveMedia: mocks.sendProactiveMediaMock,
    uploadMedia: mocks.uploadMediaMock,
  }));

  vi.mock("../../src/card-service", () => ({
    createAICard: mocks.createAICardMock,
    finishAICard: mocks.finishAICardMock,
    commitAICardBlocks: mocks.commitAICardBlocksMock,
    streamAICard: mocks.streamAICardMock,
    updateAICardBlockList: mocks.updateAICardBlockListMock,
    streamAICardContent: mocks.streamAICardContentMock,
    clearAICardStreamingContent: mocks.clearAICardStreamingContentMock,
    isCardInTerminalState: mocks.isCardInTerminalStateMock,
    formatContentForCard: mocks.formatContentForCardMock,
  }));

  // ... additional mocks
}

export function buildRuntime(overrides?: Partial<RuntimeConfig>) {
  const baseRuntime = {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({ agentId: "main", sessionKey: "s1", mainSessionKey: "s1" }),
        buildAgentSessionKey: vi.fn().mockReturnValue("agent-session-key"),
      },
      media: {
        saveMediaBuffer: vi.fn().mockResolvedValue({
          path: "/tmp/.openclaw/media/inbound/test-file.png",
          contentType: "image/png",
        }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/store.json"),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: "s1" }),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onReasoningStream?.({ text: "thinking" });
          await dispatcherOptions.deliver({ text: "tool output" }, { kind: "tool" });
          await dispatcherOptions.deliver({ text: "final output" }, { kind: "final" });
          return { queuedFinal: "queued final" };
        }),
      },
    },
  };
  return { ...baseRuntime, ...overrides };
}

export function resetInboundHandlerMocks(mocks: ReturnType<typeof createInboundHandlerMocks>) {
  mocks.sendBySessionMock.mockReset();
  mocks.sendMessageMock.mockReset();
  mocks.createAICardMock.mockReset();
  // ... reset all mocks with default values
  mocks.createAICardMock.mockResolvedValue({
    cardInstanceId: "card_1",
    state: "1",
    lastUpdated: Date.now(),
  });
  mocks.getRuntimeMock.mockReturnValue(buildRuntime());
  mocks.acquireSessionLockMock.mockResolvedValue(vi.fn());
}
```

**Usage in split files:**

```typescript
import {
  createInboundHandlerMocks,
  applyInboundHandlerMocks,
  buildRuntime,
  resetInboundHandlerMocks
} from "../fixtures/inbound-handler-fixture";

const mocks = createInboundHandlerMocks();
applyInboundHandlerMocks(mocks);

describe("inbound-handler quote handling", () => {
  beforeEach(() => {
    resetInboundHandlerMocks(mocks);
  });

  it("test case", async () => {
    // use mocks.extractMessageContentMock etc.
  });
});
```

### File Split Plan

| File | Domain | Tests | Est. Lines | Redundancy Cleanup |
|------|--------|-------|------------|---------------------|
| `inbound-handler.test.ts` (main) | Core E2E flow | ~10 | ~250 | Keep representative tests only |
| `inbound-handler-download.test.ts` | downloadMedia | 8 | ~150 | None |
| `inbound-handler-access.test.ts` | Access control | 6 | ~150 | Merge 4 allowlist tests to 2 |
| `inbound-handler-commands.test.ts` | Slash commands | 12 | ~250 | Merge whoami/owner alias tests |
| `inbound-handler-quote.test.ts` | Quote handling | 16 | ~300 | Merge 6 filename resolution tests |
| `inbound-handler-card.test.ts` | Card lifecycle | 12 | ~200 | Merge 3 fallback tests |
| `inbound-handler-card-streaming.test.ts` | Card streaming | 12 | ~200 | Merge 4 reasoning buffer tests |
| `inbound-handler-ack.test.ts` | Ack reaction | 8 | ~150 | Merge 5 fallback tests |
| `inbound-handler-subagent.test.ts` | Sub-agent routing | 8 | ~150 | None |
| `inbound-handler-abort.test.ts` | Abort bypass | 6 | ~100 | Merge 2 strip @mention tests |
| `inbound-handler-media.test.ts` | Media handling | 6 | ~100 | None |

**Total after cleanup:** ~96 tests (down from 156, ~60 tests merged/removed)

### Redundancy Cleanup Criteria

1. **Merge when:** Same assertion repeated ≥3 times across different test titles
2. **Delete when:** Test title describes behavior fully covered by another test
3. **Keep when:** Tests validate different boundary conditions (e.g., error vs success)

**Specific merges:**

| Original Tests | Merged Into |
|----------------|-------------|
| `dmPolicy allowlist blocks sender`, `groupPolicy allowlist blocks sender`, `groupPolicy allowlist blocks group`, `legacy allowFrom with groupId` | 2 tests: DM allowlist + Group allowlist |
| `whoami`, `whoami english alias`, `owner status`, `owner status english alias` | 2 tests: whoami + owner status (alias covered in one) |
| `filename resolution preview vs resolved vs cached` (6 tests) | 2 tests: cached resolution + fallback resolution |
| `card fails mid-stream`, `createAICard returns null`, `finishAICard throws` | 1 test: card failure fallback path |
| `reasoning buffer partial → complete → flush` (4 tests) | 2 tests: buffer assembly + flush timing |
| `ack reaction emoji fallback chain` (5 tests) | 2 tests: native attach + fallback chain |
| `strip @mention from group/DM before abort` (2 tests) | 1 test: strip @mention (covers both) |

### Main File Retained Tests

Core end-to-end pipeline tests:

1. `handleDingTalkMessage ignores self-message` — entry dedup
2. `handleDingTalkMessage runs card flow and finalizes AI card` — basic card path
3. `handleDingTalkMessage markdown flow sends block answers` — basic markdown path
4. `handleDingTalkMessage attaches and recalls native ack reaction` — representative ack test
5. `acquires session lock with resolved sessionKey` — lock mechanism
6. `releases session lock even when dispatchReply throws` — error handling
7. `injects group turn context prompt` — context injection
8. `learns group/user targets from inbound displayName` — directory learning
9. `handleDingTalkMessage records outbound createdAt fallback` — context persistence
10. `concurrent messages create independent cards with distinct IDs` — concurrency

## Documentation Updates

### AGENTS.md

Add to `## CONVENTIONS` section:

```markdown
**Test File Structure:**

- Single test file should stay under 500 lines; files approaching 800+ lines require split planning
- Use `-` suffix to split by feature domain: `inbound-handler-quote.test.ts`, `send-service-media.test.ts`
- Share mock fixtures via `tests/unit/fixtures/` for complex multi-file test suites
- Each split file should focus on one feature domain with 10-25 tests
- Keep core end-to-end flow tests in the main file; extract sub-feature tests to split files
- Before splitting, analyze test chain for redundancy: merge tests validating same behavior ≥3 times
- Test file naming follows `source-module-{domain}.test.ts` pattern
```

### CLAUDE.md

Add to `## Testing` section:

```markdown
### Test File Scale Control

- Target: <500 lines per test file; files >800 lines should be split
- Split pattern: `source-module-{domain}.test.ts` (e.g., `inbound-handler-quote.test.ts`)
- Shared fixtures: `tests/unit/fixtures/` for mock factories and test utilities
- Redundancy check before split: merge tests that validate identical behavior
- Main file retains core end-to-end flow; domain-specific tests go to split files
```

### CONTRIBUTING.md

Add after `## Validation Checklist`:

```markdown
## Test File Maintenance

When adding new tests or maintaining existing test files, follow these scale guidelines:

### Scale Thresholds

| Lines | Action |
|-------|--------|
| <500 | Acceptable, no action needed |
| 500-800 | Plan split for future work |
| >800 | Split required before merge |

### Split Strategy

1. **Identify feature domains** — Group tests by the feature they validate (e.g., quote handling, card lifecycle)
2. **Extract shared mocks** — Create fixture module in `tests/unit/fixtures/` for reusable mock setup
3. **Split by domain** — Create `source-module-{domain}.test.ts` files, each with 10-25 tests
4. **Retain core flows** — Keep end-to-end pipeline tests in the main file
5. **Clean redundancy** — Before splitting, merge tests that validate identical behavior ≥3 times

### Naming Convention

- Split files: `inbound-handler-quote.test.ts`, `send-service-media.test.ts`
- Fixture files: `tests/unit/fixtures/inbound-handler-fixture.ts`
```

### CONTRIBUTING.zh-CN.md

Add after `## 验证清单`:

```markdown
## 测试文件维护

添加新测试或维护既有测试文件时，请遵循以下规模指南：

### 规模阈值

| 行数 | 处理 |
|------|------|
| <500 | 正常，无需处理 |
| 500-800 | 规划拆分，可在后续工作中执行 |
| >800 | 必须拆分后再合并 |

### 拆分策略

1. **识别功能域** — 按被测功能分组（如 quote handling、card lifecycle）
2. **提取共享 mock** — 在 `tests/unit/fixtures/` 创建 fixture 模块
3. **按域拆分** — 创建 `source-module-{domain}.test.ts`，每个文件 10-25 个测试
4. **保留核心流程** — 端到端 pipeline 测试留在主文件
5. **清理冗余** — 拆分前合并重复验证相同行为 ≥3 次的测试

### 命名规范

- 拆分文件：`inbound-handler-quote.test.ts`、`send-service-media.test.ts`
- Fixture 文件：`tests/unit/fixtures/inbound-handler-fixture.ts`
```

### architecture.en.md

Add after `## Review Checklist`:

```markdown
## Test File Maintenance

Test files should follow the same domain boundaries as source code.

### Scale Thresholds

| Lines | Action |
|-------|--------|
| <500 | Acceptable, no action needed |
| 500-800 | Plan split for future work |
| >800 | Split required before merge |

### Split Strategy

1. **Identify feature domains** — Group tests by the feature they validate
2. **Extract shared mocks** — Create fixture module in `tests/unit/fixtures/`
3. **Split by domain** — Create `source-module-{domain}.test.ts` files with 10-25 tests each
4. **Retain core flows** — Keep end-to-end pipeline tests in the main file
5. **Clean redundancy** — Merge tests that validate identical behavior ≥3 times

### Naming Convention

- Split files: `inbound-handler-quote.test.ts`, `send-service-media.test.ts`
- Fixture files: `tests/unit/fixtures/inbound-handler-fixture.ts`
```

### architecture.zh-CN.md

Add after `## Review Checklist`:

```markdown
## 测试文件维护

测试文件应遵循与源码相同的领域边界原则。

### 规模阈值

| 行数 | 处理 |
|------|------|
| <500 | 正常，无需处理 |
| 500-800 | 规划拆分，可在后续工作中执行 |
| >800 | 必须拆分后再合并 |

### 拆分策略

1. **识别功能域** — 按被测功能分组（如 quote handling、card lifecycle）
2. **提取共享 mock** — 在 `tests/unit/fixtures/` 创建 fixture 模块
3. **按域拆分** — 创建 `source-module-{domain}.test.ts`，每个文件 10-25 个测试
4. **保留核心流程** — 端到端 pipeline 测试留在主文件
5. **清理冗余** — 拆分前合并重复验证相同行为 ≥3 次的测试

### 命名规范

- 拆分文件：`inbound-handler-quote.test.ts`、`send-service-media.test.ts`
- Fixture 文件：`tests/unit/fixtures/inbound-handler-fixture.ts`
```

## Implementation Plan Outline

1. Create `tests/unit/fixtures/` directory
2. Create `inbound-handler-fixture.ts` with mock factory
3. Split test files in order:
   - `download.test.ts` (isolated, no shared mock dependency)
   - `access.test.ts`
   - `commands.test.ts`
   - `quote.test.ts`
   - `card.test.ts`
   - `card-streaming.test.ts`
   - `ack.test.ts`
   - `subagent.test.ts`
   - `abort.test.ts`
   - `media.test.ts`
4. Merge redundant tests during split
5. Update main file to retain only core E2E tests
6. Update documentation files
7. Run `pnpm test` to verify all tests pass
8. Run `pnpm test:coverage` to verify coverage unchanged

## Success Criteria

- All 96 tests pass (after merge from 156)
- Each split file <400 lines
- Main file <300 lines
- No test behavior changes
- Coverage report shows same coverage percentage
- Documentation updated in all 6 files (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, CONTRIBUTING.zh-CN.md, architecture.en.md, architecture.zh-CN.md)