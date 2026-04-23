import axios from "axios";
import { vi } from "vitest";
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
    isBtwRequestText: vi.fn().mockReturnValue(false),
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
          async ({ dispatcherOptions, replyOptions }: { dispatcherOptions: unknown; replyOptions?: unknown }) => {
            const d = dispatcherOptions as { deliver: (msg: unknown, meta: unknown) => Promise<void> };
            const r = replyOptions as { onReasoningStream?: (msg: unknown) => Promise<void> } | undefined;
            await r?.onReasoningStream?.({ text: "thinking" });
            await d.deliver({ text: "tool output" }, { kind: "tool" });
            await d.deliver({ text: "final output" }, { kind: "final" });
            return { queuedFinal: "queued final" };
          },
        ),
      },
    },
  };
  return { ...baseRuntime, ...overrides };
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
  mocks.uploadMediaMock.mockReset();
  mocks.uploadMediaMock.mockResolvedValue({ mediaId: "media_abc" });

  mocks.prepareMediaInputMock.mockReset();
  mocks.prepareMediaInputMock.mockImplementation(async (rawMediaUrl: string) => ({
    path: `/tmp/prepared/${rawMediaUrl.split("/").pop() || "media.bin"}`,
    cleanup: vi.fn().mockResolvedValue(undefined),
  }));

  mocks.resolveOutboundMediaTypeMock.mockReset();
  mocks.resolveOutboundMediaTypeMock.mockReturnValue("file");

  mocks.sendMessageMock.mockImplementation(
    async (_config: unknown, _to: unknown, text: unknown, options: unknown) => {
      const opts = options as { card?: { lastStreamedContent: unknown }; cardUpdateMode?: string } | undefined;
      if (opts?.card && opts?.cardUpdateMode === "append") {
        opts.card.lastStreamedContent = text;
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
