import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig } from "../../src/platform/types";
// Import the fixture first: its vi.mock registrations must be in place before
// the module under test is evaluated.
import {
  shared,
  buildRuntime,
  beforeEachInboundHandlerCard,
} from "./fixtures/inbound-handler-card";
import { handleDingTalkMessage } from "../../src/gateway/inbound-handler";

describe("inbound-handler card concurrency and session lock", () => {
  beforeEach(beforeEachInboundHandlerCard);

  it("concurrent messages: second message skips card creation when first card is still active", async () => {
    let resolveA!: () => void;
    const gateA = new Promise<void>((r) => {
      resolveA = r;
    });

    const cardA = { cardInstanceId: "card_A", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(cardA);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    // Override session routing so both messages share the same sessionKey
    // that contains the conversation ID — needed for the guard to match.
    const runtimeA = buildRuntime();
    runtimeA.channel.routing.resolveAgentRoute = vi
      .fn()
      .mockReturnValue({ agentId: "main", sessionKey: "dingtalk:direct:main:user_1", mainSessionKey: "s1" });
    runtimeA.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await gateA;
        await dispatcherOptions.deliver({ text: "reply A" }, { kind: "final" });
        return { queuedFinal: "reply A" };
      });
    const runtimeB = buildRuntime();
    runtimeB.channel.routing.resolveAgentRoute = vi
      .fn()
      .mockReturnValue({ agentId: "main", sessionKey: "dingtalk:direct:main:user_1", mainSessionKey: "s1" });
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

    // Wait for card_A creation to complete before starting message B.
    await vi.waitFor(() => {
      expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
    });

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

    // Only one card should be created — second message falls back to markdown.
    expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);

    const finishCalls = shared.commitAICardBlocksMock.mock.calls;
    const finishedCardIds = finishCalls.map((call: unknown[]) => (call as unknown[])?.[0]?.cardInstanceId);
    expect(finishedCardIds).toContain("card_A");
  });

  it("second message falls back to markdown when a card is already active for the same conversation", async () => {
    let resolveA!: () => void;
    const gateA = new Promise<void>((r) => {
      resolveA = r;
    });

    const cardA = { cardInstanceId: "card_A", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(cardA);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    const runtimeA = buildRuntime();
    runtimeA.channel.routing.resolveAgentRoute = vi
      .fn()
      .mockReturnValue({ agentId: "main", sessionKey: "dingtalk:direct:main:user_1", mainSessionKey: "s1" });
    runtimeA.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await gateA;
        await dispatcherOptions.deliver({ text: "reply A" }, { kind: "final" });
        return { queuedFinal: "reply A" };
      });
    const runtimeB = buildRuntime();
    runtimeB.channel.routing.resolveAgentRoute = vi
      .fn()
      .mockReturnValue({ agentId: "main", sessionKey: "dingtalk:direct:main:user_1", mainSessionKey: "s1" });
    runtimeB.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "reply B markdown" }, { kind: "final" });
        return { queuedFinal: "reply B markdown" };
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
        msgId: "concurrent_A2",
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

    await vi.waitFor(() => {
      expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
    });

    const promiseB = handleDingTalkMessage({
      ...baseParams,
      data: {
        msgId: "concurrent_B2",
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

    // Second message should not create a card — falls back to markdown.
    expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
    // Card should still be finalized (for message A).
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
  });

  it("non-owner message completing first should not remove card-flight key, preventing third message from creating a duplicate card", async () => {
    // P1 from Codex review: when B sees an existing entry but still holds
    // cardFlightKey, B's finally must NOT delete the key owned by A.
    // Scenario: A creates card → B falls back to markdown → B finishes first →
    // C arrives → C should also skip card creation.
    let resolveA!: () => void;
    const gateA = new Promise<void>((r) => {
      resolveA = r;
    });

    const cardA = { cardInstanceId: "card_A", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(cardA);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    // Message A: creates card, gate holds dispatch
    const runtimeA = buildRuntime();
    runtimeA.channel.routing.resolveAgentRoute = vi
      .fn()
      .mockReturnValue({ agentId: "main", sessionKey: "dingtalk:direct:main:user_1", mainSessionKey: "s1" });
    runtimeA.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await gateA;
        await dispatcherOptions.deliver({ text: "reply A" }, { kind: "final" });
        return { queuedFinal: "reply A" };
      });

    // Message B: sees existing card, falls back to markdown, finishes fast
    const runtimeB = buildRuntime();
    runtimeB.channel.routing.resolveAgentRoute = vi
      .fn()
      .mockReturnValue({ agentId: "main", sessionKey: "dingtalk:direct:main:user_1", mainSessionKey: "s1" });
    runtimeB.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "reply B markdown" }, { kind: "final" });
        return { queuedFinal: "reply B markdown" };
      });

    // Message C: arrives after B completes but before A's dispatch finishes
    const runtimeC = buildRuntime();
    runtimeC.channel.routing.resolveAgentRoute = vi
      .fn()
      .mockReturnValue({ agentId: "main", sessionKey: "dingtalk:direct:main:user_1", mainSessionKey: "s1" });
    runtimeC.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "reply C markdown" }, { kind: "final" });
        return { queuedFinal: "reply C markdown" };
      });

    shared.getRuntimeMock
      .mockReturnValueOnce(runtimeA)
      .mockReturnValueOnce(runtimeB)
      .mockReturnValueOnce(runtimeC);

    const baseParams = {
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as unknown as DingTalkConfig,
    };

    // Message A: creates card, gate holds dispatch
    const promiseA = handleDingTalkMessage({
      ...baseParams,
      data: {
        msgId: "race_A",
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

    // Wait for card_A creation to complete.
    await vi.waitFor(() => {
      expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
    });

    // Message B: sees existing card, falls back to markdown
    const promiseB = handleDingTalkMessage({
      ...baseParams,
      data: {
        msgId: "race_B",
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

    // B completes first (markdown path, no lock hold)
    await promiseB;

    // Message C: arrives after B, before A. Should also skip card creation.
    await handleDingTalkMessage({
      ...baseParams,
      data: {
        msgId: "race_C",
        msgtype: "text",
        text: { content: "hello C" },
        conversationType: "1",
        conversationId: "cid_same",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    // Resolve A's gate, let it finish
    resolveA();
    await promiseA;

    // Only message A should have created a card.
    expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
  });

  it("card-flight key is cleaned up when handler throws between card creation and session lock", async () => {
    // P2 from Codex review: when the handler throws between card creation
    // and session lock acquisition, the card-flight key must be cleaned up
    // so future messages can create cards for the same conversation.
    const cardA = { cardInstanceId: "card_A", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(cardA).mockResolvedValueOnce({
      cardInstanceId: "card_B",
      state: "1",
      lastUpdated: Date.now(),
    });
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    // First message: recordInboundSession throws after card creation
    const runtimeA = buildRuntime();
    runtimeA.channel.session.recordInboundSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("session write failure"));
    shared.getRuntimeMock.mockReturnValueOnce(runtimeA);

    // Second message: all operations succeed
    const runtimeB = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtimeB);

    const baseParams = {
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as { debug: unknown; error: unknown; warn: unknown; info: unknown },
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as unknown as DingTalkConfig,
    };

    // Message A: creates card, then throws at recordInboundSession
    await expect(
      handleDingTalkMessage({
        ...baseParams,
        data: {
          msgId: "throw_A",
          msgtype: "text",
          text: { content: "hello A" },
          conversationType: "1",
          conversationId: "cid_same",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as { data: unknown; dingtalkConfig: unknown; log: unknown }),
    ).rejects.toThrow("session write failure");

    // Message B: should be able to create a card since cardFlightKey was cleaned up
    await handleDingTalkMessage({
      ...baseParams,
      data: {
        msgId: "throw_B",
        msgtype: "text",
        text: { content: "hello B" },
        conversationType: "1",
        conversationId: "cid_same",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown; log: unknown });

    // Both messages should have created cards.
    expect(shared.createAICardMock).toHaveBeenCalledTimes(2);
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
});
