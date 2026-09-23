import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig } from "../../src/platform/types";
// Import the fixture first: its vi.mock registrations must be in place before
// the module under test is evaluated.
import {
  shared,
  buildRuntime,
  beforeEachInboundHandlerCard,
  mockedUpsertInboundMessageContext,
} from "./fixtures/inbound-handler-card";
import { handleDingTalkMessage } from "../../src/gateway/inbound-handler";

describe("inbound-handler card lifecycle", () => {
  beforeEach(beforeEachInboundHandlerCard);

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

  it("passes configured agent model into initial AI card statusLine on first request", async () => {
    await handleDingTalkMessage({
      cfg: {
        agents: {
          defaults: {
            model: "deepseek/deepseek-v4-pro",
            thinkingDefault: "high",
          },
          list: [{ id: "main" }],
        },
      },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as unknown as DingTalkConfig,
      data: {
        msgId: "m_initial_model",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_initial_model",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
    const options = shared.createAICardMock.mock.calls[0][3] as { statusLine?: string };
    expect(options.statusLine).toContain("deepseek-v4-pro");
    expect(options.statusLine).toContain("high");
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
