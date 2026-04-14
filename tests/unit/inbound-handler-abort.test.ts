import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig, DingTalkInboundMessage } from "../../src/types";

const shared = vi.hoisted(() => ({
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  isAbortRequestTextMock: vi.fn(),
  createAICardMock: vi.fn(),
  finishAICardMock: vi.fn(),
  commitAICardBlocksMock: vi.fn(),
}));

vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("token_abc"),
}));

vi.mock("../../src/runtime", () => ({
  getDingTalkRuntime: shared.getRuntimeMock,
}));

vi.mock("../../src/message-utils", () => ({
  extractMessageContent: shared.extractMessageContentMock,
}));

vi.mock("../../src/send-service", () => ({
  sendBySession: shared.sendBySessionMock,
  sendMessage: shared.sendMessageMock,
  sendProactiveMedia: shared.sendProactiveMediaMock,
  uploadMedia: vi.fn(),
}));

vi.mock("../../src/card-service", () => ({
  createAICard: shared.createAICardMock,
  finishAICard: shared.finishAICardMock,
  commitAICardBlocks: shared.commitAICardBlocksMock,
  formatContentForCard: vi.fn((s: string) => s),
  isCardInTerminalState: vi.fn(),
  streamAICard: vi.fn(),
  updateAICardBlockList: vi.fn(),
  streamAICardContent: vi.fn(),
  clearAICardStreamingContent: vi.fn(),
}));

vi.mock("../../src/session-lock", () => ({
  acquireSessionLock: shared.acquireSessionLockMock,
}));

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

vi.mock("../../src/messaging/quoted-file-service", () => ({
  downloadGroupFile: vi.fn().mockResolvedValue(null),
  getUnionIdByStaffId: vi.fn().mockResolvedValue("union_1"),
  resolveQuotedFile: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/messaging/attachment-text-extractor", () => ({
  extractAttachmentText: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/media-utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/media-utils")>("../../src/media-utils");
  return {
    ...actual,
    prepareMediaInput: vi.fn(),
    resolveOutboundMediaType: vi.fn(),
  };
});

import { handleDingTalkMessage } from "../../src/inbound-handler";

function buildRuntime() {
  return {
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
          async ({ dispatcherOptions, replyOptions }) => {
            await replyOptions?.onReasoningStream?.({ text: "thinking" });
            await dispatcherOptions.deliver({ text: "tool output" }, { kind: "tool" });
            await dispatcherOptions.deliver({ text: "final output" }, { kind: "final" });
            return { queuedFinal: "queued final" };
          },
        ),
      },
    },
  };
}

describe("inbound-handler abort pre-lock bypass", () => {
  const baseData = {
    msgId: "abort_m1",
    msgtype: "text",
    text: { content: "停止" },
    conversationType: "1",
    conversationId: "cid_abort",
    senderId: "user_1",
    chatbotUserId: "bot_1",
    sessionWebhook: "https://session.webhook/abort",
    createAt: Date.now(),
  };

  beforeEach(() => {
    shared.sendBySessionMock.mockReset();
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockImplementation(
      async (_config: unknown, _to: unknown, text: unknown, options: unknown) => {
        // Simulate real sendMessage behavior: update lastStreamedContent when appending to card
        const opts = options as { card?: { lastStreamedContent: unknown }; cardUpdateMode?: string } | undefined;
        if (opts?.card && opts?.cardUpdateMode === "append") {
          opts.card.lastStreamedContent = text;
        }
        return { ok: true };
      },
    );
    shared.extractMessageContentMock.mockReset();
    shared.extractMessageContentMock.mockReturnValue({ text: "hello", messageType: "text" });
    shared.acquireSessionLockMock.mockReset();
    shared.acquireSessionLockMock.mockResolvedValue(vi.fn());
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.createAICardMock.mockReset();
    shared.finishAICardMock.mockReset();
    shared.getRuntimeMock.mockReturnValue(buildRuntime());
  });

  it("bypasses session lock and dispatches when isAbortRequestText returns true", async () => {
    shared.extractMessageContentMock.mockReturnValue({ text: "停止", messageType: "text" });
    shared.isAbortRequestTextMock.mockReturnValue(true);
    shared.sendBySessionMock.mockResolvedValue({ data: {} });

    const rt = buildRuntime();
    vi.mocked(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementationOnce(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver({ text: "已停止响应" });
        return { queuedFinal: true, counts: { final: 1 } };
      },
    );
    shared.getRuntimeMock.mockReturnValue(rt);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook/abort",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: baseData,
    } as any);

    // session lock should NOT be acquired
    expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
    // abort dispatch should be called
    expect(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    // abort deliver should call sendBySession
    expect(shared.sendBySessionMock).toHaveBeenCalledWith(
      expect.anything(),
      "https://session.webhook/abort",
      "已停止响应",
      expect.anything(),
    );
  });

  it("falls back to sendMessage when sessionWebhook is absent", async () => {
    shared.extractMessageContentMock.mockReturnValue({ text: "停止", messageType: "text" });
    shared.isAbortRequestTextMock.mockReturnValue(true);
    shared.sendMessageMock.mockResolvedValue({ ok: true });

    const rt = buildRuntime();
    vi.mocked(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementationOnce(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver({ text: "已停止响应" });
        return { queuedFinal: true, counts: { final: 1 } };
      },
    );
    shared.getRuntimeMock.mockReturnValue(rt);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "", // no webhook
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: { ...baseData, sessionWebhook: "" },
    } as any);

    expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
    expect(shared.sendMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      "已停止响应",
      expect.anything(),
    );
  });

  it("acquires session lock normally when isAbortRequestText returns false", async () => {
    shared.extractMessageContentMock.mockReturnValue({ text: "hello", messageType: "text" });
    shared.isAbortRequestTextMock.mockReturnValue(false);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook/abort",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: baseData,
    } as any);

    expect(shared.acquireSessionLockMock).toHaveBeenCalledTimes(1);
  });

  it("swallows deliver errors in abort path without propagating", async () => {
    shared.extractMessageContentMock.mockReturnValue({ text: "停止", messageType: "text" });
    shared.isAbortRequestTextMock.mockReturnValue(true);
    shared.sendBySessionMock.mockRejectedValue(new Error("network error"));

    const rt = buildRuntime();
    vi.mocked(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementationOnce(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver({ text: "已停止响应" });
        return { queuedFinal: false, counts: { final: 0 } };
      },
    );
    shared.getRuntimeMock.mockReturnValue(rt);

    // should not throw
    await expect(
      handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook/abort",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as any,
        data: baseData,
      } as any),
    ).resolves.toBeUndefined();
  });

  it("finalizes the card with abort text when card mode is active", async () => {
    const card = { cardInstanceId: "card_abort_1", state: "1", lastUpdated: Date.now() };
    shared.createAICardMock.mockResolvedValue(card);
    shared.extractMessageContentMock.mockReturnValue({ text: "停止", messageType: "text" });
    shared.isAbortRequestTextMock.mockReturnValue(true);

    const rt = buildRuntime();
    vi.mocked(rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementationOnce(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver({ text: "⚙️ Agent was aborted." });
        return { queuedFinal: true, counts: { final: 1 } };
      },
    );
    shared.getRuntimeMock.mockReturnValue(rt);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook/abort",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as any,
      data: baseData,
    } as any);

    // session lock should NOT be acquired
    expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
    // abort text should be written to card, not sent as plain text
    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
    // Abort flow uses commitAICardBlocks (V2 instances API) for consistent state transition
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledWith(
      card,
      expect.objectContaining({
        blockListJson: expect.stringContaining("⚙️ Agent was aborted."),
        content: "⚙️ Agent was aborted.",
      }),
      undefined,
    );
    // finishAICard should NOT be called (deprecated API)
    expect(shared.finishAICardMock).not.toHaveBeenCalled();
  });

  it("strips leading @mention from group and DM messages before abort check", async () => {
    // Test both group (@Bot in group chat) and DM (@Agent in multi-agent DM) scenarios
    // DingTalk does not strip @BotName from text.content, so isAbortRequestText must match bare command

    // Group message test
    shared.extractMessageContentMock.mockReturnValueOnce({ text: "@Bot 停止", messageType: "text" });
    shared.isAbortRequestTextMock.mockImplementationOnce((text: string) => text === "停止");
    shared.sendBySessionMock.mockResolvedValueOnce({ data: {} });

    const rtGroup = buildRuntime();
    vi.mocked(rtGroup.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementationOnce(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver({ text: "已停止响应" });
        return { queuedFinal: true, counts: { final: 1 } };
      },
    );
    shared.getRuntimeMock.mockReturnValueOnce(rtGroup);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook/abort",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        ...baseData,
        msgId: "abort_group_mention",
        text: { content: "@Bot 停止" },
        conversationType: "2",
        conversationId: "cid_group_abort",
      },
    } as any);

    // @mention stripped in group -> "停止" matches -> session lock should NOT be acquired
    expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
    expect(rtGroup.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

    // Reset mocks for DM test
    shared.acquireSessionLockMock.mockReset();
    shared.acquireSessionLockMock.mockResolvedValue(vi.fn());

    // DM message test - in multi-agent DM, text like "@Agent /stop" must still bypass the session lock
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "@Agent /stop",
      messageType: "text",
      atMentions: [{ name: "Agent" }],
    });
    shared.isAbortRequestTextMock.mockImplementationOnce((text: string) => text === "/stop");
    shared.sendBySessionMock.mockResolvedValueOnce({ data: {} });

    const rtDM = buildRuntime();
    vi.mocked(rtDM.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementationOnce(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver({ text: "已停止响应" });
        return { queuedFinal: true, counts: { final: 1 } };
      },
    );
    shared.getRuntimeMock.mockReturnValueOnce(rtDM);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook/abort",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        ...baseData,
        msgId: "abort_dm_mention",
        text: { content: "@Agent /stop" },
        conversationType: "1",
        conversationId: "cid_dm_abort",
      },
    } as any);

    // @mention stripped in DM -> "/stop" matches -> session lock should NOT be acquired
    expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
    expect(rtDM.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });
});
