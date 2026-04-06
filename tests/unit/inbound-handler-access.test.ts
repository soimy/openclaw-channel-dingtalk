import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig, DingTalkInboundMessage } from "../../src/types";

const shared = vi.hoisted(() => ({
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  isAbortRequestTextMock: vi.fn(),
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
  createAICard: vi.fn(),
  finishAICard: vi.fn(),
  commitAICardBlocks: vi.fn(),
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

describe("inbound-handler access control", () => {
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
    shared.getRuntimeMock.mockReturnValue(buildRuntime());
  });

  it("ignores self-message", async () => {
    await handleDingTalkMessage({
      cfg: {} as Record<string, unknown>,
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { clientId: "id", clientSecret: "sec", dmPolicy: "open" } as unknown as DingTalkConfig,
      data: {
        msgId: "m1",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid1",
        senderId: "bot_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      } as DingTalkInboundMessage,
    });

    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
  });

  it("dmPolicy allowlist blocks sender not in list", async () => {
    await handleDingTalkMessage({
      cfg: {} as Record<string, unknown>,
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        clientId: "id",
        clientSecret: "sec",
        dmPolicy: "allowlist",
        allowFrom: ["user_ok"],
      } as unknown as DingTalkConfig,
      data: {
        msgId: "m2",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid1",
        senderId: "user_blocked",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      } as DingTalkInboundMessage,
    });

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("访问受限");
  });

  it("groupPolicy allowlist blocks group not in allowFrom or groups", async () => {
    await handleDingTalkMessage({
      cfg: {} as Record<string, unknown>,
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        clientId: "id",
        clientSecret: "sec",
        groupPolicy: "allowlist",
        allowFrom: ["cid_allowed"],
      } as unknown as DingTalkConfig,
      data: {
        msgId: "m3",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "cid_blocked",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      } as DingTalkInboundMessage,
    });

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("访问受限");
  });

  it("groupPolicy disabled drops message silently", async () => {
    await handleDingTalkMessage({
      cfg: {} as Record<string, unknown>,
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        clientId: "id",
        clientSecret: "sec",
        groupPolicy: "disabled",
      } as unknown as DingTalkConfig,
      data: {
        msgId: "m_disabled",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "cid_any",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      } as DingTalkInboundMessage,
    });

    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
    expect(shared.sendMessageMock).not.toHaveBeenCalled();
  });

  it("allows group listed in groups config with allowlist policy", async () => {
    const rt = buildRuntime();
    shared.getRuntimeMock.mockReturnValue(rt);

    await handleDingTalkMessage({
      cfg: {} as Record<string, unknown>,
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        clientId: "id",
        clientSecret: "sec",
        groupPolicy: "allowlist",
        groups: { cid_allowed: {} },
      } as unknown as DingTalkConfig,
      data: {
        msgId: "m_group_ok",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "cid_allowed",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      } as DingTalkInboundMessage,
    });

    // Should not send deny message
    const denyCalls = shared.sendBySessionMock.mock.calls.filter(
      (call) => typeof call[2] === "string" && call[2].includes("访问受限"),
    );
    expect(denyCalls.length).toBe(0);
  });

  it("blocks sender not in groupAllowFrom even when groupPolicy is open", async () => {
    await handleDingTalkMessage({
      cfg: {} as Record<string, unknown>,
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        clientId: "id",
        clientSecret: "sec",
        groupPolicy: "open",
        groupAllowFrom: ["user_ok"],
      } as unknown as DingTalkConfig,
      data: {
        msgId: "m_sender_block",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "cid_any",
        senderId: "user_blocked",
        senderStaffId: "user_blocked",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      } as DingTalkInboundMessage,
    });

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("访问受限");
  });

  it("legacy allowFrom with groupId works as allowlist", async () => {
    const rt = buildRuntime();
    shared.getRuntimeMock.mockReturnValue(rt);

    await handleDingTalkMessage({
      cfg: {} as Record<string, unknown>,
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        clientId: "id",
        clientSecret: "sec",
        groupPolicy: "allowlist",
        allowFrom: ["cid_legacy"],
      } as unknown as DingTalkConfig,
      data: {
        msgId: "m_legacy",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "cid_legacy",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      } as DingTalkInboundMessage,
    });

    // Should NOT be blocked
    const denyCalls = shared.sendBySessionMock.mock.calls.filter(
      (call) => typeof call[2] === "string" && call[2].includes("访问受限"),
    );
    expect(denyCalls.length).toBe(0);
  });
});