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
  recallAICardMessageMock: vi.fn(),
  dispatchDingTalkCardStopCommandMock: vi.fn(),
  isCardInTerminalStateMock: vi.fn(),
  updateAICardBlockListMock: vi.fn(),
  streamAICardMock: vi.fn(),
  formatContentForCardMock: vi.fn((s: string) => s),
  invalidateAskUserQuestionsForScopeMock: vi.fn().mockResolvedValue([]),
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
  recallAICardMessage: shared.recallAICardMessageMock,
  formatContentForCard: shared.formatContentForCardMock,
  isCardInTerminalState: shared.isCardInTerminalStateMock,
  streamAICard: shared.streamAICardMock,
  updateAICardBlockList: shared.updateAICardBlockListMock,
  streamAICardContent: vi.fn(),
  clearAICardStreamingContent: vi.fn(),
}));

vi.mock("../../src/command/card-stop-command", () => ({
  dispatchDingTalkCardStopCommand: shared.dispatchDingTalkCardStopCommandMock,
}));

vi.mock("../../src/card/ask-user-question", () => ({
  invalidateAskUserQuestionsForScope: shared.invalidateAskUserQuestionsForScopeMock,
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
import { getDingTalkQuestionContext } from "../../src/card/ask-user-question-context";
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
    shared.dispatchDingTalkCardStopCommandMock.mockReset();
    shared.dispatchDingTalkCardStopCommandMock.mockResolvedValue({ ok: true });
    shared.invalidateAskUserQuestionsForScopeMock.mockReset().mockResolvedValue([]);
    shared.recallAICardMessageMock.mockReset().mockImplementation(async (card: { state?: string }) => {
      card.state = "3";
      return true;
    });
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

  it("suppresses normal AI replies after a DingTalk question card successfully takes over the turn", async () => {
    const card = {
      cardInstanceId: "card_question_takeover",
      state: "1",
      lastUpdated: Date.now(),
    } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockImplementation((state: string) => state === "3" || state === "5");

    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(
      async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "intro before question" }, { kind: "tool" });
        await getDingTalkQuestionContext()?.onQuestionCardSent?.({
          questionId: "q_takeover",
          outTrackId: "ask_takeover",
        });
        await dispatcherOptions.deliver({ text: "do not send this final" }, { kind: "final" });
        return { queuedFinal: "do not send queued final" };
      },
    );
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "question_takeover",
        msgtype: "text",
        text: { content: "ask me" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.recallAICardMessageMock).toHaveBeenCalledTimes(1);
    expect(shared.dispatchDingTalkCardStopCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        agentId: "main",
        targetSessionKey: "s1",
        clickerUserId: "user_1",
      }),
    );
    expect(shared.commitAICardBlocksMock).not.toHaveBeenCalled();
    const markdownFallbackCalls = shared.sendMessageMock.mock.calls.filter(
      (call: unknown[]) => (call as unknown[])?.[3]?.forceMarkdown === true,
    );
    expect(markdownFallbackCalls).toHaveLength(0);
  });

  it("still suppresses normal AI replies when question card takeover cannot recall the existing AI card", async () => {
    const card = {
      cardInstanceId: "card_question_recall_failed",
      state: "1",
      lastUpdated: Date.now(),
    } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.recallAICardMessageMock.mockResolvedValueOnce(false);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(
      async ({ dispatcherOptions }) => {
        await getDingTalkQuestionContext()?.onQuestionCardSent?.({
          questionId: "q_recall_failed",
          outTrackId: "ask_recall_failed",
        });
        await dispatcherOptions.deliver({ text: "normal final after recall failed" }, { kind: "final" });
        return { queuedFinal: "normal queued final after recall failed" };
      },
    );
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "question_recall_failed",
        msgtype: "text",
        text: { content: "ask me" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.recallAICardMessageMock).toHaveBeenCalledTimes(1);
    expect(shared.dispatchDingTalkCardStopCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        agentId: "main",
        targetSessionKey: "s1",
        clickerUserId: "user_1",
      }),
    );
    expect(shared.commitAICardBlocksMock).not.toHaveBeenCalled();
  });

  it("still takes over when AI card recall throws after targeted pause succeeds", async () => {
    const card = {
      cardInstanceId: "card_question_recall_error",
      state: "1",
      lastUpdated: Date.now(),
    } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.recallAICardMessageMock.mockRejectedValueOnce(new Error("recall unavailable"));
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(
      async ({ dispatcherOptions }) => {
        const tookOver = await getDingTalkQuestionContext()?.onQuestionCardSent?.({
          questionId: "q_recall_error",
          outTrackId: "ask_recall_error",
        });
        expect(tookOver).toBe(true);
        await dispatcherOptions.deliver({ text: "do not send after recall error" }, { kind: "final" });
        return { queuedFinal: "do not send after recall error" };
      },
    );
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "question_recall_error",
        msgtype: "text",
        text: { content: "ask me" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.dispatchDingTalkCardStopCommandMock).toHaveBeenCalledTimes(1);
    expect(shared.commitAICardBlocksMock).not.toHaveBeenCalled();
  });

  it("keeps the normal AI reply path when a DingTalk question card is not sent successfully", async () => {
    const card = {
      cardInstanceId: "card_question_failed",
      state: "1",
      lastUpdated: Date.now(),
    } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(
      async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "question card send failed, continue normally" }, { kind: "tool" });
        await dispatcherOptions.deliver({ text: "normal fallback after failed question card" }, { kind: "final" });
        return { queuedFinal: "normal fallback after failed question card" };
      },
    );
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "question_failed",
        msgtype: "text",
        text: { content: "ask me" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.recallAICardMessageMock).not.toHaveBeenCalled();
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
    expect(shared.commitAICardBlocksMock.mock.calls[0][1]?.content).toContain(
      "normal fallback after failed question card",
    );
  });

  it("keeps the normal AI reply path when targeted pause fails after the question card is sent", async () => {
    const card = {
      cardInstanceId: "card_pause_failed",
      state: "1",
      lastUpdated: Date.now(),
    } as unknown as { cardInstanceId: string; state: string; lastUpdated: number };
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.dispatchDingTalkCardStopCommandMock.mockRejectedValueOnce(
      new Error("target session is not running"),
    );

    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(
      async ({ dispatcherOptions }) => {
        const tookOver = await getDingTalkQuestionContext()?.onQuestionCardSent?.({
          questionId: "q_pause_failed",
          outTrackId: "ask_pause_failed",
        });
        expect(tookOver).toBe(false);
        await dispatcherOptions.deliver(
          { text: "normal fallback after pause failure" },
          { kind: "final" },
        );
        return { queuedFinal: "normal fallback after pause failure" };
      },
    );
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as unknown as DingTalkConfig,
      data: {
        msgId: "question_pause_failed",
        msgtype: "text",
        text: { content: "ask me" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as unknown as { data: unknown; dingtalkConfig: unknown });

    expect(shared.recallAICardMessageMock).not.toHaveBeenCalled();
    expect(shared.commitAICardBlocksMock).toHaveBeenCalledTimes(1);
    expect(shared.commitAICardBlocksMock.mock.calls[0][1]?.content).toContain(
      "normal fallback after pause failure",
    );
  });


});

