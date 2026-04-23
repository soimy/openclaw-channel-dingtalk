import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig } from "../../src/types";

const shared = vi.hoisted(() => ({
  getRuntimeMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  downloadGroupFileMock: vi.fn(),
  getUnionIdByStaffIdMock: vi.fn(),
  resolveQuotedFileMock: vi.fn(),
  extractAttachmentTextMock: vi.fn(),
  createAICardMock: vi.fn(),
  sendMessageMock: vi.fn(),
  sendBySessionMock: vi.fn(),
  commitAICardBlocksMock: vi.fn(),
  streamAICardMock: vi.fn(),
  isCardInTerminalStateMock: vi.fn(),
  updateAICardBlockListMock: vi.fn(),
  streamAICardContentMock: vi.fn(),
  clearAICardStreamingContentMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  prepareMediaInputMock: vi.fn(),
  resolveOutboundMediaTypeMock: vi.fn(),
  isAbortRequestTextMock: vi.fn(),
  formatContentForCardMock: vi.fn((s: string) => s),
  sendProactiveMediaMock: vi.fn(),
  uploadMediaMock: vi.fn(),
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

vi.mock("../../src/send-service", () => ({
  sendBySession: shared.sendBySessionMock,
  sendMessage: shared.sendMessageMock,
  sendProactiveMedia: shared.sendProactiveMediaMock,
  uploadMedia: shared.uploadMediaMock,
}));

vi.mock("../../src/card-service", () => ({
  createAICard: shared.createAICardMock,
  commitAICardBlocks: shared.commitAICardBlocksMock,
  formatContentForCard: shared.formatContentForCardMock,
  isCardInTerminalState: shared.isCardInTerminalStateMock,
  streamAICard: shared.streamAICardMock,
  updateAICardBlockList: shared.updateAICardBlockListMock,
  streamAICardContent: shared.streamAICardContentMock,
  clearAICardStreamingContent: shared.clearAICardStreamingContentMock,
}));

vi.mock("../../src/session-lock", () => ({
  acquireSessionLock: shared.acquireSessionLockMock,
}));

vi.mock("../../src/media-utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/media-utils")>("../../src/media-utils");
  return {
    ...actual,
    prepareMediaInput: shared.prepareMediaInputMock,
    resolveOutboundMediaType: shared.resolveOutboundMediaTypeMock,
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  isAbortRequestText: shared.isAbortRequestTextMock,
  isBtwRequestText: vi.fn().mockReturnValue(false),
}));

vi.mock("../../src/message-context-store", async () => {
  const actual = await vi.importActual<typeof import("../../src/message-context-store")>(
    "../../src/message-context-store",
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

import { handleDingTalkMessage, resetProactivePermissionHintStateForTest } from "../../src/inbound-handler";
import * as messageContextStore from "../../src/message-context-store";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
import {
  clearTargetDirectoryStateCache,
} from "../../src/targeting/target-directory-store";

const mockedUpsertInboundMessageContext = vi.mocked(messageContextStore.upsertInboundMessageContext);
const mockedResolveByMsgId = vi.mocked(messageContextStore.resolveByMsgId);
const mockedResolveByAlias = vi.mocked(messageContextStore.resolveByAlias);
const mockedResolveByCreatedAtWindow = vi.mocked(messageContextStore.resolveByCreatedAtWindow);

function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi
          .fn()
          .mockReturnValue({ agentId: "main", sessionKey: "s1", mainSessionKey: "s1" }),
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
        dispatchReplyWithBufferedBlockDispatcher: vi
          .fn()
          .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
            await replyOptions?.onReasoningStream?.({ text: "thinking" });
            await dispatcherOptions.deliver({ text: "tool output" }, { kind: "tool" });
            await dispatcherOptions.deliver({ text: "final output" }, { kind: "final" });
            return { queuedFinal: "queued final" };
          }),
      },
    },
  };
}

describe("inbound-handler media handling", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    // Use rimraf-style cleanup: retry on ENOTEMPTY
    const stateDir = path.join(path.dirname("/tmp/store.json"), "dingtalk-state");
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch (e) {
      // On some platforms, recursive rm may fail on non-empty dirs; retry once
      if ((e as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
    shared.getRuntimeMock.mockReset();
    shared.extractMessageContentMock.mockReset();
    shared.downloadGroupFileMock.mockReset();
    shared.downloadGroupFileMock.mockResolvedValue(null);
    shared.getUnionIdByStaffIdMock.mockReset();
    shared.getUnionIdByStaffIdMock.mockResolvedValue("union_1");
    shared.resolveQuotedFileMock.mockReset();
    shared.resolveQuotedFileMock.mockResolvedValue(null);
    shared.extractAttachmentTextMock.mockReset();
    shared.extractAttachmentTextMock.mockResolvedValue(null);
    shared.createAICardMock.mockReset();
    shared.createAICardMock.mockResolvedValue({
      cardInstanceId: "card_1",
      state: "1",
      lastUpdated: Date.now(),
    });
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockImplementation(
      async (_config: unknown, _to: unknown, text: unknown, options: { card?: { lastStreamedContent?: unknown }; cardUpdateMode?: string }) => {
        if (options?.card && options?.cardUpdateMode === "append") {
          options.card.lastStreamedContent = text;
        }
        return { ok: true };
      },
    );
    shared.sendBySessionMock.mockReset();
    shared.commitAICardBlocksMock.mockReset();
    shared.streamAICardMock.mockReset();
    shared.isCardInTerminalStateMock.mockReset();
    shared.updateAICardBlockListMock.mockReset().mockResolvedValue(undefined);
    shared.streamAICardContentMock.mockReset().mockResolvedValue(undefined);
    shared.clearAICardStreamingContentMock.mockReset().mockResolvedValue(undefined);
    shared.acquireSessionLockMock.mockReset();
    shared.acquireSessionLockMock.mockResolvedValue(vi.fn());
    shared.prepareMediaInputMock.mockReset();
    shared.prepareMediaInputMock.mockImplementation(async (rawMediaUrl: string) => ({
      path: `/tmp/prepared/${path.basename(rawMediaUrl) || "media.bin"}`,
      cleanup: vi.fn().mockResolvedValue(undefined),
    }));
    shared.resolveOutboundMediaTypeMock.mockReset();
    shared.resolveOutboundMediaTypeMock.mockReturnValue("file");
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.sendProactiveMediaMock.mockReset();
    shared.sendProactiveMediaMock.mockResolvedValue({ ok: true });
    shared.uploadMediaMock.mockReset();
    shared.formatContentForCardMock.mockImplementation((s: string) => s);

    mockedUpsertInboundMessageContext.mockClear();
    mockedResolveByMsgId.mockClear();
    mockedResolveByAlias.mockClear();
    mockedResolveByCreatedAtWindow.mockClear();

    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    shared.extractMessageContentMock.mockReturnValue({ text: "hello", messageType: "text" });
    resetProactivePermissionHintStateForTest();
    clearCardRunRegistryForTest();
    messageContextStore.clearMessageContextCacheForTest();
  });

  it("deliver callback sends single media payload through session webhook", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { mediaUrl: "https://cdn.example.com/report.pdf" },
          { kind: "final" },
        );
        return { queuedFinal: false };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const cleanup = vi.fn().mockResolvedValue(undefined);
    shared.prepareMediaInputMock.mockResolvedValueOnce({
      path: "/tmp/prepared/report.pdf",
      cleanup,
    });
    shared.resolveOutboundMediaTypeMock.mockReturnValueOnce("file");

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "m_media_single",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.prepareMediaInputMock).toHaveBeenCalledWith(
      "https://cdn.example.com/report.pdf",
      undefined,
      undefined,
    );
    expect(shared.sendMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      "",
      expect.objectContaining({
        sessionWebhook: "https://session.webhook",
        mediaPath: "/tmp/prepared/report.pdf",
        mediaType: "file",
        quotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "m_media_single",
        },
      }),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("deliver callback preserves audioAsVoice for runtime media payloads", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { mediaUrl: "https://cdn.example.com/clip.mp3", audioAsVoice: true },
          { kind: "final" },
        );
        return { queuedFinal: false };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const cleanup = vi.fn().mockResolvedValue(undefined);
    shared.prepareMediaInputMock.mockResolvedValueOnce({
      path: "/tmp/prepared/clip.mp3",
      cleanup,
    });
    shared.resolveOutboundMediaTypeMock.mockReturnValueOnce("voice");

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "m_media_voice",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.resolveOutboundMediaTypeMock).toHaveBeenCalledWith({
      mediaPath: "/tmp/prepared/clip.mp3",
      asVoice: true,
    });
    expect(shared.sendMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      "",
      expect.objectContaining({
        sessionWebhook: "https://session.webhook",
        mediaPath: "/tmp/prepared/clip.mp3",
        mediaType: "voice",
      }),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("deliver callback still honors legacy asVoice when audioAsVoice is unset", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { mediaUrl: "https://cdn.example.com/legacy-clip.mp3", asVoice: "true" },
          { kind: "final" },
        );
        return { queuedFinal: false };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const cleanup = vi.fn().mockResolvedValue(undefined);
    shared.prepareMediaInputMock.mockResolvedValueOnce({
      path: "/tmp/prepared/legacy-clip.mp3",
      cleanup,
    });
    shared.resolveOutboundMediaTypeMock.mockReturnValueOnce("voice");

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "m_media_voice_legacy",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.resolveOutboundMediaTypeMock).toHaveBeenCalledWith({
      mediaPath: "/tmp/prepared/legacy-clip.mp3",
      asVoice: true,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("deliver callback sends multiple media payloads sequentially", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { mediaUrls: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"] },
          { kind: "final" },
        );
        return { queuedFinal: false };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const cleanupA = vi.fn().mockResolvedValue(undefined);
    const cleanupB = vi.fn().mockResolvedValue(undefined);
    shared.prepareMediaInputMock
      .mockResolvedValueOnce({ path: "/tmp/prepared/a.png", cleanup: cleanupA })
      .mockResolvedValueOnce({ path: "/tmp/prepared/b.png", cleanup: cleanupB });
    shared.resolveOutboundMediaTypeMock.mockReturnValue("image");

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "m_media_multi",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendMessageMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "user_1",
      "",
      expect.objectContaining({
        sessionWebhook: "https://session.webhook",
        mediaPath: "/tmp/prepared/a.png",
        mediaType: "image",
        quotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "m_media_multi",
        },
      }),
    );
    expect(shared.sendMessageMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "user_1",
      "",
      expect.objectContaining({
        sessionWebhook: "https://session.webhook",
        mediaPath: "/tmp/prepared/b.png",
        mediaType: "image",
        quotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "m_media_multi",
        },
      }),
    );
    expect(cleanupA).toHaveBeenCalledTimes(1);
    expect(cleanupB).toHaveBeenCalledTimes(1);
  });

  it("deliver callback sends mixed text and media payloads", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { text: "final output", mediaUrl: "https://cdn.example.com/report.pdf" },
          { kind: "final" },
        );
        return { queuedFinal: false };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "m_media_text",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendMessageMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "user_1",
      "",
      expect.objectContaining({
        sessionWebhook: "https://session.webhook",
        mediaPath: "/tmp/prepared/report.pdf",
        mediaType: "file",
        quotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "m_media_text",
        },
      }),
    );
    expect(shared.sendMessageMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "user_1",
      "final output",
      expect.objectContaining({
        sessionWebhook: "https://session.webhook",
        quotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "m_media_text",
        },
      }),
    );
  });

  it("card mode + media embeds media as image block in card", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { text: "final output", mediaUrl: "https://cdn.example.com/photo.png" },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const card = { cardInstanceId: "card_media_final", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.prepareMediaInputMock.mockResolvedValueOnce({
      path: "/tmp/prepared/photo.png",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    shared.resolveOutboundMediaTypeMock.mockReturnValueOnce("image");
    shared.uploadMediaMock.mockResolvedValueOnce({ mediaId: "media_img_123" });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "m_card_media_text",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    // Media should be uploaded and embedded as image block in card, not sent via sendMessage
    expect(shared.prepareMediaInputMock).toHaveBeenCalledWith(
      "https://cdn.example.com/photo.png",
      undefined,
      undefined,
    );
    expect(shared.resolveOutboundMediaTypeMock).toHaveBeenCalledWith({
      mediaPath: "/tmp/prepared/photo.png",
      asVoice: false,
    });
    expect(shared.uploadMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({ dmPolicy: "open", messageType: "card" }),
      "/tmp/prepared/photo.png",
      "image",
      undefined,
    );
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledWith(
      card,
      expect.objectContaining({ content: "final output" }),  // answer-only markdown (image block excluded)
      undefined,
    );
  });

  it("deliver callback falls back to proactive media send when sessionWebhook is absent", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { mediaUrl: "https://cdn.example.com/report.pdf" },
          { kind: "final" },
        );
        return { queuedFinal: false };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: undefined,
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "m_media_proactive",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
    expect(shared.sendProactiveMediaMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      "/tmp/prepared/report.pdf",
      "file",
      {
        accountId: "main",
        log: undefined,
        storePath: "/tmp/store.json",
        conversationId: "cid_ok",
        quotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "m_media_proactive",
        },
      },
    );
  });

  it("deliver callback cleans up prepared media when send fails", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { mediaUrl: "https://cdn.example.com/report.pdf" },
          { kind: "final" },
        );
        return { queuedFinal: false };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const cleanup = vi.fn().mockResolvedValue(undefined);
    shared.prepareMediaInputMock.mockResolvedValueOnce({
      path: "/tmp/prepared/report.pdf",
      cleanup,
    });
    shared.sendMessageMock.mockResolvedValueOnce({ ok: false, error: "send failed" });

    await expect(
      handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_media_cleanup_failure",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as any),
    ).rejects.toThrow("send failed");

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
