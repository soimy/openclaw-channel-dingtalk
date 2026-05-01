import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig } from "../../src/types";

const shared = vi.hoisted(() => ({
  getRuntimeMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  extractAttachmentTextMock: vi.fn(),
  downloadGroupFileMock: vi.fn(),
  getUnionIdByStaffIdMock: vi.fn(),
  resolveQuotedFileMock: vi.fn(),
  createAICardMock: vi.fn(),
  isCardInTerminalStateMock: vi.fn(),
  commitAICardBlocksMock: vi.fn(),
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
    isAxiosError: (err: unknown) =>
      Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
  },
  isAxiosError: (err: unknown) =>
    Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
}));

vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("token_test"),
}));

vi.mock("../../src/runtime", () => ({
  getDingTalkRuntime: shared.getRuntimeMock,
}));

vi.mock("../../src/message-utils", () => ({
  extractMessageContent: shared.extractMessageContentMock,
}));

vi.mock("../../src/messaging/attachment-text-extractor", () => ({
  extractAttachmentText: shared.extractAttachmentTextMock,
}));

vi.mock("../../src/messaging/quoted-file-service", () => ({
  downloadGroupFile: shared.downloadGroupFileMock,
  getUnionIdByStaffId: shared.getUnionIdByStaffIdMock,
  resolveQuotedFile: shared.resolveQuotedFileMock,
}));

vi.mock("../../src/card-service", () => ({
  createAICard: shared.createAICardMock,
  commitAICardBlocks: shared.commitAICardBlocksMock,
  isCardInTerminalState: shared.isCardInTerminalStateMock,
}));

vi.mock("../../src/send-service", () => ({
  sendBySession: shared.sendBySessionMock,
  sendMessage: shared.sendMessageMock,
}));

vi.mock("../../src/session-lock", () => ({
  acquireSessionLock: shared.acquireSessionLockMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  isAbortRequestText: vi.fn().mockReturnValue(false),
  isBtwRequestText: vi.fn().mockReturnValue(false),
}));

// message-context-store: spy on the actual implementation
vi.mock("../../src/message-context-store", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/message-context-store")
  >("../../src/message-context-store");
  return {
    ...actual,
    upsertInboundMessageContext: vi.fn(actual.upsertInboundMessageContext),
    resolveByMsgId: vi.fn(actual.resolveByMsgId),
    clearMessageContextCacheForTest: vi.fn(actual.clearMessageContextCacheForTest),
  };
});

import { handleDingTalkMessage } from "../../src/inbound-handler";
import * as messageContextStore from "../../src/message-context-store";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
import { clearTargetDirectoryStateCache } from "../../src/targeting/target-directory-store";

const mockedAxiosPost = vi.mocked(axios.post);
const mockedAxiosGet = vi.mocked(axios.get);
const mockedUpsertInboundMessageContext = vi.mocked(
  messageContextStore.upsertInboundMessageContext,
);
const TEST_TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "dingtalk-multi-image-quote-"),
);
const STORE_PATH = path.join(TEST_TMP_DIR, "store.json");
const ACCOUNT_STORE_PATH = path.join(TEST_TMP_DIR, "account-store.json");

function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi
          .fn()
          .mockReturnValue({
            agentId: "main",
            sessionKey: "s1",
            mainSessionKey: "s1",
          }),
        buildAgentSessionKey: vi.fn().mockReturnValue("agent-session-key"),
      },
      media: {
        saveMediaBuffer: vi.fn().mockImplementation(
          (_buf: Buffer, contentType: string, _dir: string, _maxBytes?: number, originalFilename?: string) => {
            const filename =
              originalFilename || `media-${Math.random().toString(36).slice(2)}`;
            return Promise.resolve({
              path: `/tmp/.openclaw/media/inbound/${filename}`,
              contentType,
            });
          },
        ),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue(STORE_PATH),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi
          .fn()
          .mockReturnValue({ SessionKey: "s1" }),
        dispatchReplyWithBufferedBlockDispatcher: vi
          .fn()
          .mockResolvedValue({ queuedFinal: "final" }),
      },
    },
  };
}

function mockDingTalkDownloadSuccess(downloadUrl = "https://dl.example.com/file") {
  mockedAxiosPost.mockResolvedValueOnce({
    data: { downloadUrl },
  } as any);
  mockedAxiosGet.mockResolvedValueOnce({
    data: Buffer.from("fake-image-data"),
    headers: { "content-type": "image/webp" },
  } as any);
}

describe("inbound-handler multi-image quote recovery", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    clearCardRunRegistryForTest();
    const stateDir = path.join(TEST_TMP_DIR, "dingtalk-state");
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    messageContextStore.clearMessageContextCacheForTest();

    shared.getRuntimeMock.mockReset();
    shared.extractMessageContentMock.mockReset();
    shared.extractAttachmentTextMock.mockReset();
    shared.extractAttachmentTextMock.mockResolvedValue(null);
    shared.downloadGroupFileMock.mockReset();
    shared.downloadGroupFileMock.mockResolvedValue(null);
    shared.getUnionIdByStaffIdMock.mockReset();
    shared.getUnionIdByStaffIdMock.mockResolvedValue("union_1");
    shared.resolveQuotedFileMock.mockReset();
    shared.resolveQuotedFileMock.mockResolvedValue(null);
    shared.createAICardMock.mockReset();
    shared.createAICardMock.mockResolvedValue({
      cardInstanceId: "card_1",
      outTrackId: "track_1",
    } as any);
    shared.isCardInTerminalStateMock.mockReset();
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.commitAICardBlocksMock.mockReset();
    shared.commitAICardBlocksMock.mockResolvedValue(undefined);
    shared.sendBySessionMock.mockReset();
    shared.sendBySessionMock.mockResolvedValue({ ok: true } as any);
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockResolvedValue({ ok: true } as any);
    shared.acquireSessionLockMock.mockReset();
    shared.acquireSessionLockMock.mockResolvedValue(() => Promise.resolve());

    mockedAxiosPost.mockReset();
    mockedAxiosGet.mockReset();
  });

  it("persists all downloadCodes for multi-image richText", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValue(ACCOUNT_STORE_PATH);
    shared.getRuntimeMock.mockReturnValue(runtime);

    // Multi-image richText: 2 images
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "<media:image>",
      messageType: "richText",
      mediaPath: "dl_pic_1",
      mediaPaths: ["dl_pic_1", "dl_pic_2"],
      mediaType: "image",
    });

    // Mock both downloads
    mockDingTalkDownloadSuccess("https://dl.example.com/img1");
    mockDingTalkDownloadSuccess("https://dl.example.com/img2");

    const now = Date.now();
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        clientId: "robot_1",
      } as unknown as DingTalkConfig,
      data: {
        msgId: "m_multi_img_1",
        msgtype: "richText",
        text: { content: "<media:image>" },
        conversationType: "1",
        conversationId: "cid_multi",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: now,
      },
    } as unknown as { data: unknown });

    // Verify upsertInboundMessageContext was called with downloadCodes (media cache call)
    const mediaCacheCalls = mockedUpsertInboundMessageContext.mock.calls.filter(
      (call) => call[0]?.media?.downloadCode,
    );
    expect(mediaCacheCalls.length).toBeGreaterThanOrEqual(1);

    const mediaCacheCall = mediaCacheCalls[0]![0]!;
    expect(mediaCacheCall.media?.downloadCode).toBe("dl_pic_1");
    expect(mediaCacheCall.media?.downloadCodes).toEqual(["dl_pic_1", "dl_pic_2"]);
  });

  it("does not store downloadCodes for single-image messages", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValue(ACCOUNT_STORE_PATH);
    shared.getRuntimeMock.mockReturnValue(runtime);

    // Single image message
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "<media:image>",
      messageType: "picture",
      mediaPath: "dl_single",
      mediaType: "image",
    });

    mockDingTalkDownloadSuccess("https://dl.example.com/single");

    const now = Date.now();
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        clientId: "robot_1",
      } as unknown as DingTalkConfig,
      data: {
        msgId: "m_single_img",
        msgtype: "picture",
        text: { content: "<media:image>" },
        conversationType: "1",
        conversationId: "cid_single",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: now,
      },
    } as unknown as { data: unknown });

    const mediaCacheCalls = mockedUpsertInboundMessageContext.mock.calls.filter(
      (call) => call[0]?.media?.downloadCode,
    );
    expect(mediaCacheCalls.length).toBeGreaterThanOrEqual(1);
    const mediaCacheCall = mediaCacheCalls[0]![0]!;
    expect(mediaCacheCall.media?.downloadCode).toBe("dl_single");
    expect(mediaCacheCall.media?.downloadCodes).toBeUndefined();
  });

  it("recovers all images from cache when quoting a multi-image richText", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValue(ACCOUNT_STORE_PATH);
    shared.getRuntimeMock.mockReturnValue(runtime);

    // --- Step 1: Send a multi-image richText to populate the cache ---
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "<media:image>",
      messageType: "richText",
      mediaPath: "dl_pic_1",
      mediaPaths: ["dl_pic_1", "dl_pic_2", "dl_pic_3"],
      mediaType: "image",
    });
    mockDingTalkDownloadSuccess("https://dl.example.com/img1");
    mockDingTalkDownloadSuccess("https://dl.example.com/img2");
    mockDingTalkDownloadSuccess("https://dl.example.com/img3");

    const now = Date.now();
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        clientId: "robot_1",
      } as unknown as DingTalkConfig,
      data: {
        msgId: "m_multi_orig",
        msgtype: "richText",
        text: { content: "<media:image>" },
        conversationType: "1",
        conversationId: "cid_quote_test",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: now,
      },
    } as unknown as { data: unknown });

    // Clear the mock history so we can assert on the quote call only
    mockedUpsertInboundMessageContext.mockClear();
    const finalizeSpy = runtime.channel.reply.finalizeInboundContext as ReturnType<
      typeof vi.fn
    >;
    finalizeSpy.mockClear();

    // --- Step 2: Quote the multi-image message ---
    // The quoted message is resolved from the cache via resolveByMsgId.
    // Simulate: the cached record has downloadCodes, and the inbound
    // quotedRef points to the original msgId.
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "look at these pictures",
      messageType: "text",
      quoted: {
        msgId: "m_multi_orig",
        previewMessageType: "richText",
      },
    });

    // Mock the 3 downloads for the recovery path
    mockDingTalkDownloadSuccess("https://dl.example.com/recovered1");
    mockDingTalkDownloadSuccess("https://dl.example.com/recovered2");
    mockDingTalkDownloadSuccess("https://dl.example.com/recovered3");

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        clientId: "robot_1",
      } as unknown as DingTalkConfig,
      data: {
        msgId: "m_quote_reply",
        msgtype: "text",
        text: { content: "look at these pictures", isReplyMsg: true },
        originalMsgId: "m_multi_orig",
        conversationType: "1",
        conversationId: "cid_quote_test",
        senderId: "user_2",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: now + 60000,
      },
    } as unknown as { data: unknown });

    // Verify finalizeInboundContext received all 3 images
    const finalizeCalls = finalizeSpy.mock.calls;
    expect(finalizeCalls.length).toBeGreaterThanOrEqual(1);

    const ctx = finalizeCalls[0]![0] as Record<string, unknown>;
    expect(ctx.MediaPath).toBeTruthy();
    expect(Array.isArray(ctx.MediaPaths)).toBe(true);
    expect((ctx.MediaPaths as string[]).length).toBe(3);
    expect(Array.isArray(ctx.MediaUrls)).toBe(true);
    expect((ctx.MediaUrls as string[]).length).toBe(3);
    expect(Array.isArray(ctx.MediaTypes)).toBe(true);
    expect((ctx.MediaTypes as string[]).length).toBe(3);
  });
});
