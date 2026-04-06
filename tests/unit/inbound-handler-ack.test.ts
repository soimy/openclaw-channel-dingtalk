import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";

const shared = vi.hoisted(() => ({
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  isAbortRequestTextMock: vi.fn(),
  createAICardMock: vi.fn(),
  isCardInTerminalStateMock: vi.fn(),
  commitAICardBlocksMock: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
    isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
  },
  isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
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
  finishAICard: vi.fn(),
  commitAICardBlocks: shared.commitAICardBlocksMock,
  formatContentForCard: vi.fn((s: string) => s),
  isCardInTerminalState: shared.isCardInTerminalStateMock,
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
import { getAccessToken } from "../../src/auth";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
import * as messageContextStore from "../../src/message-context-store";

const mockedAxiosPost = vi.mocked(axios.post);
const mockedGetAccessToken = vi.mocked(getAccessToken);

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

describe("inbound-handler ack reaction", () => {
  beforeEach(() => {
    mockedAxiosPost.mockReset();
    mockedAxiosPost.mockResolvedValue({ data: { success: true } } as unknown as typeof axios.post extends (...args: infer R) => unknown ? R[1] : never);
    mockedGetAccessToken.mockReset();
    mockedGetAccessToken.mockResolvedValue("token_abc");
    shared.sendBySessionMock.mockReset();
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
    shared.extractMessageContentMock.mockReset();
    shared.extractMessageContentMock.mockReturnValue({ text: "hello", messageType: "text" });
    shared.acquireSessionLockMock.mockReset();
    shared.acquireSessionLockMock.mockResolvedValue(vi.fn());
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    shared.createAICardMock.mockReset();
    shared.createAICardMock.mockResolvedValue({
      cardInstanceId: "card_1",
      state: "1",
      lastUpdated: Date.now(),
    } as unknown as ReturnType<typeof shared.createAICardMock extends (...args: unknown[]) => infer R ? () => R : never>);
    shared.isCardInTerminalStateMock.mockReset();
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.commitAICardBlocksMock.mockReset();
    shared.commitAICardBlocksMock.mockResolvedValue(undefined);
    messageContextStore.clearMessageContextCacheForTest();
    clearCardRunRegistryForTest();
  });

  it("attaches and recalls native ack reaction in markdown mode", async () => {
    vi.useFakeTimers();
    const releaseFn = vi.fn();
    shared.acquireSessionLockMock.mockResolvedValueOnce(releaseFn);
    try {
      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "markdown",
          ackReaction: "🤔思考中",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_reaction",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);
      await vi.advanceTimersByTimeAsync(1200);

      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        1,
        "https://api.dingtalk.com/v1.0/robot/emotion/reply",
        expect.objectContaining({
          robotCode: "ding_client",
          openMsgId: "m5_reaction",
          openConversationId: "cid_ok",
          emotionName: "🤔思考中",
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-acs-dingtalk-access-token": "token_abc",
          }),
        }),
      );
      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        2,
        "https://api.dingtalk.com/v1.0/robot/emotion/recall",
        expect.objectContaining({
          robotCode: "ding_client",
          openMsgId: "m5_reaction",
          openConversationId: "cid_ok",
          emotionName: "🤔思考中",
        }),
        expect.any(Object),
      );
      expect(mockedAxiosPost.mock.invocationCallOrder[0]).toBeLessThan(
        shared.acquireSessionLockMock.mock.invocationCallOrder[0],
      );
      expect(mockedAxiosPost.mock.invocationCallOrder[1]).toBeLessThan(
        releaseFn.mock.invocationCallOrder[0],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases session lock after a bounded wait when dynamic ack cleanup stalls", async () => {
    vi.useFakeTimers();
    const releaseFn = vi.fn();
    const debugLog = vi.fn();
    let resolveRecall: (() => void) | undefined;
    shared.acquireSessionLockMock.mockResolvedValueOnce(releaseFn);
    mockedAxiosPost
      .mockResolvedValueOnce({ data: { success: true } } as unknown as typeof axios.post extends (...args: infer R) => unknown ? R[1] : never)
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          resolveRecall = resolve;
        }),
      );

    try {
      const handlePromise = handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: { debug: debugLog, warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Parameters<typeof handleDingTalkMessage>[0]["log"],
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "markdown",
          ackReaction: "🤔思考中",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_cleanup_timeout",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);

      await vi.advanceTimersByTimeAsync(1700);
      await handlePromise;

      expect(releaseFn).toHaveBeenCalledTimes(1);
      expect(
        debugLog.mock.calls.some(([message]) =>
          typeof message === "string"
          && message.includes("Dynamic ack reaction cleanup timed out after 500ms"),
        ),
      ).toBe(true);

      resolveRecall?.();
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses native ack reaction when configured with custom emoji string", async () => {
    vi.useFakeTimers();
    try {
      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "markdown",
          ackReaction: "🤔思考中",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_ackreaction_native",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);
      await vi.advanceTimersByTimeAsync(1200);

      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        1,
        "https://api.dingtalk.com/v1.0/robot/emotion/reply",
        expect.objectContaining({
          openMsgId: "m5_ackreaction_native",
          openConversationId: "cid_ok",
          emotionName: "🤔思考中",
        }),
        expect.any(Object),
      );
      const sentTexts = shared.sendMessageMock.mock.calls.map((call: unknown[]) =>
        String((call as unknown[])[2] ?? ""),
      );
      expect(sentTexts.some((text: string) => text.includes("思考中"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back through global messages.ackReaction, agent identity emoji, then default", async () => {
    vi.useFakeTimers();
    try {
      // Test 1: Falls back to global messages.ackReaction when channel ackReaction is absent
      await handleDingTalkMessage({
        cfg: { messages: { ackReaction: "👀" } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "markdown",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_global_ackreaction",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);
      await vi.advanceTimersByTimeAsync(1200);

      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        1,
        "https://api.dingtalk.com/v1.0/robot/emotion/reply",
        expect.objectContaining({
          openMsgId: "m5_global_ackreaction",
          openConversationId: "cid_ok",
          emotionName: "👀",
          textEmotion: expect.objectContaining({
            emotionId: "2659900",
            emotionName: "👀",
            text: "👀",
          }),
        }),
        expect.any(Object),
      );

      // Test 2: Falls back to agent identity emoji when account channel and messages ackReaction are absent
      mockedAxiosPost.mockClear();
      await handleDingTalkMessage({
        cfg: {
          agents: {
            list: [
              {
                id: "main",
                identity: { emoji: "👀" },
              },
            ],
          },
        },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "markdown",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_identity_ackreaction",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);
      await vi.advanceTimersByTimeAsync(1200);

      expect(mockedAxiosPost).toHaveBeenCalledWith(
        "https://api.dingtalk.com/v1.0/robot/emotion/reply",
        expect.objectContaining({
          openMsgId: "m5_identity_ackreaction",
          openConversationId: "cid_ok",
          emotionName: "👀",
          textEmotion: expect.objectContaining({
            emotionId: "2659900",
            emotionName: "👀",
            text: "👀",
          }),
        }),
        expect.any(Object),
      );

      // Test 3: Falls back to default (👀) when config and agent identity ackReaction are absent
      mockedAxiosPost.mockClear();
      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "markdown",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_default_ackreaction",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);
      await vi.advanceTimersByTimeAsync(1200);

      expect(mockedAxiosPost).toHaveBeenCalledWith(
        "https://api.dingtalk.com/v1.0/robot/emotion/reply",
        expect.objectContaining({
          openMsgId: "m5_default_ackreaction",
          openConversationId: "cid_ok",
          emotionName: "👀",
        }),
        expect.any(Object),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches fixed thinking reaction when ackReaction is 'emoji'", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "你真棒，快夸夸我",
      messageType: "text",
    });
    try {
      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "markdown",
          ackReaction: "emoji",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_emoji_ackreaction",
          msgtype: "text",
          text: { content: "你真棒，快夸夸我" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);
      await vi.advanceTimersByTimeAsync(1200);

      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        1,
        "https://api.dingtalk.com/v1.0/robot/emotion/reply",
        expect.objectContaining({
          openMsgId: "m5_emoji_ackreaction",
          openConversationId: "cid_ok",
          emotionName: "🤔思考中",
          textEmotion: expect.objectContaining({
            emotionId: "2659900",
            emotionName: "🤔思考中",
            text: "🤔思考中",
          }),
        }),
        expect.any(Object),
      );
      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        2,
        "https://api.dingtalk.com/v1.0/robot/emotion/recall",
        expect.objectContaining({
          openMsgId: "m5_emoji_ackreaction",
          openConversationId: "cid_ok",
          emotionName: "🤔思考中",
        }),
        expect.any(Object),
      );
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("uses kaomoji for initial reaction and switches on tool events", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const runtime = buildRuntime();
    let agentEventListener: ((event: unknown) => void) | undefined;
    runtime.events = {
      onAgentEvent: vi.fn((listener: (event: unknown) => void) => {
        agentEventListener = listener;
        return () => {
          agentEventListener = undefined;
        };
      }),
    } as unknown as typeof runtime.events;
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        agentEventListener?.({
          stream: "lifecycle",
          data: {
            phase: "start",
            runId: "run_kaomoji",
          },
        });
        agentEventListener?.({
          stream: "tool",
          data: {
            phase: "start",
            name: "exec",
            args: { cmd: "pwd" },
            runId: "run_kaomoji",
            toolCallId: "tool_1",
          },
        });
        await replyOptions?.onReasoningStream?.({ text: "thinking" });
        await dispatcherOptions.deliver({ text: "final output" }, { kind: "final" });
        return { queuedFinal: "queued final" };
      });
    shared.getRuntimeMock.mockReturnValue(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "你真棒，快夸夸我",
      messageType: "text",
    });

    try {
      const handlePromise = handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "markdown",
          ackReaction: "kaomoji",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_kaomoji_ackreaction",
          msgtype: "text",
          text: { content: "你真棒，快夸夸我" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);
      await vi.advanceTimersByTimeAsync(1200);
      await handlePromise;

      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        1,
        "https://api.dingtalk.com/v1.0/robot/emotion/reply",
        expect.objectContaining({
          openMsgId: "m5_kaomoji_ackreaction",
          openConversationId: "cid_ok",
          emotionName: "叽 (๑•̀ㅂ•́)و✧",
          textEmotion: expect.objectContaining({
            emotionName: "叽 (๑•̀ㅂ•́)و✧",
            text: "叽 (๑•̀ㅂ•́)و✧",
          }),
        }),
        expect.any(Object),
      );
      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        2,
        "https://api.dingtalk.com/v1.0/robot/emotion/recall",
        expect.objectContaining({
          openMsgId: "m5_kaomoji_ackreaction",
          openConversationId: "cid_ok",
          emotionName: "叽 (๑•̀ㅂ•́)و✧",
        }),
        expect.any(Object),
      );
      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        3,
        "https://api.dingtalk.com/v1.0/robot/emotion/reply",
        expect.objectContaining({
          openMsgId: "m5_kaomoji_ackreaction",
          openConversationId: "cid_ok",
          emotionName: "🛠️",
          textEmotion: expect.objectContaining({
            emotionName: "🛠️",
            text: "🛠️",
          }),
        }),
        expect.any(Object),
      );
      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        4,
        "https://api.dingtalk.com/v1.0/robot/emotion/recall",
        expect.objectContaining({
          openMsgId: "m5_kaomoji_ackreaction",
          openConversationId: "cid_ok",
          emotionName: "🛠️",
        }),
        expect.any(Object),
      );
      expect(mockedAxiosPost).toHaveBeenCalledTimes(4);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps ackReaction tool progress independent from visible tool blocks", async () => {
    vi.useFakeTimers();

    const runtime = buildRuntime();
    let agentEventListener: ((event: unknown) => void) | undefined;
    runtime.events = {
      onAgentEvent: vi.fn((listener: (event: unknown) => void) => {
        agentEventListener = listener;
        return () => {
          agentEventListener = undefined;
        };
      }),
    } as unknown as typeof runtime.events;

    const card = { cardInstanceId: "card_tool_hidden", state: "1", lastUpdated: Date.now() } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        agentEventListener?.({
          stream: "lifecycle",
          data: {
            phase: "start",
            runId: "run_hidden_tool",
          },
        });
        agentEventListener?.({
          stream: "tool",
          data: {
            phase: "start",
            name: "exec",
            args: { cmd: "pwd" },
            runId: "run_hidden_tool",
            toolCallId: "tool_hidden",
          },
        });
        await dispatcherOptions.deliver({ text: "final answer only" }, { kind: "final" });
        return { queuedFinal: "final answer only" };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "hello",
      messageType: "text",
    });

    try {
      const handlePromise = handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "emoji",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_hidden_tool_ackreaction",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);
      await vi.advanceTimersByTimeAsync(1200);
      await handlePromise;

      expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
      const finalizeContent = shared.commitAICardBlocksMock.mock.calls[0][1]?.content;
      expect(finalizeContent).toContain("final answer only");
      expect(finalizeContent).not.toContain("🛠 工具");

      const reactionNames = mockedAxiosPost.mock.calls.map((call: unknown[]) => (call as unknown[])[1]?.emotionName);
      expect(reactionNames).toContain("🤔思考中");
      expect(reactionNames).toContain("🛠️");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send standalone thinking message when ackReaction is enabled", async () => {
    vi.useFakeTimers();
    try {
      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "markdown",
          ackReaction: "🤔思考中",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_reaction_prefer",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);
      await vi.advanceTimersByTimeAsync(1200);

      expect(mockedAxiosPost).toHaveBeenCalledTimes(2);
      const sentTexts = shared.sendMessageMock.mock.calls.map((call: unknown[]) =>
        String((call as unknown[])[2] ?? ""),
      );
      expect(sentTexts.some((text: string) => text.includes("思考中"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches native ack reaction in card mode and keeps it on fallback", async () => {
    vi.useFakeTimers();
    shared.createAICardMock.mockResolvedValueOnce(null);
    try {
      // Test 1: Native ack reaction in card mode
      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "🤔思考中",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_card_reaction",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);
      await vi.advanceTimersByTimeAsync(1200);

      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        1,
        "https://api.dingtalk.com/v1.0/robot/emotion/reply",
        expect.objectContaining({
          openMsgId: "m5_card_reaction",
          openConversationId: "cid_ok",
        }),
        expect.any(Object),
      );
      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        2,
        "https://api.dingtalk.com/v1.0/robot/emotion/recall",
        expect.objectContaining({
          openMsgId: "m5_card_reaction",
          openConversationId: "cid_ok",
          emotionName: "🤔思考中",
        }),
        expect.any(Object),
      );

      // Test 2: Keeps native ack reaction when configured card mode falls back
      mockedAxiosPost.mockClear();
      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "card",
          ackReaction: "🤔思考中",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_card_fallback_reaction",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);
      await vi.advanceTimersByTimeAsync(1200);

      expect(mockedAxiosPost).toHaveBeenCalledTimes(2);
      expect(shared.sendMessageMock).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues without fallback thinking message when native ack reaction attach fails", async () => {
    vi.useFakeTimers();
    mockedAxiosPost.mockRejectedValue(new Error("reaction failed"));

    try {
      const handlePromise = handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "markdown",
          ackReaction: "🤔思考中",
        } as unknown as DingTalkConfig,
        data: {
          msgId: "m5_reaction_fail",
          msgtype: "text",
          text: { content: "hello" },
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as unknown as Parameters<typeof handleDingTalkMessage>[0]["data"]);

      await vi.runAllTimersAsync();
      await expect(handlePromise).resolves.toBeUndefined();

      expect(mockedAxiosPost).toHaveBeenCalledTimes(3);
      expect(
        mockedAxiosPost.mock.calls.every((call) =>
          String(call[0] || "").includes("/robot/emotion/reply"),
        ),
      ).toBe(true);
      const sentTexts = shared.sendMessageMock.mock.calls.map((call: unknown[]) => String((call as unknown[])[2] ?? ""));
      expect(sentTexts.some((text: string) => text.includes("思考中"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});