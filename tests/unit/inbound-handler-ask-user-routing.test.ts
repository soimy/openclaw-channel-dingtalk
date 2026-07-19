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
  invalidateAskUserQuestionsForScopeMock: vi.fn().mockReturnValue([]),
  syncInvalidatedAskUserQuestionCardsMock: vi.fn().mockResolvedValue(undefined),
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
  syncInvalidatedAskUserQuestionCards: shared.syncInvalidatedAskUserQuestionCardsMock,
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
    shared.invalidateAskUserQuestionsForScopeMock.mockReset().mockReturnValue([]);
    shared.syncInvalidatedAskUserQuestionCardsMock.mockReset().mockResolvedValue(undefined);
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

  function inboundData(text: string) {
    return {
      msgId: `route_${text}`,
      msgtype: "text",
      text: { content: text },
      conversationType: "1",
      conversationId: "cid_ok",
      senderId: "user_1",
      chatbotUserId: "bot_1",
      sessionWebhook: "https://session.webhook",
      createAt: Date.now(),
    };
  }

  function routeConfig() {
    return {
      agents: {
        list: [
          { id: "expert", name: "Expert" },
          { id: "agent1", name: "Agent1" },
          { id: "agent2", name: "Agent2" },
        ],
      },
    };
  }

  it("invalidates a sub-agent content card on the final sub-agent session only", async () => {
    const runtime = buildRuntime();
    runtime.channel.routing.buildAgentSessionKey.mockImplementation(
      ({ agentId }: { agentId: string }) => `session-${agentId}`,
    );
    shared.getRuntimeMock.mockReturnValue(runtime);
    shared.extractMessageContentMock.mockReturnValue({
      text: "@Expert continue",
      messageType: "text",
      atMentions: [{ name: "Expert" }],
    });

    await handleDingTalkMessage({
      cfg: routeConfig(),
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as DingTalkConfig,
      data: inboundData("@Expert continue"),
    } as any);

    expect(shared.invalidateAskUserQuestionsForScopeMock).toHaveBeenCalledTimes(1);
    expect(shared.invalidateAskUserQuestionsForScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        questionScopeKey: "main:session-expert:user_1",
      }),
    );
    expect(shared.invalidateAskUserQuestionsForScopeMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        questionScopeKey: "main:s1:user_1",
      }),
    );
  });

  it("invalidates a targeted sub-agent command on the final sub-agent session only", async () => {
    const runtime = buildRuntime();
    runtime.channel.routing.buildAgentSessionKey.mockImplementation(
      ({ agentId }: { agentId: string }) => `session-${agentId}`,
    );
    shared.getRuntimeMock.mockReturnValue(runtime);
    shared.extractMessageContentMock.mockReturnValue({
      text: "@Expert /new",
      messageType: "text",
      atMentions: [{ name: "Expert" }],
    });

    await handleDingTalkMessage({
      cfg: routeConfig(),
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as DingTalkConfig,
      data: inboundData("@Expert /new"),
    } as any);

    expect(shared.invalidateAskUserQuestionsForScopeMock).toHaveBeenCalledTimes(1);
    expect(shared.invalidateAskUserQuestionsForScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        questionScopeKey: "main:session-expert:user_1",
      }),
    );
  });

  it("invalidates every matched sub-agent scope before the first dispatch", async () => {
    const order: string[] = [];
    const runtime = buildRuntime();
    runtime.channel.routing.buildAgentSessionKey.mockImplementation(
      ({ agentId }: { agentId: string }) => `session-${agentId}`,
    );
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        order.push("dispatch");
        await dispatcherOptions.deliver({ text: "reply" }, { kind: "final" });
        return { queuedFinal: "reply" };
      });
    shared.getRuntimeMock.mockReturnValue(runtime);
    shared.invalidateAskUserQuestionsForScopeMock.mockImplementation(
      ({ questionScopeKey }: { questionScopeKey: string }) => {
        order.push(`invalidate:${questionScopeKey}`);
        return [];
      },
    );
    shared.extractMessageContentMock.mockReturnValue({
      text: "@Agent1 @Agent2 continue",
      messageType: "text",
      atMentions: [{ name: "Agent1" }, { name: "Agent2" }],
    });

    await handleDingTalkMessage({
      cfg: routeConfig(),
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as DingTalkConfig,
      data: inboundData("@Agent1 @Agent2 continue"),
    } as any);

    expect(order).toEqual([
      "invalidate:main:session-agent1:user_1",
      "invalidate:main:session-agent2:user_1",
      "dispatch",
      "dispatch",
    ]);
  });

  it("does not invalidate a default scope when the host cannot build a sub-agent session", async () => {
    const runtime = buildRuntime();
    runtime.channel.routing.buildAgentSessionKey = undefined as any;
    shared.getRuntimeMock.mockReturnValue(runtime);
    shared.extractMessageContentMock.mockReturnValue({
      text: "@Expert continue",
      messageType: "text",
      atMentions: [{ name: "Expert" }],
    });

    await handleDingTalkMessage({
      cfg: routeConfig(),
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as DingTalkConfig,
      data: inboundData("@Expert continue"),
    } as any);

    expect(shared.invalidateAskUserQuestionsForScopeMock).not.toHaveBeenCalled();
    expect(shared.sendBySessionMock).toHaveBeenCalledWith(
      expect.anything(),
      "https://session.webhook",
      expect.stringContaining("不支持 DingTalk 子助手路由所需的 session helper"),
      expect.anything(),
    );
  });
});
