import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig } from "../../src/platform/types";
// Import the fixture first: its vi.mock registrations must be in place before
// the module under test is evaluated.
import {
  shared,
  buildRuntime,
  beforeEachInboundHandlerCard,
  uploadMediaMock,
  prepareMediaInputMock,
} from "./fixtures/inbound-handler-card";
import { handleDingTalkMessage } from "../../src/gateway/inbound-handler";

describe("inbound-handler card failure fallback and structured payload", () => {
  beforeEach(beforeEachInboundHandlerCard);

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
    shared.sendSplitProactiveCardsMock.mockReset();
    shared.sendSplitProactiveCardsMock.mockResolvedValue({ ok: true, sent: 1, total: 1 });
    const cardMidFail = {
      cardInstanceId: "card_mid_fail",
      conversationId: "cid_ok",
      state: "1",
      lastUpdated: Date.now(),
    } as unknown as { cardInstanceId: string; conversationId: string; state: string; lastUpdated: number };
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
        await dispatcherOptions.deliver({ text: "tool output before failure" }, { kind: "tool" });
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
        msg.includes("Card failed, falling back to split multi-card delivery"),
      ),
    ).toBe(true);

    // Issue #615: card has conversationId, so the split multi-card fallback
    // is used instead of markdown.
    const fallbackCalls = shared.sendMessageMock.mock.calls.filter(
      (call: unknown[]) => (call as unknown[])?.[3]?.forceMarkdown === true,
    );
    expect(fallbackCalls).toHaveLength(0);
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
      { mediaLocalRoots: ["/test/agent-workspace"] },
    );
    const commitPayload = shared.commitAICardBlocksMock.mock.calls[shared.commitAICardBlocksMock.mock.calls.length - 1]?.[1];
    expect(commitPayload?.blockListJson).toContain('"type":3');
    expect(commitPayload?.blockListJson).toContain('"mediaId":"test-media-id"');
    expect(commitPayload?.content).toContain("说明如下");
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
});
