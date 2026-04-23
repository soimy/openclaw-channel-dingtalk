# Inbound Handler Test Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split 7770-line test file into ~10 domain-focused files with shared mock fixtures and update documentation.

**Architecture:** Create shared mock factory module, extract tests by domain, merge redundant tests, update 6 documentation files.

**Tech Stack:** TypeScript, Vitest, vi.hoisted(), vi.mock()

---

## File Structure

| File | Purpose |
|------|---------|
| `tests/unit/fixtures/inbound-handler-fixture.ts` | Shared mock factory and utilities |
| `tests/unit/inbound-handler-download.test.ts` | downloadMedia function tests |
| `tests/unit/inbound-handler-access.test.ts` | Access control (dmPolicy/groupPolicy) |
| `tests/unit/inbound-handler-commands.test.ts` | Slash commands (whoami/owner/learn/session alias) |
| `tests/unit/inbound-handler-quote.test.ts` | Quote handling and ReplyTo injection |
| `tests/unit/inbound-handler-card.test.ts` | Card lifecycle (create/stream/finalize/fallback) |
| `tests/unit/inbound-handler-card-streaming.test.ts` | Card streaming mode and block timeline |
| `tests/unit/inbound-handler-ack.test.ts` | Ack reaction (native emoji/dynamic) |
| `tests/unit/inbound-handler-subagent.test.ts` | Sub-agent routing |
| `tests/unit/inbound-handler-abort.test.ts` | Abort pre-lock bypass |
| `tests/unit/inbound-handler-media.test.ts` | Media handling and proactive send |
| `tests/unit/inbound-handler.test.ts` | Core E2E flow (reduced to ~10 tests) |

---

## Task 1: Create Mock Factory Module

**Files:**
- Create: `tests/unit/fixtures/inbound-handler-fixture.ts`
- Create: `tests/unit/fixtures/` directory

- [ ] **Step 1: Create fixtures directory**

```bash
mkdir -p tests/unit/fixtures
```

- [ ] **Step 2: Create the mock factory module**

Create `tests/unit/fixtures/inbound-handler-fixture.ts` with the following content:

```typescript
import axios from "axios";
import { beforeEach, vi } from "vitest";
import { getAccessToken } from "../../../src/auth";
import * as messageContextStore from "../../../src/message-context-store";

/**
 * Creates a shared mock object for inbound-handler tests.
 * Each test file should call this at module scope.
 */
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

/**
 * Applies all vi.mock calls for inbound-handler tests.
 * Call this at module scope after creating mocks.
 */
export function applyInboundHandlerMocks(mocks: ReturnType<typeof createInboundHandlerMocks>) {
  vi.mock("axios", () => ({
    default: {
      post: vi.fn(),
      get: vi.fn(),
      isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
    },
    isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
  }));

  vi.mock("../../../src/auth", () => ({
    getAccessToken: vi.fn().mockResolvedValue("token_abc"),
  }));

  vi.mock("../../../src/runtime", () => ({
    getDingTalkRuntime: mocks.getRuntimeMock,
  }));

  vi.mock("../../../src/message-utils", () => ({
    extractMessageContent: mocks.extractMessageContentMock,
  }));

  vi.mock("../../../src/messaging/attachment-text-extractor", () => ({
    extractAttachmentText: mocks.extractAttachmentTextMock,
  }));

  vi.mock("../../../src/send-service", () => ({
    sendBySession: mocks.sendBySessionMock,
    sendMessage: mocks.sendMessageMock,
    sendProactiveMedia: mocks.sendProactiveMediaMock,
    uploadMedia: mocks.uploadMediaMock,
  }));

  vi.mock("../../../src/media-utils", async () => {
    const actual = await vi.importActual<typeof import("../../../src/media-utils")>("../../../src/media-utils");
    return {
      ...actual,
      prepareMediaInput: mocks.prepareMediaInputMock,
      resolveOutboundMediaType: mocks.resolveOutboundMediaTypeMock,
    };
  });

  vi.mock("../../../src/card-service", () => ({
    createAICard: mocks.createAICardMock,
    finishAICard: mocks.finishAICardMock,
    commitAICardBlocks: mocks.commitAICardBlocksMock,
    formatContentForCard: mocks.formatContentForCardMock,
    isCardInTerminalState: mocks.isCardInTerminalStateMock,
    streamAICard: mocks.streamAICardMock,
    updateAICardBlockList: mocks.updateAICardBlockListMock,
    streamAICardContent: mocks.streamAICardContentMock,
    clearAICardStreamingContent: mocks.clearAICardStreamingContentMock,
  }));

  vi.mock("../../../src/session-lock", () => ({
    acquireSessionLock: mocks.acquireSessionLockMock,
  }));

  vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
    isAbortRequestText: mocks.isAbortRequestTextMock,
  }));

  vi.mock("../../../src/message-context-store", async () => {
    const actual = await vi.importActual<typeof import("../../../src/message-context-store")>(
      "../../../src/message-context-store",
    );
    return {
      ...actual,
      upsertInboundMessageContext: vi.fn(actual.upsertInboundMessageContext),
      resolveByMsgId: vi.fn(actual.resolveByMsgId),
      resolveByAlias: vi.fn(actual.resolveByAlias),
      resolveByCreatedAtWindow: vi.fn(actual.resolveByCreatedAtWindow),
      clearMessageContextCacheForTest: vi.fn(actual.clearMessageContextCacheForTest),
    };
  });

  vi.mock("../../../src/messaging/quoted-file-service", () => ({
    downloadGroupFile: mocks.downloadGroupFileMock,
    getUnionIdByStaffId: mocks.getUnionIdByStaffIdMock,
    resolveQuotedFile: mocks.resolveQuotedFileMock,
  }));
}

/**
 * Builds a mock runtime object with sensible defaults.
 * Override specific properties as needed.
 */
export function buildRuntime(overrides?: Record<string, unknown>) {
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
        dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockImplementation(
          async ({ dispatcherOptions, replyOptions }: { dispatcherOptions: any; replyOptions?: any }) => {
            await replyOptions?.onReasoningStream?.({ text: "thinking" });
            await dispatcherOptions.deliver({ text: "tool output" }, { kind: "tool" });
            await dispatcherOptions.deliver({ text: "final output" }, { kind: "final" });
            return { queuedFinal: "queued final" };
          },
        ),
      },
    },
  };
  return { ...baseRuntime, ...overrides } as ReturnType<typeof baseRuntime>;
}

/**
 * Resets all mocks to their default state.
 * Call this in beforeEach.
 */
export function resetInboundHandlerMocks(mocks: ReturnType<typeof createInboundHandlerMocks>) {
  const mockedAxiosPost = vi.mocked(axios.post);
  const mockedAxiosGet = vi.mocked(axios.get);
  const mockedGetAccessToken = vi.mocked(getAccessToken);
  const mockedUpsertInboundMessageContext = vi.mocked(messageContextStore.upsertInboundMessageContext);
  const mockedResolveByMsgId = vi.mocked(messageContextStore.resolveByMsgId);
  const mockedResolveByAlias = vi.mocked(messageContextStore.resolveByAlias);
  const mockedResolveByCreatedAtWindow = vi.mocked(messageContextStore.resolveByCreatedAtWindow);

  mockedAxiosPost.mockReset();
  mockedAxiosGet.mockReset();
  mockedGetAccessToken.mockReset();
  mockedGetAccessToken.mockResolvedValue("token_abc");

  mocks.sendBySessionMock.mockReset();
  mocks.sendMessageMock.mockReset();
  mocks.sendProactiveMediaMock.mockReset();
  mocks.sendProactiveMediaMock.mockResolvedValue({ ok: true });

  mocks.prepareMediaInputMock.mockReset();
  mocks.prepareMediaInputMock.mockImplementation(async (rawMediaUrl: string) => ({
    path: `/tmp/prepared/${rawMediaUrl.split("/").pop() || "media.bin"}`,
    cleanup: vi.fn().mockResolvedValue(undefined),
  }));

  mocks.resolveOutboundMediaTypeMock.mockReset();
  mocks.resolveOutboundMediaTypeMock.mockReturnValue("file");

  mocks.sendMessageMock.mockImplementation(
    async (_config: unknown, _to: unknown, text: unknown, options: any) => {
      if (options?.card && options?.cardUpdateMode === "append") {
        options.card.lastStreamedContent = text;
      }
      return { ok: true };
    },
  );

  mocks.extractMessageContentMock.mockReset();
  mockedUpsertInboundMessageContext.mockClear();
  mockedResolveByMsgId.mockClear();
  mockedResolveByAlias.mockClear();
  mockedResolveByCreatedAtWindow.mockClear();

  mocks.createAICardMock.mockReset();
  mocks.downloadGroupFileMock.mockReset();
  mocks.downloadGroupFileMock.mockResolvedValue(null);
  mocks.commitAICardBlocksMock.mockReset();
  mocks.getUnionIdByStaffIdMock.mockReset();
  mocks.getUnionIdByStaffIdMock.mockResolvedValue("union_1");
  mocks.resolveQuotedFileMock.mockReset();
  mocks.resolveQuotedFileMock.mockResolvedValue(null);
  mocks.streamAICardMock.mockReset();
  mocks.isCardInTerminalStateMock.mockReset();
  mocks.updateAICardBlockListMock.mockReset().mockResolvedValue(undefined);
  mocks.streamAICardContentMock.mockReset().mockResolvedValue(undefined);
  mocks.clearAICardStreamingContentMock.mockReset().mockResolvedValue(undefined);

  mocks.acquireSessionLockMock.mockReset();
  mocks.acquireSessionLockMock.mockResolvedValue(vi.fn());
  mocks.extractAttachmentTextMock.mockReset();
  mocks.extractAttachmentTextMock.mockResolvedValue(null);
  mocks.isAbortRequestTextMock.mockReset();
  mocks.isAbortRequestTextMock.mockReturnValue(false);

  mocks.getRuntimeMock.mockReturnValue(buildRuntime());
  mocks.extractMessageContentMock.mockReturnValue({ text: "hello", messageType: "text" });
  mocks.createAICardMock.mockResolvedValue({
    cardInstanceId: "card_1",
    state: "1",
    lastUpdated: Date.now(),
  });
}

/**
 * Gets typed mock references for use in tests.
 */
export function getMockedFunctions() {
  return {
    axiosPost: vi.mocked(axios.post),
    axiosGet: vi.mocked(axios.get),
    getAccessToken: vi.mocked(getAccessToken),
    upsertInboundMessageContext: vi.mocked(messageContextStore.upsertInboundMessageContext),
    resolveByMsgId: vi.mocked(messageContextStore.resolveByMsgId),
    resolveByAlias: vi.mocked(messageContextStore.resolveByAlias),
    resolveByCreatedAtWindow: vi.mocked(messageContextStore.resolveByCreatedAtWindow),
  };
}
```

- [ ] **Step 3: Verify the fixture file compiles**

Run: `pnpm run type-check`
Expected: No errors

- [ ] **Step 4: Commit the fixture module**

```bash
git add tests/unit/fixtures/inbound-handler-fixture.ts
git commit -m "test: add shared mock fixture for inbound-handler tests"
```

---

## Task 2: Create download.test.ts

**Files:**
- Create: `tests/unit/inbound-handler-download.test.ts`
- Source: Extract from `tests/unit/inbound-handler.test.ts` lines 245-434

- [ ] **Step 1: Create the download test file**

Create `tests/unit/inbound-handler-download.test.ts` with the following content:

```typescript
import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken } from "../../src/auth";
import {
  applyInboundHandlerMocks,
  buildRuntime,
  createInboundHandlerMocks,
  getMockedFunctions,
  resetInboundHandlerMocks,
} from "./fixtures/inbound-handler-fixture";

const mocks = createInboundHandlerMocks();
applyInboundHandlerMocks(mocks);

import { downloadMedia } from "../../src/inbound-handler";

const mockedAxiosPost = vi.mocked(axios.post);
const mockedAxiosGet = vi.mocked(axios.get);
const mockedGetAccessToken = vi.mocked(getAccessToken);

describe("inbound-handler downloadMedia", () => {
  beforeEach(() => {
    resetInboundHandlerMocks(mocks);
  });

  it("returns file meta when DingTalk download succeeds", async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "image/png" },
    } as any);

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
    );

    expect(result).toBeTruthy();
    expect(result?.mimeType).toBe("image/png");
    expect(result?.path).toContain("/.openclaw/media/inbound/");
  });

  it("applies timeout to the downloadUrl fetch", async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "image/png" },
    } as any);

    await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
    );

    expect(mockedAxiosGet).toHaveBeenCalledWith("https://download.url/file", {
      responseType: "arraybuffer",
      timeout: 15_000,
    });
  });

  it("logs the download host when the downloadUrl fetch fails", async () => {
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockRejectedValueOnce({
      isAxiosError: true,
      code: "ETIMEDOUT",
      message: "connect ETIMEDOUT",
      request: {},
    });

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
      log as any,
    );

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("stage=download host=download.url"),
    );
  });

  it("logs the auth stage when token retrieval fails", async () => {
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    mockedGetAccessToken.mockRejectedValueOnce(new Error("token failed"));

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
      log as any,
    );

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("stage=auth host=api.dingtalk.com message=token failed"),
    );
  });

  it("logs the exchange stage when messageFiles/download fails", async () => {
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    mockedAxiosPost.mockRejectedValueOnce({
      isAxiosError: true,
      code: "ECONNRESET",
      message: "socket hang up",
      request: {},
    });

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
      log as any,
    );

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("stage=exchange host=api.dingtalk.com"),
    );
  });

  it("keeps message= prefix for non-Axios download failures", async () => {
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockRejectedValueOnce(new Error("plain failure"));

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
      log as any,
    );

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("stage=download host=download.url message=plain failure"),
    );
  });

  it("passes mediaMaxMb as maxBytes to saveMediaBuffer", async () => {
    const runtime = buildRuntime();
    mocks.getRuntimeMock.mockReturnValue(runtime);

    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "application/pdf" },
    } as any);

    await downloadMedia(
      { clientId: "id", clientSecret: "sec", mediaMaxMb: 50 } as any,
      "download_code_1",
    );

    expect(runtime.channel.media.saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "inbound",
      50 * 1024 * 1024,
    );
  });

  it("uses clientId as robotCode", async () => {
    const runtime = buildRuntime();
    mocks.getRuntimeMock.mockReturnValue(runtime);

    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "image/png" },
    } as any);

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
    );

    expect(result).toBeTruthy();
    expect(mockedAxiosPost).toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/robot/messageFiles/download",
      { downloadCode: "download_code_1", robotCode: "id" },
      { headers: { "x-acs-dingtalk-access-token": "token_abc" } },
    );
  });
});
```

- [ ] **Step 2: Run download tests to verify they pass**

Run: `pnpm vitest run tests/unit/inbound-handler-download.test.ts`
Expected: 8 tests pass

- [ ] **Step 3: Commit the download test file**

```bash
git add tests/unit/inbound-handler-download.test.ts
git commit -m "test(inbound-handler): extract downloadMedia tests to separate file"
```

---

## Task 3: Create access.test.ts

**Files:**
- Create: `tests/unit/inbound-handler-access.test.ts`
- Source: Extract from original file, merge redundant allowlist tests

- [ ] **Step 1: Create the access test file with merged tests**

Create `tests/unit/inbound-handler-access.test.ts`. Extract tests from original file lines 436-580, but merge the 4 allowlist tests into 2 as per design.

The file should contain:
- `ignores self-message` test
- `dmPolicy allowlist blocks sender` (merged: covers both DM sender and allowlist behavior)
- `groupPolicy allowlist blocks group` (merged: covers both group allowlist and legacy allowFrom)
- `groupPolicy disabled drops message`
- `allows group listed in groups config`

- [ ] **Step 2: Run access tests to verify they pass**

Run: `pnpm vitest run tests/unit/inbound-handler-access.test.ts`
Expected: 6 tests pass

- [ ] **Step 3: Commit the access test file**

```bash
git add tests/unit/inbound-handler-access.test.ts
git commit -m "test(inbound-handler): extract access control tests with merged allowlist coverage"
```

---

## Task 4: Create commands.test.ts

**Files:**
- Create: `tests/unit/inbound-handler-commands.test.ts`
- Source: Extract whoami/owner/learn/session alias tests, merge alias variants

- [ ] **Step 1: Create the commands test file with merged tests**

Extract tests from original file lines 483-1340. Merge:
- whoami + english alias → 1 test with alias check included
- owner status + english alias → 1 test with alias check included

The file should contain ~12 tests covering:
- whoami command (with alias in single test)
- owner status command (with alias in single test)
- learn control commands (global, help)
- session alias show/set/bind
- whereami command
- targets command

- [ ] **Step 2: Run commands tests to verify they pass**

Run: `pnpm vitest run tests/unit/inbound-handler-commands.test.ts`
Expected: ~12 tests pass

- [ ] **Step 3: Commit the commands test file**

```bash
git add tests/unit/inbound-handler-commands.test.ts
git commit -m "test(inbound-handler): extract slash command tests with merged alias coverage"
```

---

## Task 5: Create quote.test.ts

**Files:**
- Create: `tests/unit/inbound-handler-quote.test.ts`
- Source: Extract quote handling tests, merge filename resolution variants

- [ ] **Step 1: Create the quote test file with merged tests**

Extract tests from original file lines 1599-3495. Merge:
- 6 filename resolution tests → 2 tests (cached resolution + fallback resolution)

The file should contain ~16 tests covering:
- quote journal entry
- quotedRef recording
- ReplyTo field injection
- multi-hop chain handling
- attachment excerpts
- filename resolution (merged to 2)

- [ ] **Step 2: Run quote tests to verify they pass**

Run: `pnpm vitest run tests/unit/inbound-handler-quote.test.ts`
Expected: ~16 tests pass

- [ ] **Step 3: Commit the quote test file**

```bash
git add tests/unit/inbound-handler-quote.test.ts
git commit -m "test(inbound-handler): extract quote handling tests with merged resolution coverage"
```

---

## Task 6: Create card.test.ts

**Files:**
- Create: `tests/unit/inbound-handler-card.test.ts`
- Source: Extract card lifecycle tests, merge fallback variants

- [ ] **Step 1: Create the card test file with merged tests**

Extract tests from original file covering card lifecycle. Merge:
- card fails mid-stream, createAICard returns null, finishAICard throws → 1 test covering card failure fallback

The file should contain ~12 tests covering:
- card flow creation and finalization
- markdown fallback on card failure
- card already in terminal state
- concurrent message handling
- file-only response

- [ ] **Step 2: Run card tests to verify they pass**

Run: `pnpm vitest run tests/unit/inbound-handler-card.test.ts`
Expected: ~12 tests pass

- [ ] **Step 3: Commit the card test file**

```bash
git add tests/unit/inbound-handler-card.test.ts
git commit -m "test(inbound-handler): extract card lifecycle tests with merged fallback coverage"
```

---

## Task 7: Create card-streaming.test.ts

**Files:**
- Create: `tests/unit/inbound-handler-card-streaming.test.ts`
- Source: Extract streaming mode tests, merge buffer variants

- [ ] **Step 1: Create the card-streaming test file with merged tests**

Extract tests from original file covering streaming mode. Merge:
- 4 reasoning buffer tests → 2 tests (buffer assembly + flush timing)

The file should contain ~12 tests covering:
- updateAICardBlockList calls
- reasoning buffer and flush
- block timeline
- answer without final payload
- late tool/answer handling

- [ ] **Step 2: Run card-streaming tests to verify they pass**

Run: `pnpm vitest run tests/unit/inbound-handler-card-streaming.test.ts`
Expected: ~12 tests pass

- [ ] **Step 3: Commit the card-streaming test file**

```bash
git add tests/unit/inbound-handler-card-streaming.test.ts
git commit -m "test(inbound-handler): extract card streaming tests with merged buffer coverage"
```

---

## Task 8: Create ack.test.ts

**Files:**
- Create: `tests/unit/inbound-handler-ack.test.ts`
- Source: Extract ack reaction tests, merge fallback variants

- [ ] **Step 1: Create the ack test file with merged tests**

Extract tests from original file lines 4265-4872. Merge:
- 5 ack reaction fallback tests → 2 tests (native attach + fallback chain)

The file should contain ~8 tests covering:
- native ack reaction attach/recall
- emoji fallback chain
- tool progress independence
- cleanup stall handling

- [ ] **Step 2: Run ack tests to verify they pass**

Run: `pnpm vitest run tests/unit/inbound-handler-ack.test.ts`
Expected: ~8 tests pass

- [ ] **Step 3: Commit the ack test file**

```bash
git add tests/unit/inbound-handler-ack.test.ts
git commit -m "test(inbound-handler): extract ack reaction tests with merged fallback coverage"
```

---

## Task 9: Create subagent.test.ts

**Files:**
- Create: `tests/unit/inbound-handler-subagent.test.ts`
- Source: Extract from original file lines 6784-7164

- [ ] **Step 1: Create the subagent test file**

Extract the `describe('@sub-agent feature', ...)` block from original file lines 6784-7164.

The file should contain ~8 tests covering:
- groupPolicy allowlist for sub-agent
- sequential processing
- real user @mention handling
- sessionWebhook for each agent

- [ ] **Step 2: Run subagent tests to verify they pass**

Run: `pnpm vitest run tests/unit/inbound-handler-subagent.test.ts`
Expected: ~8 tests pass

- [ ] **Step 3: Commit the subagent test file**

```bash
git add tests/unit/inbound-handler-subagent.test.ts
git commit -m "test(inbound-handler): extract sub-agent routing tests"
```

---

## Task 10: Create abort.test.ts

**Files:**
- Create: `tests/unit/inbound-handler-abort.test.ts`
- Source: Extract from original file lines 7484-7720, merge strip @mention tests

- [ ] **Step 1: Create the abort test file with merged tests**

Extract the `describe("abort pre-lock bypass", ...)` block. Merge:
- strip @mention from group/DM → 1 test covering both

The file should contain ~6 tests covering:
- bypass session lock
- fallback to sendMessage
- card finalize with abort
- strip @mention (merged)

- [ ] **Step 2: Run abort tests to verify they pass**

Run: `pnpm vitest run tests/unit/inbound-handler-abort.test.ts`
Expected: ~6 tests pass

- [ ] **Step 3: Commit the abort test file**

```bash
git add tests/unit/inbound-handler-abort.test.ts
git commit -m "test(inbound-handler): extract abort bypass tests with merged @mention coverage"
```

---

## Task 11: Create media.test.ts

**Files:**
- Create: `tests/unit/inbound-handler-media.test.ts`
- Source: Extract media handling tests from original file

- [ ] **Step 1: Create the media test file**

Extract tests covering:
- media embed in card
- proactive media send fallback
- cleanup on send fail
- mixed text and media payloads

The file should contain ~6 tests.

- [ ] **Step 2: Run media tests to verify they pass**

Run: `pnpm vitest run tests/unit/inbound-handler-media.test.ts`
Expected: ~6 tests pass

- [ ] **Step 3: Commit the media test file**

```bash
git add tests/unit/inbound-handler-media.test.ts
git commit -m "test(inbound-handler): extract media handling tests"
```

---

## Task 12: Update Main Test File

**Files:**
- Modify: `tests/unit/inbound-handler.test.ts`
- Keep only: Core E2E flow tests (~10 tests)

- [ ] **Step 1: Remove extracted tests from main file**

Keep only the following tests in the main file:
1. `handleDingTalkMessage ignores self-message`
2. `handleDingTalkMessage runs card flow and finalizes AI card`
3. `handleDingTalkMessage markdown flow sends block answers`
4. `handleDingTalkMessage attaches and recalls native ack reaction in markdown mode`
5. `acquires session lock with resolved sessionKey`
6. `releases session lock even when dispatchReply throws`
7. `injects group turn context prompt`
8. `learns group/user targets from inbound displayName`
9. `handleDingTalkMessage records outbound createdAt fallback`
10. `concurrent messages create independent cards with distinct IDs`

Remove all other tests that have been extracted to split files.

- [ ] **Step 2: Update main file to use shared fixture**

Update the main file to import and use the shared fixture module instead of defining mocks inline.

- [ ] **Step 3: Run main file tests to verify they pass**

Run: `pnpm vitest run tests/unit/inbound-handler.test.ts`
Expected: ~10 tests pass

- [ ] **Step 4: Run all tests to verify nothing is broken**

Run: `pnpm test`
Expected: All tests pass (total ~96 tests)

- [ ] **Step 5: Commit the main file update**

```bash
git add tests/unit/inbound-handler.test.ts
git commit -m "test(inbound-handler): reduce main file to core E2E flow tests"
```

---

## Task 13: Update AGENTS.md

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add Test File Structure section to CONVENTIONS**

Add the following to the `## CONVENTIONS` section:

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

- [ ] **Step 2: Commit the AGENTS.md update**

```bash
git add AGENTS.md
git commit -m "docs: add test file structure guidelines to AGENTS.md"
```

---

## Task 14: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Test File Scale Control section to Testing**

Add the following to the `## Testing` section:

```markdown
### Test File Scale Control

- Target: <500 lines per test file; files >800 lines should be split
- Split pattern: `source-module-{domain}.test.ts` (e.g., `inbound-handler-quote.test.ts`)
- Shared fixtures: `tests/unit/fixtures/` for mock factories and test utilities
- Redundancy check before split: merge tests that validate identical behavior
- Main file retains core end-to-end flow; domain-specific tests go to split files
```

- [ ] **Step 2: Commit the CLAUDE.md update**

```bash
git add CLAUDE.md
git commit -m "docs: add test file scale control section to CLAUDE.md"
```

---

## Task 15: Update CONTRIBUTING.md

**Files:**
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Add Test File Maintenance section after Validation Checklist**

Add the following after `## Validation Checklist`:

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

- [ ] **Step 2: Commit the CONTRIBUTING.md update**

```bash
git add CONTRIBUTING.md
git commit -m "docs: add test file maintenance section to CONTRIBUTING.md"
```

---

## Task 16: Update CONTRIBUTING.zh-CN.md

**Files:**
- Modify: `CONTRIBUTING.zh-CN.md`

- [ ] **Step 1: Add Chinese version of Test File Maintenance section**

Add the following after `## 验证清单`:

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

- [ ] **Step 2: Commit the CONTRIBUTING.zh-CN.md update**

```bash
git add CONTRIBUTING.zh-CN.md
git commit -m "docs: add test file maintenance section (Chinese) to CONTRIBUTING.zh-CN.md"
```

---

## Task 17: Update architecture.en.md

**Files:**
- Modify: `docs/contributor/architecture.en.md`

- [ ] **Step 1: Add Test File Maintenance section after Review Checklist**

Add the following after `## Review Checklist`:

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

- [ ] **Step 2: Commit the architecture.en.md update**

```bash
git add docs/contributor/architecture.en.md
git commit -m "docs: add test file maintenance section to architecture.en.md"
```

---

## Task 18: Update architecture.zh-CN.md

**Files:**
- Modify: `docs/contributor/architecture.zh-CN.md`

- [ ] **Step 1: Add Chinese version of Test File Maintenance section**

Add the following after `## Review Checklist`:

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

- [ ] **Step 2: Commit the architecture.zh-CN.md update**

```bash
git add docs/contributor/architecture.zh-CN.md
git commit -m "docs: add test file maintenance section (Chinese) to architecture.zh-CN.md"
```

---

## Task 19: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (~96 tests)

- [ ] **Step 2: Run coverage report**

Run: `pnpm test:coverage`
Expected: Coverage percentage unchanged from baseline

- [ ] **Step 3: Run type check**

Run: `pnpm run type-check`
Expected: No errors

- [ ] **Step 4: Run lint**

Run: `pnpm run lint`
Expected: No errors

- [ ] **Step 5: Verify file line counts**

Run: `wc -l tests/unit/inbound-handler*.test.ts`
Expected: Each split file <400 lines, main file <300 lines

- [ ] **Step 6: Final commit with summary**

```bash
git add -A
git commit -m "test: complete inbound-handler test refactor

- Split 7770-line test file into 11 domain-focused files
- Add shared mock fixture module
- Merge 60 redundant tests into focused coverage
- Update 6 documentation files with test scale guidelines"
```

---

## Success Criteria

- [ ] All ~96 tests pass
- [ ] Each split file <400 lines
- [ ] Main file <300 lines
- [ ] No test behavior changes
- [ ] Coverage percentage unchanged
- [ ] Documentation updated in all 6 files