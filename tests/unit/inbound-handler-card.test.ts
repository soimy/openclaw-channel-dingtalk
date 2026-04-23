import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig } from "../../src/types";

const shared = vi.hoisted(() => ({
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  createAICardMock: vi.fn(),
  finishAICardMock: vi.fn(),
  commitAICardBlocksMock: vi.fn(),
  isCardInTerminalStateMock: vi.fn(),
  updateAICardBlockListMock: vi.fn(),
  streamAICardMock: vi.fn(),
  formatContentForCardMock: vi.fn((s: string) => s),
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
  sendProactiveMediaMock: vi.fn(),
  uploadMedia: vi.fn(),
}));

vi.mock("../../src/card-service", () => ({
  createAICard: shared.createAICardMock,
  finishAICard: shared.finishAICardMock,
  commitAICardBlocks: shared.commitAICardBlocksMock,
  formatContentForCard: shared.formatContentForCardMock,
  isCardInTerminalState: shared.isCardInTerminalStateMock,
  streamAICard: shared.streamAICardMock,
  updateAICardBlockList: shared.updateAICardBlockListMock,
  streamAICardContent: vi.fn(),
  clearAICardStreamingContent: vi.fn(),
}));

vi.mock("../../src/session-lock", () => ({
  acquireSessionLock: shared.acquireSessionLockMock,
}));

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

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  isAbortRequestText: vi.fn().mockReturnValue(false),
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
import * as sendService from "../../src/send-service";
import * as mediaUtils from "../../src/media-utils";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
import {
  clearTargetDirectoryStateCache,
} from "../../src/targeting/target-directory-store";

const mockedUpsertInboundMessageContext = vi.mocked(
  messageContextStore.upsertInboundMessageContext,
);
const uploadMediaMock = vi.mocked(sendService.uploadMedia);
const prepareMediaInputMock = vi.mocked(mediaUtils.prepareMediaInput);
const resolveOutboundMediaTypeMock = vi.mocked(mediaUtils.resolveOutboundMediaType);

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

describe("inbound-handler card lifecycle", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    mockedUpsertInboundMessageContext.mockClear();
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
    shared.createAICardMock.mockReset();
    shared.finishAICardMock.mockReset();
    shared.commitAICardBlocksMock.mockReset();
    shared.isCardInTerminalStateMock.mockReset();
    shared.updateAICardBlockListMock.mockReset().mockResolvedValue(undefined);
    shared.streamAICardMock.mockReset();
    uploadMediaMock.mockReset().mockResolvedValue({
      mediaId: "test-media-id",
      buffer: Buffer.from(""),
    } as never);
    prepareMediaInputMock.mockReset().mockImplementation(async (input: string) => ({ path: input }));
    resolveOutboundMediaTypeMock.mockReset().mockImplementation(({ mediaPath }: { mediaPath: string }) => {
      if (mediaPath.endsWith(".png") || mediaPath.endsWith(".jpg") || mediaPath.endsWith(".gif")) {
        return "image";
      }
      return "file";
    });
    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    resetProactivePermissionHintStateForTest();
    clearCardRunRegistryForTest();
    messageContextStore.clearMessageContextCacheForTest();
    shared.createAICardMock.mockResolvedValue({
      cardInstanceId: "card_1",
      state: "1",
      lastUpdated: Date.now(),
    });
  });

  it("handleDingTalkMessage runs card flow and finalizes AI card", async () => {
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as unknown as DingTalkConfig,
      data: {
        msgId: "m4",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
    expect(shared.updateAICardBlockListMock).toHaveBeenCalled();
    expect(mockedUpsertInboundMessageContext).toHaveBeenCalled();
  });

  it("handleDingTalkMessage falls back to markdown when card creation or finalization fails", async () => {
    // This merged test covers three failure scenarios:
    // 1. createAICard returns null (card not created)
    // 2. commitAICardBlocks throws (card fails at finalize)
    // 3. card fails mid-stream (updateAICardBlockList throws)

    // Scenario 1: createAICard returns null
    shared.createAICardMock.mockResolvedValueOnce(null);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "m6_card_degrade",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
    expect(shared.commitAICardBlocksMock).not.toHaveBeenCalled();
    expect(shared.sendMessageMock).toHaveBeenCalled();
    const cardSends = shared.sendMessageMock.mock.calls.filter((call: unknown[]) => (call as unknown[])?.[3]?.card);
    expect(cardSends).toHaveLength(0);

    // Reset for scenario 2: commitAICardBlocks throws
    shared.createAICardMock.mockReset();
    shared.commitAICardBlocksMock.mockReset();
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockImplementation(
      async (_config: unknown, _to: unknown, text: unknown, options: unknown) => {
        const opts = options as { card?: { lastStreamedContent: unknown }; cardUpdateMode?: string } | undefined;
        if (opts?.card && opts?.cardUpdateMode === "append") {
          opts.card.lastStreamedContent = text;
        }
        return { ok: true };
      },
    );
    const cardFailOnFinalize = { cardInstanceId: "card_fail_finalize", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(cardFailOnFinalize);
    shared.commitAICardBlocksMock.mockRejectedValueOnce({
      message: "finish failed",
      response: { data: { code: "invalidParameter", message: "cannot finalize" } },
    });
    const log = { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: log as unknown as { debug: unknown; error: unknown; warn: unknown; info: unknown },
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as unknown as DingTalkConfig,
      data: {
        msgId: "m7_finalize_fail",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown; log: unknown });

    expect(cardFailOnFinalize.state).toBe("5"); // Marked FAILED
    const debugLogs = log.debug.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      debugLogs.some(
        (entry) =>
          entry.includes("[DingTalk][ErrorPayload][inbound.cardFinalize]") &&
          entry.includes("code=invalidParameter") &&
          entry.includes("message=cannot finalize"),
      ),
    ).toBe(true);

    // Reset for scenario 3: card fails mid-stream
    shared.createAICardMock.mockReset();
    shared.commitAICardBlocksMock.mockReset();
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockImplementation(
      async (_config: unknown, _to: unknown, text: unknown, options: unknown) => {
        const opts = options as { card?: { lastStreamedContent: unknown }; cardUpdateMode?: string } | undefined;
        if (opts?.card && opts?.cardUpdateMode === "append") {
          opts.card.lastStreamedContent = text;
        }
        return { ok: true };
      },
    );
    shared.updateAICardBlockListMock.mockReset();
    shared.isCardInTerminalStateMock.mockReset();
    const cardMidFail = { cardInstanceId: "card_mid_fail", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(cardMidFail);
    shared.isCardInTerminalStateMock.mockImplementation(
      (state: string) => state === "3" || state === "5",
    );
    shared.updateAICardBlockListMock.mockImplementation(async () => {
      throw new Error("block list api error");
    });

    const logMidFail = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };

    const runtimeMidFail = buildRuntime();
    runtimeMidFail.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        replyOptions?.onPartialReply?.({ text: "partial content" });
        await new Promise((r) => setTimeout(r, 350));
        await dispatcherOptions.deliver({ text: "complete final answer" }, { kind: "final" });
        return { queuedFinal: "complete final answer" };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtimeMidFail);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: logMidFail as unknown as { debug: unknown; error: unknown; warn: unknown; info: unknown },
      dingtalkConfig: { dmPolicy: "open", messageType: "card", cardRealTimeStream: true } as unknown as DingTalkConfig,
      data: {
        msgId: "mid_fail_test",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown; log: unknown });

    const debugLogsMidFail = logMidFail.debug.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      debugLogsMidFail.some((msg) =>
        msg.includes("Card failed during streaming, sending markdown fallback"),
      ),
    ).toBe(true);

    // Fallback uses sendMessage with forceMarkdown to skip card creation
    const fallbackCalls = shared.sendMessageMock.mock.calls.filter(
      (call: unknown[]) => (call as unknown[])?.[3]?.forceMarkdown === true,
    );
    expect(fallbackCalls.length).toBeGreaterThanOrEqual(1);
    expect(fallbackCalls[0][2]).toContain("complete final answer");
  });

  it("handleDingTalkMessage skips finishAICard when current card is already terminal", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: "queued final" });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const card = { cardInstanceId: "card_terminal", state: "5", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockImplementation((state: string) => state === "5");

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as unknown as DingTalkConfig,
      data: {
        msgId: "m7_terminal",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.commitAICardBlocksMock).not.toHaveBeenCalled();
  });

  it("concurrent messages create independent cards with distinct IDs", async () => {
    let resolveA!: () => void;
    const gateA = new Promise<void>((r) => {
      resolveA = r;
    });

    const cardA = { cardInstanceId: "card_A", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    const cardB = { cardInstanceId: "card_B", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(cardA).mockResolvedValueOnce(cardB);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    const runtimeA = buildRuntime();
    runtimeA.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await gateA;
        await dispatcherOptions.deliver({ text: "reply A" }, { kind: "final" });
        return { queuedFinal: "reply A" };
      });
    const runtimeB = buildRuntime();
    runtimeB.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "reply B" }, { kind: "final" });
        return { queuedFinal: "reply B" };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtimeA).mockReturnValueOnce(runtimeB);

    const baseParams = {
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as unknown as DingTalkConfig,
    };

    const promiseA = handleDingTalkMessage({
      ...baseParams,
      data: {
        msgId: "concurrent_A",
        msgtype: "text",
        text: { content: "hello A" },
        conversationType: "1",
        conversationId: "cid_same",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    const promiseB = handleDingTalkMessage({
      ...baseParams,
      data: {
        msgId: "concurrent_B",
        msgtype: "text",
        text: { content: "hello B" },
        conversationType: "1",
        conversationId: "cid_same",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    await promiseB;
    resolveA();
    await promiseA;

    expect(shared.createAICardMock).toHaveBeenCalledTimes(2);
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(2);

    const finishCalls = shared.commitAICardBlocksMock.mock.calls;
    const finishedCardIds = finishCalls.map((call: unknown[]) => (call as unknown[])?.[0]?.cardInstanceId);
    expect(finishedCardIds).toContain("card_A");
    expect(finishedCardIds).toContain("card_B");
  });

  it("file-only response finalizes card with the standard empty reply and preserved process blocks", async () => {
    const card = { cardInstanceId: "card_file_only", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        replyOptions?.onReasoningStream?.({ text: "Let me send the file" });
        await new Promise((r) => setTimeout(r, 350));
        // Bot sent file via tool, deliver(final) has no text and no media
        await dispatcherOptions.deliver({ text: "" }, { kind: "final" });
        return {};
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "card",
        cardRealTimeStream: true,
      } as unknown as DingTalkConfig,
      data: {
        msgId: "mid_file_only",
        msgtype: "text",
        text: { content: "send me the file" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
    const finalizeContent = shared.commitAICardBlocksMock.mock.calls[0][1]?.content;
    // Only placeholder answer, reasoning blocks are excluded
    expect(finalizeContent).toContain("Done");
    expect(finalizeContent).not.toContain("Let me send the file");
  });

  it("releases session lock even when dispatchReply throws", async () => {
    const releaseFn = vi.fn();
    shared.acquireSessionLockMock.mockResolvedValueOnce(releaseFn);

    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("dispatch crash"));
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await expect(
      handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as { debug: unknown; error: unknown; warn: unknown; info: unknown },
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
        data: {
          msgId: "lock_crash",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown; dingtalkConfig: unknown; log: unknown }),
    ).rejects.toThrow("dispatch crash");

    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it("card finalize with empty deliver(final) text still finalizes card instead of early-returning", async () => {
    const card = { cardInstanceId: "card_empty_final", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "" }, { kind: "final" });
        return {};
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as unknown as DingTalkConfig,
      data: {
        msgId: "mid_empty_final",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
  });

  it("handleDingTalkMessage preserves mediaUrls from structured queuedFinal payload in card mode", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({
        queuedFinal: {
          text: "说明如下",
          mediaUrls: ["./artifacts/demo.png"],
        },
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const card = { cardInstanceId: "card_structured_queued_final", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as unknown as DingTalkConfig,
      data: {
        msgId: "m_structured_queued_final_media",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(prepareMediaInputMock.mock.calls[0]?.[0]).toBe("./artifacts/demo.png");
    expect(uploadMediaMock).toHaveBeenCalledWith(
      expect.anything(),
      "./artifacts/demo.png",
      "image",
      undefined,
    );
    const commitPayload = shared.commitAICardBlocksMock.mock.calls[shared.commitAICardBlocksMock.mock.calls.length - 1]?.[1];
    expect(commitPayload?.blockListJson).toContain('"type":3');
    expect(commitPayload?.blockListJson).toContain('"mediaId":"test-media-id"');
    expect(commitPayload?.content).toContain("说明如下");
  });

  it("handleDingTalkMessage finalizes card with default content when no textual output is produced", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: "" });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    const card = { cardInstanceId: "card_2", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as unknown as DingTalkConfig,
      data: {
        msgId: "m6",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledWith(card, expect.objectContaining({ content: expect.stringContaining("Done") }), undefined);
  });

  it("handleDingTalkMessage finalizes card using tool stream content when no final text exists", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "tool output" }, { kind: "tool" });
        return { queuedFinal: false };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const card = { cardInstanceId: "card_tool_only", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as unknown as DingTalkConfig,
      data: {
        msgId: "m6_tool",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledWith(card, expect.objectContaining({ content: expect.any(String) }), undefined);
    const finalizeContent = shared.commitAICardBlocksMock.mock.calls[0][1]?.content;
    // getRenderedContent now returns answer-only markdown, not tool blocks
    expect(finalizeContent).not.toContain("tool output");
  });

  it("card flow preserves off-mode partial answers when final payload is empty", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        expect(replyOptions?.onPartialReply).toBeDefined();
        await replyOptions?.onPartialReply?.({ text: "阶段性答案" });
        await dispatcherOptions.deliver({ text: "" }, { kind: "final" });
        return { queuedFinal: false };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const card = {
      cardInstanceId: "card_off_mode_partial_final_empty",
      state: "1",
      lastUpdated: Date.now(),
    } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "card",
        ackReaction: "",
        cardStreamingMode: "off",
      } as unknown as DingTalkConfig,
      data: {
        msgId: "m_card_off_partial_final_empty",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.streamAICardMock).not.toHaveBeenCalled();
    // PR#494 + V2: finalize uses commitAICardBlocks for block-based rendering
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledWith(
      card,
      expect.objectContaining({
        // The partial answer should be captured in the blockList
        blockListJson: expect.stringContaining("阶段性答案"),
      }),
      undefined,
    );
  });

  it("attempts to finalize active card when dispatchReply throws", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("dispatch crash"));
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const card = { cardInstanceId: "card_on_error", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);

    await expect(
      handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as { debug: unknown; error: unknown; warn: unknown; info: unknown },
        dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as unknown as DingTalkConfig,
        data: {
          msgId: "lock_crash_card",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown; dingtalkConfig: unknown; log: unknown }),
    ).rejects.toThrow("dispatch crash");

    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledWith(card, expect.objectContaining({ content: expect.stringContaining("处理失败") }), expect.objectContaining({ debug: expect.any(Function) }));
  });

  it("message A card in terminal state still finalizes without affecting message B", async () => {
    const cardA = { cardInstanceId: "card_term", state: "3", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(cardA);
    shared.isCardInTerminalStateMock.mockImplementation(
      (state: string) => state === "3" || state === "5",
    );

    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "term_card",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.commitAICardBlocksMock).not.toHaveBeenCalled();
    const cardSendCalls = shared.sendMessageMock.mock.calls.filter((call: unknown[]) => (call as unknown[])?.[3]?.card);
    expect(cardSendCalls).toHaveLength(0);
  });

  it("cardRealTimeStream finalize uses accumulated multi-turn content instead of last-turn-only deliver text", async () => {
    const card = { cardInstanceId: "card_accum", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        // Turn 1
        replyOptions?.onPartialReply?.({
          text: "Turn 1: Full inspection report with tables and analysis",
        });
        await new Promise((r) => setTimeout(r, 350));

        // Runtime signals new assistant turn (after tool call)
        replyOptions?.onAssistantMessageStart?.();

        // Turn 2: text starts fresh
        replyOptions?.onPartialReply?.({ text: "Turn 2 short summary" });
        await new Promise((r) => setTimeout(r, 350));

        // deliver(final) only provides last turn's text
        await dispatcherOptions.deliver({ text: "Turn 2 short summary" }, { kind: "final" });
        return {};
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "card",
        cardRealTimeStream: true,
        ackReaction: "",
      } as unknown as DingTalkConfig,
      data: {
        msgId: "mid_accum_test",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
    const finalizeContent = shared.commitAICardBlocksMock.mock.calls[0][1]?.content;
    expect(finalizeContent).toContain("Turn 1");
    expect(finalizeContent).toContain("Turn 2");
    expect(finalizeContent).not.toBe("Turn 2 short summary");
  });
});
