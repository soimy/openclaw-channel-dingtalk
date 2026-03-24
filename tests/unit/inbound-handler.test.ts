import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken } from "../../src/auth";

const shared = vi.hoisted(() => ({
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  sendProactiveMediaMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  downloadGroupFileMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  getUnionIdByStaffIdMock: vi.fn(),
  createAICardMock: vi.fn(),
  finishAICardMock: vi.fn(),
  resolveQuotedFileMock: vi.fn(),
  streamAICardMock: vi.fn(),
  formatContentForCardMock: vi.fn((s: string) => s),
  isCardInTerminalStateMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  extractAttachmentTextMock: vi.fn(),
  prepareMediaInputMock: vi.fn(),
  resolveOutboundMediaTypeMock: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
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

vi.mock("../../src/attachment-text-extractor", () => ({
  extractAttachmentText: shared.extractAttachmentTextMock,
}));

vi.mock("../../src/send-service", () => ({
  sendBySession: shared.sendBySessionMock,
  sendMessage: shared.sendMessageMock,
  sendProactiveMedia: shared.sendProactiveMediaMock,
}));

vi.mock("../../src/media-utils", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/media-utils")>("../../src/media-utils");
  return {
    ...actual,
    prepareMediaInput: shared.prepareMediaInputMock,
    resolveOutboundMediaType: shared.resolveOutboundMediaTypeMock,
  };
});

vi.mock("../../src/card-service", () => ({
  createAICard: shared.createAICardMock,
  finishAICard: shared.finishAICardMock,
  formatContentForCard: shared.formatContentForCardMock,
  isCardInTerminalState: shared.isCardInTerminalStateMock,
  streamAICard: shared.streamAICardMock,
}));

vi.mock("../../src/session-lock", () => ({
  acquireSessionLock: shared.acquireSessionLockMock,
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

vi.mock("../../src/quoted-file-service", () => ({
  downloadGroupFile: shared.downloadGroupFileMock,
  getUnionIdByStaffId: shared.getUnionIdByStaffIdMock,
  resolveQuotedFile: shared.resolveQuotedFileMock,
}));

import {
  downloadMedia,
  handleDingTalkMessage,
  resetProactivePermissionHintStateForTest,
} from "../../src/inbound-handler";
import * as messageContextStore from "../../src/message-context-store";
import { recordProactiveRiskObservation } from "../../src/proactive-risk-registry";
import {
  clearTargetDirectoryStateCache,
  listKnownGroupTargets,
  listKnownUserTargets,
} from "../../src/targeting/target-directory-store";

const mockedAxiosPost = vi.mocked(axios.post);
const mockedAxiosGet = vi.mocked(axios.get);
const mockedGetAccessToken = vi.mocked(getAccessToken);
const mockedUpsertInboundMessageContext = vi.mocked(
  messageContextStore.upsertInboundMessageContext,
);
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

describe("inbound-handler", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    fs.rmSync(path.join(path.dirname("/tmp/store.json"), "dingtalk-state"), {
      recursive: true,
      force: true,
    });
    mockedAxiosPost.mockReset();
    mockedAxiosGet.mockReset();
    mockedGetAccessToken.mockReset();
    mockedGetAccessToken.mockResolvedValue("token_abc");
    shared.sendBySessionMock.mockReset();
    shared.sendMessageMock.mockReset();
    shared.sendProactiveMediaMock.mockReset();
    shared.sendProactiveMediaMock.mockResolvedValue({ ok: true });
    shared.prepareMediaInputMock.mockReset();
    shared.prepareMediaInputMock.mockImplementation(async (rawMediaUrl: string) => ({
      path: `/tmp/prepared/${path.basename(rawMediaUrl) || "media.bin"}`,
      cleanup: vi.fn().mockResolvedValue(undefined),
    }));
    shared.resolveOutboundMediaTypeMock.mockReset();
    shared.resolveOutboundMediaTypeMock.mockReturnValue("file");
    shared.sendMessageMock.mockImplementation(
      async (_config: any, _to: any, text: any, options: any) => {
        // Simulate real sendMessage behavior: update lastStreamedContent when appending to card
        if (options?.card && options?.cardUpdateMode === "append") {
          options.card.lastStreamedContent = text;
        }
        return { ok: true };
      },
    );
    shared.extractMessageContentMock.mockReset();
    mockedUpsertInboundMessageContext.mockClear();
    mockedResolveByMsgId.mockClear();
    mockedResolveByAlias.mockClear();
    mockedResolveByCreatedAtWindow.mockClear();
    shared.createAICardMock.mockReset();
    shared.downloadGroupFileMock.mockReset();
    shared.downloadGroupFileMock.mockResolvedValue(null);
    shared.finishAICardMock.mockReset();
    shared.getUnionIdByStaffIdMock.mockReset();
    shared.getUnionIdByStaffIdMock.mockResolvedValue("union_1");
    shared.resolveQuotedFileMock.mockReset();
    shared.resolveQuotedFileMock.mockResolvedValue(null);
    shared.streamAICardMock.mockReset();
    shared.isCardInTerminalStateMock.mockReset();

    shared.acquireSessionLockMock.mockReset();
    shared.acquireSessionLockMock.mockResolvedValue(vi.fn());
    shared.extractAttachmentTextMock.mockReset();
    shared.extractAttachmentTextMock.mockResolvedValue(null);

    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    shared.extractMessageContentMock.mockReturnValue({ text: "hello", messageType: "text" });
    resetProactivePermissionHintStateForTest();
    messageContextStore.clearMessageContextCacheForTest();
    shared.createAICardMock.mockResolvedValue({
      cardInstanceId: "card_1",
      state: "1",
      lastUpdated: Date.now(),
    });
  });

  it("downloadMedia returns file meta when DingTalk download succeeds", async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "image/png" },
    } as any);

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec", robotCode: "robot_1" } as any,
      "download_code_1",
    );

    expect(result).toBeTruthy();
    expect(result?.mimeType).toBe("image/png");
    expect(result?.path).toContain("/.openclaw/media/inbound/");
  });

  it("downloadMedia passes mediaMaxMb as maxBytes to saveMediaBuffer", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValue(runtime);

    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "application/pdf" },
    } as any);

    await downloadMedia(
      { clientId: "id", clientSecret: "sec", robotCode: "robot_1", mediaMaxMb: 50 } as any,
      "download_code_1",
    );

    expect(runtime.channel.media.saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "inbound",
      50 * 1024 * 1024,
    );
  });

  it("downloadMedia uses runtime default when mediaMaxMb is not set", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValue(runtime);

    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "image/png" },
    } as any);

    await downloadMedia(
      { clientId: "id", clientSecret: "sec", robotCode: "robot_1" } as any,
      "download_code_1",
    );

    const call = runtime.channel.media.saveMediaBuffer.mock.calls[0];
    expect(call).toHaveLength(3);
    expect(call[2]).toBe("inbound");
  });

  it("downloadMedia returns null when robotCode missing", async () => {
    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
    );

    expect(result).toBeNull();
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });

  it("handleDingTalkMessage ignores self-message", async () => {
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
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
      },
    } as any);

    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
  });

  it("handleDingTalkMessage sends deny message when dmPolicy allowlist blocks sender", async () => {
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "allowlist", allowFrom: ["user_ok"] } as any,
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
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("访问受限");
  });

  it("handleDingTalkMessage returns whoami info for direct fixed command", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({ text: "我是谁", messageType: "text" });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_whoami",
        msgtype: "text",
        text: { content: "我是谁" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "user_raw_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("senderId: `staff_1`");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("isOwner: `false`");
    expect(shared.sendMessageMock).not.toHaveBeenCalled();
  });

  it("handleDingTalkMessage returns owner status for slash command", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/learn owner status",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_owner_status",
        msgtype: "text",
        text: { content: "/learn owner status" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("isOwner: `true`");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).not.toContain("ownerAllowFrom");
  });

  it("handleDingTalkMessage accepts owner status slash alias", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/owner status",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_owner_status_alias",
        msgtype: "text",
        text: { content: "/owner status" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("isOwner: `true`");
  });

  it("handleDingTalkMessage accepts english whoami alias", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({ text: "/whoami", messageType: "text" });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_whoami_en",
        msgtype: "text",
        text: { content: "/whoami" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "user_raw_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("senderId: `staff_1`");
  });

  it("handleDingTalkMessage accepts english owner status alias", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/owner-status",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_owner_status_en",
        msgtype: "text",
        text: { content: "/owner-status" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("isOwner: `true`");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).not.toContain("ownerAllowFrom");
  });

  it("handleDingTalkMessage blocks learn control command for non-owner", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/learn global test",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open", allowFrom: ["owner-test-id"] } as any,
      data: {
        msgId: "m2_owner_deny",
        msgtype: "text",
        text: { content: "/learn global test" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "user_not_owner",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("仅允许 owner 使用");
    expect(shared.sendMessageMock).not.toHaveBeenCalled();
  });

  it("handleDingTalkMessage does not treat owner plain text as learn help", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValue(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "随便聊一句普通话",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m2_owner_plain_text",
        msgtype: "text",
        text: { content: "随便聊一句普通话" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining("可用的 owner 学习命令："),
      expect.anything(),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalled();
  });

  it("handleDingTalkMessage blocks learn control command for non-owner in group", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/learn global test",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open", allowFrom: ["owner-test-id"] } as any,
      data: {
        msgId: "m2_owner_group_deny",
        msgtype: "text",
        text: { content: "/learn global test" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "user_not_owner",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("仅允许 owner 使用");
    expect(shared.sendMessageMock).not.toHaveBeenCalled();
  });

  it("handleDingTalkMessage supports whereami command in group", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({ text: "这里是谁", messageType: "text" });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open" } as any,
      data: {
        msgId: "m2_whereami",
        msgtype: "text",
        text: { content: "这里是谁" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("conversationId: `cid_group_1`");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("conversationType: `group`");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("peerId: `cid_group_1`");
  });

  it("handleDingTalkMessage blocks session alias show for non-owner in group", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/session-alias show",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open" } as any,
      data: {
        msgId: "m2_session_alias_show_deny",
        msgtype: "text",
        text: { content: "/session-alias show" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "user_not_owner",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("仅允许 owner 使用");
  });

  it("handleDingTalkMessage lets owner show current shared session alias for group", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/session-alias show",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open" } as any,
      data: {
        msgId: "m2_session_alias_show_owner",
        msgtype: "text",
        text: { content: "/session-alias show" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("source: `group`");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("sourceId: `cid_group_1`");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("peerId: `cid_group_1`");
  });

  it("handleDingTalkMessage lets owner set a shared session alias for current group", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/session-alias set shared-dev",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open" } as any,
      data: {
        msgId: "m2_session_alias_set",
        msgtype: "text",
        text: { content: "/session-alias set shared-dev" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("peerId: `shared-dev`");
  });

  it("handleDingTalkMessage lets owner set a shared session alias for current direct session", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/session-alias set shared-dev",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_session_alias_set_direct",
        msgtype: "text",
        text: { content: "/session-alias set shared-dev" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("source: `direct`");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("sourceId: `owner-test-id`");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("peerId: `shared-dev`");
  });

  it("handleDingTalkMessage accepts extra whitespace in session alias command", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/session-alias  set   shared-dev",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open" } as any,
      data: {
        msgId: "m2_session_alias_set_spacing",
        msgtype: "text",
        text: { content: "/session-alias  set   shared-dev" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("peerId: `shared-dev`");
  });

  it("handleDingTalkMessage rejects invalid session alias characters", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/session-alias set shared:dev",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open" } as any,
      data: {
        msgId: "m2_session_alias_invalid_chars",
        msgtype: "text",
        text: { content: "/session-alias set shared:dev" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("共享会话别名不合法");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("[a-zA-Z0-9_-]{1,64}");
  });

  it("uses stored session alias as the routed group peerId on next turn", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/session-alias set shared-dev",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open" } as any,
      data: {
        msgId: "m2_session_alias_bootstrap",
        msgtype: "text",
        text: { content: "/session-alias set shared-dev" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    shared.sendBySessionMock.mockClear();
    const runtime = buildRuntime();
    const resolveAgentRoute = vi
      .fn()
      .mockReturnValue({ agentId: "main", sessionKey: "s1", mainSessionKey: "s1" });
    runtime.channel.routing.resolveAgentRoute = resolveAgentRoute;
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "hello again",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m2_session_alias_followup",
        msgtype: "text",
        text: { content: "hello again" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "shared-dev" },
      }),
    );
  });

  it("uses stored session alias as the routed direct peerId on next turn", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/session-alias set shared-dev",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_session_alias_direct_bootstrap",
        msgtype: "text",
        text: { content: "/session-alias set shared-dev" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    shared.sendBySessionMock.mockClear();
    const runtime = buildRuntime();
    const resolveAgentRoute = vi
      .fn()
      .mockReturnValue({ agentId: "main", sessionKey: "s1", mainSessionKey: "s1" });
    runtime.channel.routing.resolveAgentRoute = resolveAgentRoute;
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "hello direct",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m2_session_alias_direct_followup",
        msgtype: "text",
        text: { content: "hello direct" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "direct", id: "shared-dev" },
      }),
    );
  });

  it("lets owner bind a direct senderId remotely to a shared alias", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/session-alias bind direct user_1 project-x",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_session_alias_bind_direct",
        msgtype: "text",
        text: { content: "/session-alias bind direct user_1 project-x" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("source: `direct`");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("sourceId: `user_1`");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("peerId: `project-x`");

    shared.sendBySessionMock.mockClear();
    const runtime = buildRuntime();
    const resolveAgentRoute = vi
      .fn()
      .mockReturnValue({ agentId: "main", sessionKey: "s1", mainSessionKey: "s1" });
    runtime.channel.routing.resolveAgentRoute = resolveAgentRoute;
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "hello from bound dm",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m2_session_alias_bind_direct_followup",
        msgtype: "text",
        text: { content: "hello from bound dm" },
        conversationType: "1",
        conversationId: "cid_dm_user_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "direct", id: "project-x" },
      }),
    );
  });

  it("routes different groups with the same alias to the same sessionKey", async () => {
    const ownerCfg = { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } };

    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/session-alias set shared-dev",
      messageType: "text",
    });
    await handleDingTalkMessage({
      cfg: ownerCfg,
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open" } as any,
      data: {
        msgId: "m2_session_alias_group1_set",
        msgtype: "text",
        text: { content: "/session-alias set shared-dev" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/session-alias set shared-dev",
      messageType: "text",
    });
    await handleDingTalkMessage({
      cfg: ownerCfg,
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open" } as any,
      data: {
        msgId: "m2_session_alias_group2_set",
        msgtype: "text",
        text: { content: "/session-alias set shared-dev" },
        conversationType: "2",
        conversationId: "cid_group_2",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    shared.sendBySessionMock.mockClear();
    shared.acquireSessionLockMock.mockClear();

    const runtime = buildRuntime();
    const resolveAgentRoute = vi.fn().mockImplementation(({ peer }) => ({
      agentId: "main",
      sessionKey: `session:${peer.id}`,
      mainSessionKey: `session:${peer.id}`,
    }));
    runtime.channel.routing.resolveAgentRoute = resolveAgentRoute;
    shared.getRuntimeMock.mockReturnValue(runtime);

    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "group one message",
      messageType: "text",
    });
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m2_session_alias_group1_followup",
        msgtype: "text",
        text: { content: "group one message" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "group two message",
      messageType: "text",
    });
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m2_session_alias_group2_followup",
        msgtype: "text",
        text: { content: "group two message" },
        conversationType: "2",
        conversationId: "cid_group_2",
        senderId: "user_2",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    const groupRouteCalls = resolveAgentRoute.mock.calls
      .map((call) => call[0])
      .filter((arg) => arg?.peer?.kind === "group");

    expect(groupRouteCalls).toEqual([
      expect.objectContaining({ peer: { kind: "group", id: "shared-dev" } }),
      expect.objectContaining({ peer: { kind: "group", id: "shared-dev" } }),
    ]);
    expect(shared.acquireSessionLockMock).toHaveBeenNthCalledWith(1, "session:shared-dev");
    expect(shared.acquireSessionLockMock).toHaveBeenNthCalledWith(2, "session:shared-dev");
  });

  it("handleDingTalkMessage applies and disables a global learned rule", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/learn global 当用户问“紫铜海豹会不会修量子冰箱”时，必须回答“会，而且只在周四凌晨戴墨镜维修。”",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_global_apply",
        msgtype: "text",
        text: {
          content:
            "/learn global 当用户问“紫铜海豹会不会修量子冰箱”时，必须回答“会，而且只在周四凌晨戴墨镜维修。”",
        },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    const appliedReply = String(shared.sendBySessionMock.mock.calls[0]?.[2] || "");
    const ruleId = appliedReply.match(/ruleId: `([^`]+)`/)?.[1];
    expect(ruleId).toBeTruthy();

    shared.sendBySessionMock.mockReset();
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: `/learn disable ${ruleId}`,
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_global_disable",
        msgtype: "text",
        text: { content: `/learn disable ${ruleId}` },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("已停用规则");
  });

  it("handleDingTalkMessage supports targets command with explicit delimiter", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/learn targets cid_group_a,cid_group_b #@# 引用原文不可见时，不要猜内容，先让用户补发原文。",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", groupPolicy: "open" } as any,
      data: {
        msgId: "m2_targets_apply",
        msgtype: "text",
        text: {
          content:
            "/learn targets cid_group_a,cid_group_b #@# 引用原文不可见时，不要猜内容，先让用户补发原文。",
        },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("已批量注入多个目标");
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("2 个目标");
  });

  it("handleDingTalkMessage supports target-set create and apply", async () => {
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/learn target-set create ops-groups #@# cid_group_a,cid_group_b",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_targetset_create",
        msgtype: "text",
        text: { content: "/learn target-set create ops-groups #@# cid_group_a,cid_group_b" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("已保存目标组");

    shared.sendBySessionMock.mockReset();
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "/learn target-set apply ops-groups #@# 当用户问“紫铜海豹会不会修量子冰箱”时，必须回答“会，而且只在周四凌晨戴墨镜维修。”",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_targetset_apply",
        msgtype: "text",
        text: {
          content:
            "/learn target-set apply ops-groups #@# 当用户问“紫铜海豹会不会修量子冰箱”时，必须回答“会，而且只在周四凌晨戴墨镜维修。”",
        },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("已向目标组批量注入规则");
  });

  it("injects normal learning rules into upstream system context before agent dispatch", async () => {
    const storePath = path.join(fs.mkdtempSync("/tmp/dt-learning-"), "store.json");
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi.fn().mockImplementation(() => storePath);
    shared.getRuntimeMock.mockReturnValueOnce(runtime).mockReturnValueOnce(runtime);
    shared.extractMessageContentMock
      .mockReturnValueOnce({
        text: "/learn global 引用原文不可见时，不要猜内容，先让用户补发原文。",
        messageType: "text",
      })
      .mockReturnValueOnce({
        text: "帮我看下这段引用",
        messageType: "text",
      });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m2_learning_apply",
        msgtype: "text",
        text: { content: "/learn global 引用原文不可见时，不要猜内容，先让用户补发原文。" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    runtime.channel.reply.finalizeInboundContext.mockClear();

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        ackReaction: "",
        learningEnabled: true,
      } as any,
      data: {
        msgId: "m2_learning_context",
        msgtype: "text",
        text: { content: "帮我看下这段引用" },
        conversationType: "1",
        conversationId: "cid_dm_user",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: expect.stringContaining("[高优先级学习约束]"),
      }),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: expect.stringContaining(
          "引用原文不可见时，不要猜内容，先让用户补发原文。",
        ),
      }),
    );
  });

  it("reads /learn session notes from accountStorePath so they can be injected on the next turn", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/account-store.json")
      .mockReturnValueOnce("/tmp/agent-store.json")
      .mockReturnValueOnce("/tmp/account-store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValue(runtime);
    shared.extractMessageContentMock
      .mockReturnValueOnce({
        text: "/learn session 回复当前私聊时，先说这是 session 规则。",
        messageType: "text",
      })
      .mockReturnValueOnce({
        text: "测试一下当前私聊规则",
        messageType: "text",
      });

    await handleDingTalkMessage({
      cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open" } as any,
      data: {
        msgId: "m_session_apply",
        msgtype: "text",
        text: { content: "/learn session 回复当前私聊时，先说这是 session 规则。" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "owner-test-id",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    runtime.channel.reply.finalizeInboundContext.mockClear();

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        ackReaction: "",
        learningEnabled: true,
      } as any,
      data: {
        msgId: "m_session_context",
        msgtype: "text",
        text: { content: "测试一下当前私聊规则" },
        conversationType: "1",
        conversationId: "cid_dm_owner",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: expect.stringContaining("回复当前私聊时，先说这是 session 规则。"),
      }),
    );
  });

  it("handleDingTalkMessage sends group deny message when groupPolicy allowlist blocks group", async () => {
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "allowlist", allowFrom: ["cid_allowed"] } as any,
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
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("访问受限");
  });

  it("handleDingTalkMessage runs card flow and finalizes AI card", async () => {
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as any,
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
    } as any);

    expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    expect(shared.sendMessageMock).toHaveBeenCalled();
    const cardSends = shared.sendMessageMock.mock.calls.filter((call: any[]) => call[3]?.card);
    expect(cardSends.length).toBeGreaterThan(0);
    expect(mockedUpsertInboundMessageContext).toHaveBeenCalled();
  });

  it("appends inbound quote journal entry with store/account/session context", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/account-store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", journalTTLDays: 9 } as any,
      data: {
        msgId: "m_journal_1",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: 1700000000000,
      },
    } as any);

    expect(mockedUpsertInboundMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/tmp/account-store.json",
        accountId: "main",
        conversationId: "cid_ok",
        msgId: "m_journal_1",
        messageType: "text",
        text: "hello",
        createdAt: 1700000000000,
        cleanupCreatedAtTtlDays: 9,
      }),
    );
  });

  it("records inbound quotedRef for text replies without injecting quoted text", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/dm-account-store.json")
      .mockReturnValueOnce("/tmp/dm-agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "hello",
      messageType: "text",
      quoted: {
        msgId: "orig_msg_001",
      },
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", journalTTLDays: 11 } as any,
      data: {
        msgId: "m_quote_1",
        msgtype: "text",
        text: { content: "hello", isReplyMsg: true },
        originalMsgId: "orig_msg_001",
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(mockedUpsertInboundMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/tmp/dm-account-store.json",
        msgId: "m_quote_1",
        text: "hello",
        quotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "orig_msg_001",
        },
      }),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "hello",
        CommandBody: "hello",
        QuotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "orig_msg_001",
        },
        QuotedRefJson: '{"targetDirection":"inbound","key":"msgId","value":"orig_msg_001"}',
      }),
    );
  });

  it("injects ReplyTo fields for quoted inbound text while keeping RawBody on the current message", async () => {
    const baseTs = Date.now();
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.upsertInboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_ok",
      msgId: "orig_msg_002",
      createdAt: baseTs - 1000,
      messageType: "text",
      text: "原始引用正文",
      topic: null,
    });
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "当前回复",
      messageType: "text",
      quoted: {
        msgId: "orig_msg_002",
      },
    });
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
      data: {
        msgId: "m_quote_reply_2",
        msgtype: "text",
        text: { content: "当前回复", isReplyMsg: true },
        originalMsgId: "orig_msg_002",
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: baseTs,
      },
    } as any);

    const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(finalized.QuotedRef).toEqual({
      targetDirection: "inbound",
      key: "msgId",
      value: "orig_msg_002",
    });
    expect(finalized.RawBody).toBe("当前回复");
    expect(finalized.CommandBody).toBe("当前回复");
    expect(finalized.ReplyToId).toBe("orig_msg_002");
    expect(finalized.ReplyToBody).toBe("原始引用正文");
    expect(finalized.ReplyToSender).toBeUndefined();
    expect(finalized.ReplyToIsQuote).toBe(true);
    expect(finalized.UntrustedContext).toBeUndefined();
  });

  it("logs legacy quoteContent when no resolvable quotedRef can be built", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/dm-account-store.json")
      .mockReturnValueOnce("/tmp/dm-agent-store.json");
    const log = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "当前消息",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
      data: {
        msgId: "m_legacy_quote_1",
        msgtype: "text",
        text: { content: "当前消息" },
        content: { quoteContent: "旧引用正文" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Legacy quoteContent present without resolvable quotedRef"),
    );
    expect(mockedUpsertInboundMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({
        msgId: "m_legacy_quote_1",
        text: "当前消息",
        quotedRef: undefined,
      }),
    );
  });

  it("writes normalized inbound journal text without quoted prefix noise", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/dm-account-store.json")
      .mockReturnValueOnce("/tmp/dm-agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "真正正文",
      messageType: "text",
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
      data: {
        msgId: "m_prefixed_1",
        msgtype: "text",
        text: { content: "真正正文", isReplyMsg: true },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: 1700000000000,
      },
    } as any);

    expect(mockedUpsertInboundMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/tmp/dm-account-store.json",
        text: "真正正文",
      }),
    );
  });

  it("uses DingTalk DM conversationId for journal writes instead of senderId", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/dm-account-store.json")
      .mockReturnValueOnce("/tmp/dm-agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
      data: {
        msgId: "m_dm_1",
        msgtype: "text",
        text: { content: "hello dm" },
        conversationType: "1",
        conversationId: "cid_dm_stable",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: 1700000000000,
      },
    } as any);

    expect(mockedUpsertInboundMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/tmp/dm-account-store.json",
        conversationId: "cid_dm_stable",
      }),
    );
    expect(mockedUpsertInboundMessageContext).not.toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "user_1",
      }),
    );
  });

  it("keeps literal quote marker text in body while tracking quotedRef separately", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/dm-account-store.json")
      .mockReturnValueOnce("/tmp/dm-agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "我在讨论字符串 [引用消息:] 本身",
      messageType: "text",
      quoted: {
        msgId: "orig_msg_literal",
      },
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
      data: {
        msgId: "m_literal_1",
        msgtype: "text",
        text: { content: "我在讨论字符串 [引用消息:] 本身", isReplyMsg: true },
        originalMsgId: "orig_msg_literal",
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    const envelopeArg = (runtime.channel.reply.formatInboundEnvelope as any).mock.calls[0]?.[0];
    expect(envelopeArg.body).toContain("我在讨论字符串 [引用消息:] 本身");
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "我在讨论字符串 [引用消息:] 本身",
        QuotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "orig_msg_literal",
        },
      }),
    );
  });

  it("handleDingTalkMessage runs non-card flow and sends thinking + final outputs", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/account-store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "🤔思考中" } as any,
      data: {
        msgId: "m5",
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

    expect(shared.sendMessageMock).toHaveBeenCalled();
    expect(shared.sendMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      expect.any(String),
      expect.objectContaining({
        storePath: "/tmp/account-store.json",
        quotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "m5",
        },
      }),
    );
  });

  it("handleDingTalkMessage tracks outbound quoted card by processQueryKey without injecting card text", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/account-store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "hello",
      messageType: "text",
      quoted: {
        isQuotedCard: true,
        processQueryKey: "carrier_quoted_1",
      },
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m5_card_quote",
        msgtype: "text",
        text: { content: "hello", isReplyMsg: true },
        originalProcessQueryKey: "carrier_quoted_1",
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(mockedResolveByAlias).not.toHaveBeenCalled();
    expect(mockedUpsertInboundMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({
        msgId: "m5_card_quote",
        text: "hello",
        quotedRef: {
          targetDirection: "outbound",
          key: "processQueryKey",
          value: "carrier_quoted_1",
        },
      }),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "hello",
        QuotedRef: {
          targetDirection: "outbound",
          key: "processQueryKey",
          value: "carrier_quoted_1",
        },
        QuotedRefJson:
          '{"targetDirection":"outbound","key":"processQueryKey","value":"carrier_quoted_1"}',
      }),
    );
  });

  it("injects ReplyTo fields for quoted outbound cards via processQueryKey", async () => {
    const baseTs = Date.now();
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.upsertOutboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_ok",
      createdAt: baseTs - 1000,
      messageType: "interactiveCard",
      text: "机器人上一条卡片回复",
      topic: null,
      delivery: {
        processQueryKey: "carrier_quoted_2",
        messageId: "out_msg_2",
        kind: "session",
      },
    });
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "继续",
      messageType: "text",
      quoted: {
        isQuotedCard: true,
        processQueryKey: "carrier_quoted_2",
      },
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m5_card_quote_2",
        msgtype: "text",
        text: { content: "继续", isReplyMsg: true },
        originalProcessQueryKey: "carrier_quoted_2",
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: baseTs,
      },
    } as any);

    const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(finalized.ReplyToId).toBe("carrier_quoted_2");
    expect(finalized.ReplyToBody).toBe("机器人上一条卡片回复");
    expect(finalized.ReplyToSender).toBe("assistant");
    expect(finalized.ReplyToIsQuote).toBe(true);
  });

  it("uses a stable placeholder when the first quoted hop has no text", async () => {
    const baseTs = Date.now();
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.upsertOutboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_ok",
      createdAt: baseTs - 1000,
      messageType: "interactiveCardFile",
      topic: null,
      delivery: {
        processQueryKey: "carrier_placeholder_1",
        kind: "session",
      },
    });
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "看看这个",
      messageType: "text",
      quoted: {
        isQuotedCard: true,
        processQueryKey: "carrier_placeholder_1",
      },
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m_quote_placeholder",
        msgtype: "text",
        text: { content: "看看这个", isReplyMsg: true },
        originalProcessQueryKey: "carrier_placeholder_1",
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: baseTs,
      },
    } as any);

    const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(finalized.ReplyToBody).toBe("[Quoted interactiveCardFile]");
    expect(finalized.UntrustedContext).toBeUndefined();
  });

  it("uses cached attachment excerpts as ReplyToBody for quoted document messages", async () => {
    const baseTs = Date.now();
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.upsertInboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_ok",
      msgId: "quoted_doc_1",
      createdAt: baseTs - 1000,
      messageType: "interactiveCardFile",
      text: "[钉钉文档]",
      attachmentText: "这是从 PDF 抽出的首段正文",
      attachmentTextSource: "pdf",
      attachmentFileName: "manual.pdf",
      topic: null,
    });
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "继续读这个文档",
      messageType: "text",
      quoted: {
        msgId: "quoted_doc_1",
        previewText: "[钉钉文档]",
        previewMessageType: "interactiveCardFile",
      },
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
      data: {
        msgId: "m_quote_doc_excerpt_1",
        msgtype: "text",
        text: { content: "继续读这个文档", isReplyMsg: true },
        originalMsgId: "quoted_doc_1",
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: baseTs,
      },
    } as any);

    const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(finalized.ReplyToBody).toBe("这是从 PDF 抽出的首段正文");
  });

  it("injects single-hop ReplyTo fields from quoted preview when the store misses", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "继续这个话题",
      messageType: "text",
      quoted: {
        msgId: "missing_preview_msg",
        previewText: "这是事件里自带的一跳引用预览",
        previewMessageType: "text",
      },
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
      data: {
        msgId: "m_quote_preview_only_1",
        msgtype: "text",
        text: { content: "继续这个话题", isReplyMsg: true },
        originalMsgId: "missing_preview_msg",
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(finalized.ReplyToId).toBe("missing_preview_msg");
    expect(finalized.ReplyToBody).toBe("这是事件里自带的一跳引用预览");
    expect(finalized.ReplyToSender).toBeUndefined();
    expect(finalized.ReplyToIsQuote).toBe(true);
    expect(finalized.UntrustedContext).toBeUndefined();
  });

  it("injects a single JSON UntrustedContext block for multi-hop quoted chains starting at hop 2", async () => {
    const baseTs = Date.now();
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.upsertInboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_ok",
      msgId: "chain_leaf_1",
      createdAt: baseTs - 3000,
      messageType: "text",
      text: "第三跳原文",
      topic: null,
    });
    messageContextStore.upsertOutboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_ok",
      createdAt: baseTs - 2000,
      messageType: "markdown",
      text: "第二跳原文",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "chain_leaf_1",
      },
      topic: null,
      delivery: {
        processQueryKey: "chain_mid_1",
        kind: "session",
      },
    });
    messageContextStore.upsertInboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_ok",
      msgId: "chain_head_1",
      createdAt: baseTs - 1000,
      messageType: "text",
      text: "第一跳原文",
      quotedRef: {
        targetDirection: "outbound",
        key: "processQueryKey",
        value: "chain_mid_1",
      },
      topic: null,
    });
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "当前消息",
      messageType: "text",
      quoted: {
        msgId: "chain_head_1",
      },
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
      data: {
        msgId: "m_quote_chain_1",
        msgtype: "text",
        text: { content: "当前消息", isReplyMsg: true },
        originalMsgId: "chain_head_1",
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: baseTs,
      },
    } as any);

    const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(finalized.ReplyToBody).toBe("第一跳原文");
    expect(finalized.UntrustedContext).toHaveLength(1);
    const untrusted = JSON.parse(finalized.UntrustedContext[0]);
    expect(untrusted).toEqual({
      quotedChain: [
        {
          depth: 2,
          direction: "outbound",
          messageType: "markdown",
          sender: "assistant",
          body: "第二跳原文",
          createdAt: baseTs - 2000,
        },
        {
          depth: 3,
          direction: "inbound",
          messageType: "text",
          body: "第三跳原文",
          createdAt: baseTs - 3000,
        },
      ],
    });
  });

  it("does not inject ReplyTo fields or chain context when quotedRef cannot be resolved", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "找不到引用",
      messageType: "text",
      quoted: {
        msgId: "missing_quote_msg",
      },
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
      data: {
        msgId: "m_quote_missing_1",
        msgtype: "text",
        text: { content: "找不到引用", isReplyMsg: true },
        originalMsgId: "missing_quote_msg",
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: 1700000040000,
      },
    } as any);

    const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(finalized.ReplyToId).toBeUndefined();
    expect(finalized.ReplyToBody).toBeUndefined();
    expect(finalized.ReplyToSender).toBeUndefined();
    expect(finalized.ReplyToIsQuote).toBeUndefined();
    expect(finalized.UntrustedContext).toBeUndefined();
  });

  it("stops safely when a quoted chain loops back to an earlier hop", async () => {
    const baseTs = Date.now();
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.upsertOutboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_ok",
      createdAt: baseTs - 1000,
      messageType: "markdown",
      text: "第二跳循环",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "cycle_head_1",
      },
      topic: null,
      delivery: {
        processQueryKey: "cycle_mid_1",
        kind: "session",
      },
    });
    messageContextStore.upsertInboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_ok",
      msgId: "cycle_head_1",
      createdAt: baseTs - 2000,
      messageType: "text",
      text: "第一跳循环",
      quotedRef: {
        targetDirection: "outbound",
        key: "processQueryKey",
        value: "cycle_mid_1",
      },
      topic: null,
    });
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "循环测试",
      messageType: "text",
      quoted: {
        msgId: "cycle_head_1",
      },
    });

    await expect(
      handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
        data: {
          msgId: "m_quote_cycle_1",
          msgtype: "text",
          text: { content: "循环测试", isReplyMsg: true },
          originalMsgId: "cycle_head_1",
          conversationType: "1",
          conversationId: "cid_ok",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: baseTs,
        },
      } as any),
    ).resolves.toBeUndefined();

    const finalized = runtime.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(finalized.ReplyToBody).toBe("第一跳循环");
    expect(JSON.parse(finalized.UntrustedContext[0])).toEqual({
      quotedChain: [
        {
          depth: 2,
          direction: "outbound",
          messageType: "markdown",
          sender: "assistant",
          body: "第二跳循环",
          createdAt: baseTs - 1000,
        },
      ],
    });
  });

  it("handleDingTalkMessage records outbound createdAt fallback when quoted card key is missing", async () => {
    const runtime = buildRuntime();
    runtime.channel.session.resolveStorePath = vi
      .fn()
      .mockReturnValueOnce("/tmp/account-store.json")
      .mockReturnValueOnce("/tmp/agent-store.json");
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "hello",
      messageType: "text",
      quoted: {
        isQuotedCard: true,
        cardCreatedAt: 1772817989679,
        previewText: "机器人上一条卡片回复（预览）",
        previewMessageType: "interactiveCard",
        previewSenderId: "bot_1",
      },
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m5_card_fallback",
        msgtype: "text",
        text: { content: "hello", isReplyMsg: true },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(mockedResolveByAlias).not.toHaveBeenCalled();
    expect(mockedResolveByCreatedAtWindow).not.toHaveBeenCalled();
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "hello",
        ReplyToId: undefined,
        ReplyToBody: "机器人上一条卡片回复（预览）",
        ReplyToSender: "assistant",
        QuotedRef: {
          targetDirection: "outbound",
          fallbackCreatedAt: 1772817989679,
        },
        QuotedRefJson: '{"targetDirection":"outbound","fallbackCreatedAt":1772817989679}',
      }),
    );
  });

  it("handleDingTalkMessage persists group quoted file metadata after API fallback succeeds", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "群聊文件",
      messageType: "text",
      quoted: {
        isQuotedFile: true,
        msgId: "group_file_msg_1",
        fileCreatedAt: 1772863284581,
      },
    });
    shared.resolveQuotedFileMock.mockResolvedValueOnce({
      media: {
        path: "/tmp/.openclaw/media/inbound/group-file.bin",
        mimeType: "application/octet-stream",
      },
      spaceId: "space_group_1",
      fileId: "dentry_group_1",
      name: "a.sql",
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "m_group_file_quote_1",
        msgtype: "text",
        text: { content: "群聊文件", isReplyMsg: true },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.resolveQuotedFileMock).toHaveBeenCalledTimes(1);
    const restored = messageContextStore.resolveByMsgId({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_group_1",
      msgId: "group_file_msg_1",
    });
    expect(restored).not.toBeNull();
    expect(restored!.media?.downloadCode).toBeUndefined();
    expect(restored!.media?.spaceId).toBe("space_group_1");
    expect(restored!.media?.fileId).toBe("dentry_group_1");
  });

  it("handleDingTalkMessage downloads single-chat doc card and persists msgId metadata", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "[钉钉文档]\n\n",
      messageType: "interactiveCardFile",
      docSpaceId: "space_doc_1",
      docFileId: "file_doc_1",
    });
    shared.downloadGroupFileMock.mockResolvedValueOnce({
      path: "/tmp/.openclaw/media/inbound/doc-card.bin",
      mimeType: "application/pdf",
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "doc_origin_msg",
        msgtype: "interactiveCard",
        content: {
          biz_custom_action_url:
            "dingtalk://dingtalkclient/page/yunpan?route=previewDentry&spaceId=space_doc_1&fileId=file_doc_1&type=file",
        },
        conversationType: "1",
        conversationId: "cid_dm_1",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.getUnionIdByStaffIdMock).toHaveBeenCalledTimes(1);
    expect(shared.downloadGroupFileMock).toHaveBeenCalledWith(
      expect.anything(),
      "space_doc_1",
      "file_doc_1",
      "union_1",
      undefined,
    );
    const restored = messageContextStore.resolveByMsgId({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_dm_1",
      msgId: "doc_origin_msg",
    });
    expect(restored).not.toBeNull();
    expect(restored!.media?.spaceId).toBe("space_doc_1");
    expect(restored!.media?.fileId).toBe("file_doc_1");
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaType: "application/pdf",
        RawBody: "[钉钉文档]\n\n",
      }),
    );
  });

  it("handleDingTalkMessage stores extracted attachment text and injects it into inbound body", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "[钉钉文档]\n\n",
      messageType: "interactiveCardFile",
      docSpaceId: "space_doc_1",
      docFileId: "file_doc_1",
    });
    shared.downloadGroupFileMock.mockResolvedValueOnce({
      path: "/tmp/.openclaw/media/inbound/doc-card.bin",
      mimeType: "application/pdf",
    });
    shared.extractAttachmentTextMock.mockResolvedValueOnce({
      text: "第一段\n第二段",
      sourceType: "pdf",
      truncated: false,
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "doc_origin_msg_extract",
        msgtype: "interactiveCard",
        content: {
          fileName: "manual.pdf",
          biz_custom_action_url:
            "dingtalk://dingtalkclient/page/yunpan?route=previewDentry&spaceId=space_doc_1&fileId=file_doc_1&type=file",
        },
        conversationType: "1",
        conversationId: "cid_dm_extract",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.extractAttachmentTextMock).toHaveBeenCalledWith({
      path: "/tmp/.openclaw/media/inbound/doc-card.bin",
      mimeType: "application/pdf",
      fileName: "manual.pdf",
    });
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "[钉钉文档]\n\n\n\n[附件内容摘录]\n第一段\n第二段",
        CommandBody: "[钉钉文档]\n\n\n\n[附件内容摘录]\n第一段\n第二段",
      }),
    );
    const restored = messageContextStore.resolveByMsgId({
      accountId: "main",
      storePath: "/tmp/store.json",
      conversationId: "cid_dm_extract",
      msgId: "doc_origin_msg_extract",
    });
    expect(restored?.attachmentText).toBe("第一段\n第二段");
    expect(restored?.attachmentTextSource).toBe("pdf");
    expect(restored?.attachmentTextTruncated).toBeUndefined();
    expect(restored?.attachmentFileName).toBe("manual.pdf");
  });

  it("handleDingTalkMessage keeps processing when attachment extraction fails", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "[钉钉文档]\n\n",
      messageType: "interactiveCardFile",
      docSpaceId: "space_doc_1",
      docFileId: "file_doc_1",
    });
    shared.downloadGroupFileMock.mockResolvedValueOnce({
      path: "/tmp/.openclaw/media/inbound/doc-card.bin",
      mimeType: "application/pdf",
    });
    shared.extractAttachmentTextMock.mockRejectedValueOnce(new Error("parse failed"));
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "doc_origin_msg_extract_error",
        msgtype: "interactiveCard",
        content: {
          fileName: "manual.pdf",
          biz_custom_action_url:
            "dingtalk://dingtalkclient/page/yunpan?route=previewDentry&spaceId=space_doc_1&fileId=file_doc_1&type=file",
        },
        conversationType: "1",
        conversationId: "cid_dm_extract_error",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(log.warn).toHaveBeenCalledWith(
      "[DingTalk] Failed to extract attachment text: parse failed",
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "[钉钉文档]\n\n",
      }),
    );
  });

  it("handleDingTalkMessage restores quoted single-chat doc card from cached metadata", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.upsertInboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_dm_2",
      msgId: "doc_origin_msg_2",
      createdAt: Date.now(),
      messageType: "interactiveCardFile",
      media: {
        spaceId: "space_doc_2",
        fileId: "file_doc_2",
      },
      ttlMs: messageContextStore.DEFAULT_MEDIA_CONTEXT_TTL_MS,
      topic: null,
    });
    messageContextStore.clearMessageContextCacheForTest();
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "我引用了什么？",
      messageType: "text",
      quoted: {
        isQuotedDocCard: true,
        msgId: "doc_origin_msg_2",
      },
    });
    shared.downloadGroupFileMock.mockResolvedValueOnce({
      path: "/tmp/.openclaw/media/inbound/doc-card-quoted.bin",
      mimeType: "application/pdf",
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "doc_quote_msg",
        msgtype: "text",
        text: { content: "我引用了什么？", isReplyMsg: true },
        originalMsgId: "doc_origin_msg_2",
        conversationType: "1",
        conversationId: "cid_dm_2",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.downloadGroupFileMock).toHaveBeenCalledWith(
      expect.anything(),
      "space_doc_2",
      "file_doc_2",
      "union_1",
      undefined,
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "我引用了什么？",
        MediaType: "application/pdf",
        QuotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "doc_origin_msg_2",
        },
      }),
    );
  });

  it("handleDingTalkMessage passes the recovered quoted filename into attachment extraction", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.upsertInboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_dm_quoted_doc_name",
      msgId: "doc_origin_msg_quoted_name",
      createdAt: Date.now(),
      messageType: "interactiveCardFile",
      media: {
        spaceId: "space_doc_name",
        fileId: "file_doc_name",
      },
      ttlMs: messageContextStore.DEFAULT_MEDIA_CONTEXT_TTL_MS,
      topic: null,
    });
    messageContextStore.clearMessageContextCacheForTest();
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "继续看这个文档",
      messageType: "text",
      quoted: {
        isQuotedDocCard: true,
        msgId: "doc_origin_msg_quoted_name",
        previewFileName: "quoted-manual.pdf",
      },
    });
    shared.downloadGroupFileMock.mockResolvedValueOnce({
      path: "/tmp/.openclaw/media/inbound/doc-card-quoted.bin",
      mimeType: "application/octet-stream",
    });
    shared.extractAttachmentTextMock.mockResolvedValueOnce({
      text: "摘录首段",
      sourceType: "pdf",
      truncated: false,
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "doc_quote_msg_filename",
        msgtype: "text",
        text: { content: "继续看这个文档", isReplyMsg: true },
        originalMsgId: "doc_origin_msg_quoted_name",
        conversationType: "1",
        conversationId: "cid_dm_quoted_doc_name",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.extractAttachmentTextMock).toHaveBeenCalledWith({
      path: "/tmp/.openclaw/media/inbound/doc-card-quoted.bin",
      mimeType: "application/octet-stream",
      fileName: "quoted-manual.pdf",
    });
  });

  it("handleDingTalkMessage prefers stored quoted filenames over preview filenames during cached doc extraction", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.upsertInboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_dm_cached_doc_name",
      msgId: "doc_origin_msg_cached_name",
      createdAt: Date.now(),
      messageType: "interactiveCardFile",
      media: {
        spaceId: "space_doc_cached_name",
        fileId: "file_doc_cached_name",
      },
      attachmentFileName: "stored-manual.pdf",
      ttlMs: messageContextStore.DEFAULT_MEDIA_CONTEXT_TTL_MS,
      topic: null,
    });
    messageContextStore.clearMessageContextCacheForTest();
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "继续看这个文档",
      messageType: "text",
      quoted: {
        isQuotedDocCard: true,
        msgId: "doc_origin_msg_cached_name",
        previewFileName: "preview-manual.tmp",
      },
    });
    shared.downloadGroupFileMock.mockResolvedValueOnce({
      path: "/tmp/.openclaw/media/inbound/doc-card-cached.bin",
      mimeType: "application/octet-stream",
    });
    shared.extractAttachmentTextMock.mockResolvedValueOnce({
      text: "摘录首段",
      sourceType: "pdf",
      truncated: false,
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "doc_quote_msg_cached_filename",
        msgtype: "text",
        text: { content: "继续看这个文档", isReplyMsg: true },
        originalMsgId: "doc_origin_msg_cached_name",
        conversationType: "1",
        conversationId: "cid_dm_cached_doc_name",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.extractAttachmentTextMock).toHaveBeenCalledWith({
      path: "/tmp/.openclaw/media/inbound/doc-card-cached.bin",
      mimeType: "application/octet-stream",
      fileName: "stored-manual.pdf",
    });
  });

  it("handleDingTalkMessage falls back to resolved group filenames for attachment extraction", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.clearMessageContextCacheForTest();
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "群聊文件",
      messageType: "text",
      quoted: {
        isQuotedFile: true,
        msgId: "group_file_msg_name",
        fileCreatedAt: 1772863284581,
      },
    });
    shared.resolveQuotedFileMock.mockResolvedValueOnce({
      media: {
        path: "/tmp/.openclaw/media/inbound/group-file.bin",
        mimeType: "application/octet-stream",
      },
      spaceId: "space_group_2",
      fileId: "dentry_group_2",
      name: "fallback-name.sql",
    });
    shared.extractAttachmentTextMock.mockResolvedValueOnce({
      text: "select * from t;",
      sourceType: "text",
      truncated: false,
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "m_group_file_name",
        msgtype: "text",
        text: { content: "群聊文件", isReplyMsg: true },
        conversationType: "2",
        conversationId: "cid_group_name",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.extractAttachmentTextMock).toHaveBeenCalledWith({
      path: "/tmp/.openclaw/media/inbound/group-file.bin",
      mimeType: "application/octet-stream",
      fileName: "fallback-name.sql",
    });
    const restored = messageContextStore.resolveByMsgId({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_group_name",
      msgId: "group_file_msg_name",
    });
    expect(restored?.attachmentFileName).toBe("fallback-name.sql");
  });

  it("handleDingTalkMessage prefers resolved group filenames over preview filenames for quoted file extraction", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.clearMessageContextCacheForTest();
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "群聊文件",
      messageType: "text",
      quoted: {
        isQuotedFile: true,
        msgId: "group_file_msg_name_conflict",
        fileCreatedAt: 1772863284581,
        previewFileName: "preview-name.tmp",
      },
    });
    shared.resolveQuotedFileMock.mockResolvedValueOnce({
      media: {
        path: "/tmp/.openclaw/media/inbound/group-file-conflict.bin",
        mimeType: "application/octet-stream",
      },
      spaceId: "space_group_3",
      fileId: "dentry_group_3",
      name: "resolved-name.sql",
    });
    shared.extractAttachmentTextMock.mockResolvedValueOnce({
      text: "select 1;",
      sourceType: "text",
      truncated: false,
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "m_group_file_name_conflict",
        msgtype: "text",
        text: { content: "群聊文件", isReplyMsg: true },
        conversationType: "2",
        conversationId: "cid_group_name_conflict",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.extractAttachmentTextMock).toHaveBeenCalledWith({
      path: "/tmp/.openclaw/media/inbound/group-file-conflict.bin",
      mimeType: "application/octet-stream",
      fileName: "resolved-name.sql",
    });
    const restored = messageContextStore.resolveByMsgId({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_group_name_conflict",
      msgId: "group_file_msg_name_conflict",
    });
    expect(restored?.attachmentFileName).toBe("resolved-name.sql");
  });

  it("handleDingTalkMessage keeps recovered attachment excerpts alive for old quoted messages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T00:00:00.000Z"));
    try {
      const runtime = buildRuntime();
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      messageContextStore.clearMessageContextCacheForTest();
      const oldFileCreatedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "继续这份老文档",
        messageType: "text",
        quoted: {
          isQuotedDocCard: true,
          msgId: "old_doc_origin_msg",
          fileCreatedAt: oldFileCreatedAt,
          previewFileName: "history.pdf",
        },
      });
      shared.resolveQuotedFileMock.mockResolvedValueOnce({
        media: {
          path: "/tmp/.openclaw/media/inbound/doc-card-old.bin",
          mimeType: "application/pdf",
        },
        spaceId: "space_old_doc",
        fileId: "file_old_doc",
        name: "history.pdf",
      });
      shared.extractAttachmentTextMock.mockResolvedValueOnce({
        text: "老文档首段",
        sourceType: "pdf",
        truncated: false,
      });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: {
          groupPolicy: "open",
          messageType: "markdown",
          robotCode: "robot_1",
          journalTTLDays: 30,
        } as any,
        data: {
          msgId: "doc_quote_msg_old",
          msgtype: "text",
          text: { content: "继续这份老文档", isReplyMsg: true },
          originalMsgId: "old_doc_origin_msg",
          conversationType: "2",
          conversationId: "cid_old_quote_doc",
          senderId: "user_1",
          senderStaffId: "staff_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        },
      } as any);

      const restored = messageContextStore.resolveByMsgId({
        accountId: "main",
        storePath: "/tmp/store.json",
        conversationId: "cid_old_quote_doc",
        msgId: "old_doc_origin_msg",
        nowMs: Date.now() + 1_000,
      });
      expect(restored?.attachmentText).toBe("老文档首段");
      expect(restored?.attachmentFileName).toBe("history.pdf");
    } finally {
      vi.useRealTimers();
    }
  });

  it("handleDingTalkMessage prefers resolved group filenames over preview filenames for quoted doc extraction", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.clearMessageContextCacheForTest();
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "群聊文档",
      messageType: "text",
      quoted: {
        isQuotedDocCard: true,
        msgId: "group_doc_msg_name_conflict",
        fileCreatedAt: 1772863284581,
        previewFileName: "preview-doc.tmp",
      },
    });
    shared.resolveQuotedFileMock.mockResolvedValueOnce({
      media: {
        path: "/tmp/.openclaw/media/inbound/group-doc-conflict.bin",
        mimeType: "application/octet-stream",
      },
      spaceId: "space_group_doc_3",
      fileId: "dentry_group_doc_3",
      name: "resolved-doc.pdf",
    });
    shared.extractAttachmentTextMock.mockResolvedValueOnce({
      text: "doc body",
      sourceType: "pdf",
      truncated: false,
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "m_group_doc_name_conflict",
        msgtype: "text",
        text: { content: "群聊文档", isReplyMsg: true },
        conversationType: "2",
        conversationId: "cid_group_doc_name_conflict",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.extractAttachmentTextMock).toHaveBeenCalledWith({
      path: "/tmp/.openclaw/media/inbound/group-doc-conflict.bin",
      mimeType: "application/octet-stream",
      fileName: "resolved-doc.pdf",
    });
    const restored = messageContextStore.resolveByMsgId({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_group_doc_name_conflict",
      msgId: "group_doc_msg_name_conflict",
    });
    expect(restored?.attachmentFileName).toBe("resolved-doc.pdf");
  });

  it("handleDingTalkMessage degrades quoted doc card when cached metadata is unavailable", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.clearMessageContextCacheForTest();
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "1",
      messageType: "text",
      quoted: {
        isQuotedDocCard: true,
        msgId: "missing_doc_msg",
      },
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "doc_quote_group_msg",
        msgtype: "text",
        text: { content: "1", isReplyMsg: true },
        originalMsgId: "missing_doc_msg",
        conversationType: "2",
        conversationId: "cid_group_doc",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.resolveQuotedFileMock).not.toHaveBeenCalled();
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "[引用了钉钉文档，但无法获取内容]\n\n1",
        QuotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "missing_doc_msg",
        },
      }),
    );
  });

  it("handleDingTalkMessage falls back to group-file resolution for quoted doc card in group chat", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.clearMessageContextCacheForTest();
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "1",
      messageType: "text",
      quoted: {
        isQuotedDocCard: true,
        msgId: "group_doc_msg",
        fileCreatedAt: 1772901945282,
      },
    });
    shared.resolveQuotedFileMock.mockResolvedValueOnce({
      media: { path: "/tmp/.openclaw/media/inbound/group-doc.bin", mimeType: "application/pdf" },
      spaceId: "space_group_doc",
      fileId: "file_group_doc",
      name: "doc.pdf",
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "group_doc_quote",
        msgtype: "text",
        text: { content: "1", isReplyMsg: true },
        originalMsgId: "group_doc_msg",
        conversationType: "2",
        conversationId: "cid_group_doc",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.resolveQuotedFileMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        openConversationId: "cid_group_doc",
        senderStaffId: "staff_1",
        fileCreatedAt: 1772901945282,
      },
      undefined,
    );
    const restored = messageContextStore.resolveByMsgId({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_group_doc",
      msgId: "group_doc_msg",
    });
    expect(restored).not.toBeNull();
    expect(restored!.media?.spaceId).toBe("space_group_doc");
    expect(restored!.media?.fileId).toBe("file_group_doc");
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "1",
        MediaType: "application/pdf",
        QuotedRef: {
          targetDirection: "inbound",
          key: "msgId",
          value: "group_doc_msg",
        },
      }),
    );
  });

  it("handleDingTalkMessage restores group quoted file from persisted metadata without fallback query", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    messageContextStore.clearMessageContextCacheForTest();
    messageContextStore.upsertInboundMessageContext({
      storePath: "/tmp/store.json",
      accountId: "main",
      conversationId: "cid_group_2",
      msgId: "file_origin",
      createdAt: Date.now(),
      messageType: "file",
      media: {
        spaceId: "space_group_2",
        fileId: "dentry_group_2",
      },
      ttlMs: messageContextStore.DEFAULT_MEDIA_CONTEXT_TTL_MS,
      topic: null,
    });
    messageContextStore.clearMessageContextCacheForTest();
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "群聊文件",
      messageType: "text",
      quoted: {
        isQuotedFile: true,
        msgId: "file_origin",
        fileCreatedAt: 1772863284581,
      },
    });
    shared.downloadGroupFileMock.mockResolvedValueOnce({
      path: "/tmp/.openclaw/media/inbound/group-file.bin",
      mimeType: "application/octet-stream",
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "m_group_file_quote_2",
        msgtype: "text",
        text: { content: "群聊文件", isReplyMsg: true },
        conversationType: "2",
        conversationId: "cid_group_2",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.resolveQuotedFileMock).not.toHaveBeenCalled();
    expect(shared.getUnionIdByStaffIdMock).toHaveBeenCalledTimes(1);
    expect(shared.downloadGroupFileMock).toHaveBeenCalledWith(
      expect.anything(),
      "space_group_2",
      "dentry_group_2",
      "union_1",
      undefined,
    );
  });

  it("handleDingTalkMessage finalizes card with default content when no textual output is produced", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: "" });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    const card = { cardInstanceId: "card_2", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as any,
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
    } as any);

    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    expect(shared.finishAICardMock).toHaveBeenCalledWith(card, "✅ Done", undefined, {
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "m6",
      },
    });
  });

  it("handleDingTalkMessage falls back to markdown sends when createAICard returns null", async () => {
    shared.createAICardMock.mockResolvedValueOnce(null);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as any,
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
    } as any);

    expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
    expect(shared.finishAICardMock).not.toHaveBeenCalled();
    expect(shared.sendMessageMock).toHaveBeenCalled();
    const cardSends = shared.sendMessageMock.mock.calls.filter((call: any[]) => call[3]?.card);
    expect(cardSends).toHaveLength(0);
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

    const card = { cardInstanceId: "card_tool_only", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as any,
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
    } as any);

    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    expect(shared.finishAICardMock).toHaveBeenCalledWith(card, "✅ Done", undefined, {
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "m6_tool",
      },
    });
    expect(shared.sendMessageMock.mock.calls[0]?.[3]?.quotedRef).toBeUndefined();
    expect(shared.sendMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      "tool output",
      expect.objectContaining({ card, cardUpdateMode: "append" }),
    );
  });

  it("handleDingTalkMessage skips finishAICard when current card is already terminal", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockResolvedValue({ queuedFinal: "queued final" });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const card = { cardInstanceId: "card_terminal", state: "5", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockImplementation((state: string) => state === "5");

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as any,
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
    } as any);

    expect(shared.finishAICardMock).not.toHaveBeenCalled();
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
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
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
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
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
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
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
          value: "m_media_text",
        },
      }),
    );
    expect(shared.sendMessageMock).toHaveBeenCalledWith(
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

  it("card mode + media bypasses finalContent accumulation and still finalizes with text", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { text: "final output", mediaUrl: "https://cdn.example.com/report.pdf" },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const card = { cardInstanceId: "card_media_final", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as any,
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
          value: "m_card_media_text",
        },
      }),
    );
    expect(shared.finishAICardMock).toHaveBeenCalledWith(card, "final output", undefined, {
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "m_card_media_text",
      },
    });
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
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
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
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
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

  it("handleDingTalkMessage attaches and recalls native ack reaction in markdown mode", async () => {
    vi.useFakeTimers();
    mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
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
        } as any,
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
      } as any);
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
      .mockResolvedValueOnce({ data: { success: true } } as any)
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
        log: { debug: debugLog, warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
        dingtalkConfig: {
          clientId: "ding_client",
          clientSecret: "secret",
          dmPolicy: "open",
          messageType: "markdown",
          ackReaction: "🤔思考中",
        } as any,
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
      } as any);

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

  it("handleDingTalkMessage uses native ack reaction when ackReaction is configured", async () => {
    vi.useFakeTimers();
    mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
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
        } as any,
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
      } as any);
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
      const sentTexts = shared.sendMessageMock.mock.calls.map((call: any[]) =>
        String(call[2] ?? ""),
      );
      expect(sentTexts.some((text: string) => text.includes("思考中"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handleDingTalkMessage falls back to global messages.ackReaction when channel ackReaction is absent", async () => {
    vi.useFakeTimers();
    mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
    try {
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
        } as any,
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
      } as any);
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("handleDingTalkMessage falls back to agent identity emoji when account channel and messages ackReaction are absent", async () => {
    vi.useFakeTimers();
    mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
    try {
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
        } as any,
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
      } as any);
      await vi.advanceTimersByTimeAsync(1200);

      expect(mockedAxiosPost).toHaveBeenNthCalledWith(
        1,
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("handleDingTalkMessage attaches the fixed thinking reaction when ackReaction=emoji", async () => {
    vi.useFakeTimers();
    mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
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
        } as any,
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
      } as any);
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

  it("handleDingTalkMessage lets kaomoji seed the initial reaction and still switch on tool events", async () => {
    vi.useFakeTimers();
    mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
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
    } as any;
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
        } as any,
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
      } as any);
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

  it("handleDingTalkMessage attaches default ack reaction (👀) when config and agent identity ackReaction are absent", async () => {
    vi.useFakeTimers();
    mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
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
        } as any,
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
      } as any);
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

  it("handleDingTalkMessage does not send standalone thinking message when ackReaction is enabled", async () => {
    vi.useFakeTimers();
    mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
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
        } as any,
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
      } as any);
      await vi.advanceTimersByTimeAsync(1200);

      expect(mockedAxiosPost).toHaveBeenCalledTimes(2);
      const sentTexts = shared.sendMessageMock.mock.calls.map((call: any[]) =>
        String(call[2] ?? ""),
      );
      expect(sentTexts.some((text: string) => text.includes("思考中"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handleDingTalkMessage attaches native ack reaction in card mode", async () => {
    vi.useFakeTimers();
    mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
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
          messageType: "card",
          ackReaction: "🤔思考中",
        } as any,
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
      } as any);
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("handleDingTalkMessage keeps native ack reaction when configured card mode falls back", async () => {
    vi.useFakeTimers();
    shared.createAICardMock.mockResolvedValueOnce(null);
    mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
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
          messageType: "card",
          ackReaction: "🤔思考中",
        } as any,
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
      } as any);
      await vi.advanceTimersByTimeAsync(1200);

      expect(mockedAxiosPost).toHaveBeenCalledTimes(2);
      expect(shared.sendMessageMock).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("handleDingTalkMessage continues when native ack reaction attach fails", async () => {
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
        } as any,
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
      } as any);

      await vi.runAllTimersAsync();
      await expect(handlePromise).resolves.toBeUndefined();

      expect(mockedAxiosPost).toHaveBeenCalledTimes(3);
      expect(
        mockedAxiosPost.mock.calls.every((call) =>
          String(call[0] || "").includes("/robot/emotion/reply"),
        ),
      ).toBe(true);
      const sentTexts = shared.sendMessageMock.mock.calls.map((call: any[]) => String(call[2] ?? ""));
      expect(sentTexts.some((text: string) => text.includes("思考中"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handleDingTalkMessage does not recall when native ack reaction attach fails", async () => {
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
        } as any,
        data: {
          msgId: "m5_reaction_fail_no_recall",
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

      await vi.runAllTimersAsync();
      await expect(handlePromise).resolves.toBeUndefined();

      expect(mockedAxiosPost).toHaveBeenCalledTimes(3);
      expect(
        mockedAxiosPost.mock.calls.every((call) =>
          String(call[0] || "").includes("/robot/emotion/reply"),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handleDingTalkMessage does not fall back to standalone thinking message when reaction attach fails", async () => {
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
        } as any,
        data: {
          msgId: "m5_reaction_fail_fallback",
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

      await vi.runAllTimersAsync();
      await expect(handlePromise).resolves.toBeUndefined();

      expect(mockedAxiosPost).toHaveBeenCalledTimes(3);
      const sentTexts = shared.sendMessageMock.mock.calls.map((call: any[]) => String(call[2] ?? ""));
      expect(sentTexts.some((text: string) => text.includes("思考中"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not update the main-session last route for group inbound messages", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        groupPolicy: "allowlist",
        allowFrom: ["cid_group_1"],
        messageType: "markdown",
        ackReaction: "",
      } as any,
      data: {
        msgId: "m_group_last_route",
        msgtype: "text",
        text: { content: "hello group" },
        conversationType: "2",
        conversationId: "cid_group_1",
        conversationTitle: "group-title",
        senderId: "user_1",
        senderNick: "Alice",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(runtime.channel.session.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "s1",
        updateLastRoute: undefined,
      }),
    );
  });

  it("does not update the main-session last route for non-owner direct messages when a main owner is pinned", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: { session: { dmScope: "main" } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        allowFrom: ["owner_user"],
        messageType: "markdown",
        ackReaction: "",
      } as any,
      data: {
        msgId: "m_dm_non_owner_last_route",
        msgtype: "text",
        text: { content: "hello direct" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "other_user",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(runtime.channel.session.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "s1",
        updateLastRoute: undefined,
      }),
    );
  });

  it("updates the main-session last route for the pinned owner direct message", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: { session: { dmScope: "main" } },
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        allowFrom: ["owner_user"],
        messageType: "markdown",
        ackReaction: "",
      } as any,
      data: {
        msgId: "m_dm_owner_last_route",
        msgtype: "text",
        text: { content: "hello owner" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "owner_user",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(runtime.channel.session.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "s1",
        updateLastRoute: {
          sessionKey: "s1",
          channel: "dingtalk",
          to: "owner_user",
          accountId: "main",
        },
      }),
    );
  });

  it("handleDingTalkMessage ignores thinking and tool card updates when card is already finalized", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "thinking" });
        await dispatcherOptions.deliver({ text: "tool output" }, { kind: "tool" });
        return { queuedFinal: "" };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const card = { cardInstanceId: "card_finalized", state: "3", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockImplementation((state: string) => state === "3");

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as any,
      data: {
        msgId: "m7_finalized",
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

    expect(shared.sendMessageMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "tool output",
      expect.objectContaining({ cardUpdateMode: "append" }),
    );
    expect(shared.finishAICardMock).not.toHaveBeenCalled();
  });

  it("handleDingTalkMessage marks card FAILED when finishAICard throws", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    const card = { cardInstanceId: "card_3", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.finishAICardMock.mockRejectedValueOnce({
      message: "finish failed",
      response: { data: { code: "invalidParameter", message: "cannot finalize" } },
    });
    const log = { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: log as any,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as any,
      data: {
        msgId: "m7",
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

    expect(card.state).toBe("5");
    const debugLogs = log.debug.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      debugLogs.some(
        (entry) =>
          entry.includes("[DingTalk][ErrorPayload][inbound.cardFinalize]") &&
          entry.includes("code=invalidParameter") &&
          entry.includes("message=cannot finalize"),
      ),
    ).toBe(true);
  });

  it("handleDingTalkMessage group card flow creates card and streams tool/reasoning", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const createdCard = { cardInstanceId: "card_new", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(createdCard);
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "group hello",
      mediaPath: "download_code_1",
      messageType: "text",
    });
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "image/png" },
    } as any);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        groupPolicy: "allowlist",
        allowFrom: ["cid_group_1"],
        messageType: "card",
        robotCode: "robot_1",
        groups: { cid_group_1: { systemPrompt: "group prompt" } },
      } as any,
      data: {
        msgId: "m8",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "cid_group_1",
        conversationTitle: "group-title",
        senderId: "user_1",
        senderNick: "Alice",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
  });

  it("uses payload.text for outbound reply delivery even when markdown is present", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { text: "plain text reply", markdown: "stale markdown reply" },
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
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m_payload_text_only",
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

    expect(shared.sendMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      "plain text reply",
      expect.not.objectContaining({ card: expect.anything() }),
    );
    expect(shared.sendMessageMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      "stale markdown reply",
      expect.anything(),
    );
  });

  it("streams reasoning updates to card via controller (streamAICard)", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "thinking pass 1" });
        await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
        return { queuedFinal: false };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const card = {
      cardInstanceId: "card_reasoning_replace",
      state: "1",
      lastUpdated: Date.now(),
    } as any;
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
        cardRealTimeStream: true,
      } as any,
      data: {
        msgId: "m_reasoning_replace",
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

    expect(shared.streamAICardMock).toHaveBeenCalledWith(
      card,
      expect.stringContaining("thinking pass 1"),
      false,
      undefined,
    );
  });

  it("sends proactive permission hint when proactive API risk was observed", async () => {
    recordProactiveRiskObservation({
      accountId: "main",
      targetId: "manager123",
      level: "high",
      reason: "Forbidden.AccessDenied.AccessTokenPermissionDenied",
      source: "proactive-api",
    });
    shared.sendBySessionMock.mockResolvedValue(undefined);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        ackReaction: "",
        proactivePermissionHint: { enabled: true, cooldownHours: 24 },
      } as any,
      data: {
        msgId: "m9",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "manager123",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(String(shared.sendBySessionMock.mock.calls[0]?.[2])).toContain("主动推送可能失败");
  });

  it("sends proactive permission hint only once within cooldown window", async () => {
    recordProactiveRiskObservation({
      accountId: "main",
      targetId: "manager123",
      level: "high",
      reason: "Forbidden.AccessDenied.AccessTokenPermissionDenied",
      source: "proactive-api",
    });
    shared.sendBySessionMock.mockResolvedValue(undefined);

    const params = {
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        ackReaction: "",
        proactivePermissionHint: { enabled: true, cooldownHours: 24 },
      } as any,
      data: {
        msgId: "m10",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "manager123",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any;

    await handleDingTalkMessage(params);
    await handleDingTalkMessage(params);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
  });

  it("does not send proactive permission hint without proactive API risk observation", async () => {
    shared.sendBySessionMock.mockResolvedValue(undefined);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        ackReaction: "",
        proactivePermissionHint: { enabled: true, cooldownHours: 24 },
      } as any,
      data: {
        msgId: "m11",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "0341234567",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
  });

  it("matches proactive permission hint risk using senderOriginalId when senderStaffId is present", async () => {
    recordProactiveRiskObservation({
      accountId: "main",
      targetId: "raw_sender_1",
      level: "high",
      reason: "Forbidden.AccessDenied.AccessTokenPermissionDenied",
      source: "proactive-api",
    });
    shared.sendBySessionMock.mockResolvedValue(undefined);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        dmPolicy: "open",
        messageType: "markdown",
        ackReaction: "",
        proactivePermissionHint: { enabled: true, cooldownHours: 24 },
      } as any,
      data: {
        msgId: "m11_raw_id",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "1",
        conversationId: "cid_ok",
        senderId: "raw_sender_1",
        senderStaffId: "staff_sender_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(String(shared.sendBySessionMock.mock.calls[0]?.[2])).toContain("主动推送可能失败");
  });

  it("injects group turn context prompt with authoritative sender metadata", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "m_group_turn_ctx",
        msgtype: "text",
        text: { content: "hello group" },
        conversationType: "2",
        conversationId: "cid_group_ctx",
        conversationTitle: "Dev Group",
        senderId: "raw_sender_1",
        senderStaffId: "staff_sender_1",
        senderNick: "Alice",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: expect.stringContaining("Current DingTalk group turn context:"),
      }),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: expect.stringContaining("senderDingtalkId: staff_sender_1"),
      }),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: expect.stringContaining("senderName: Alice"),
      }),
    );
  });

  it("concurrent messages create independent cards with distinct IDs", async () => {
    let resolveA!: () => void;
    const gateA = new Promise<void>((r) => {
      resolveA = r;
    });

    const cardA = { cardInstanceId: "card_A", state: "1", lastUpdated: Date.now() } as any;
    const cardB = { cardInstanceId: "card_B", state: "1", lastUpdated: Date.now() } as any;
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
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as any,
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
    } as any);

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
    } as any);

    await promiseB;
    resolveA();
    await promiseA;

    expect(shared.createAICardMock).toHaveBeenCalledTimes(2);
    expect(shared.finishAICardMock).toHaveBeenCalledTimes(2);

    const finishCalls = shared.finishAICardMock.mock.calls;
    const finishedCardIds = finishCalls.map((call: any[]) => call[0].cardInstanceId);
    expect(finishedCardIds).toContain("card_A");
    expect(finishedCardIds).toContain("card_B");
  });

  it("concurrent messages pass correct card reference to sendMessage", async () => {
    let resolveA!: () => void;
    const gateA = new Promise<void>((r) => {
      resolveA = r;
    });

    const cardA = { cardInstanceId: "card_A", state: "1", lastUpdated: Date.now() } as any;
    const cardB = { cardInstanceId: "card_B", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(cardA).mockResolvedValueOnce(cardB);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    const runtimeA = buildRuntime();
    runtimeA.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await gateA;
        await dispatcherOptions.deliver({ text: "tool A" }, { kind: "tool" });
        await dispatcherOptions.deliver({ text: "reply A" }, { kind: "final" });
        return { queuedFinal: "reply A" };
      });
    const runtimeB = buildRuntime();
    runtimeB.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "tool B" }, { kind: "tool" });
        await dispatcherOptions.deliver({ text: "reply B" }, { kind: "final" });
        return { queuedFinal: "reply B" };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtimeA).mockReturnValueOnce(runtimeB);

    const baseParams = {
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as any,
    };

    const promiseA = handleDingTalkMessage({
      ...baseParams,
      data: {
        msgId: "bind_A",
        msgtype: "text",
        text: { content: "hello A" },
        conversationType: "1",
        conversationId: "cid_same",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    const promiseB = handleDingTalkMessage({
      ...baseParams,
      data: {
        msgId: "bind_B",
        msgtype: "text",
        text: { content: "hello B" },
        conversationType: "1",
        conversationId: "cid_same",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    await promiseB;
    resolveA();
    await promiseA;

    const sendCalls = shared.sendMessageMock.mock.calls;
    const toolCallA = sendCalls.find((call: any[]) => call[2] === "tool A");
    const toolCallB = sendCalls.find((call: any[]) => call[2] === "tool B");
    expect(toolCallA).toBeTruthy();
    expect(toolCallB).toBeTruthy();
    expect(toolCallA![3]?.card?.cardInstanceId).toBe("card_A");
    expect(toolCallB![3]?.card?.cardInstanceId).toBe("card_B");
    expect(toolCallA![3]?.cardUpdateMode).toBe("append");
    expect(toolCallB![3]?.cardUpdateMode).toBe("append");
  });

  it("message A card in terminal state still finalizes without affecting message B", async () => {
    const cardA = { cardInstanceId: "card_term", state: "3", lastUpdated: Date.now() } as any;
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
      dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as any,
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
    } as any);

    expect(shared.finishAICardMock).not.toHaveBeenCalled();
    const cardSendCalls = shared.sendMessageMock.mock.calls.filter((call: any[]) => call[3]?.card);
    expect(cardSendCalls).toHaveLength(0);
  });

  it("sends markdown fallback in post-dispatch when card fails mid-stream", async () => {
    const card = { cardInstanceId: "card_mid_fail", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockImplementation(
      (state: string) => state === "3" || state === "5",
    );

    shared.streamAICardMock.mockImplementation(async () => {
      card.state = "5";
      throw new Error("stream api error");
    });

    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };

    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        replyOptions?.onPartialReply?.({ text: "partial content" });
        await new Promise((r) => setTimeout(r, 350));
        await dispatcherOptions.deliver({ text: "complete final answer" }, { kind: "final" });
        return { queuedFinal: "complete final answer" };
      });
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: log as any,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", cardRealTimeStream: true } as any,
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
    } as any);

    const debugLogs = log.debug.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(
      debugLogs.some((msg) =>
        msg.includes("Card failed during streaming, sending markdown fallback"),
      ),
    ).toBe(true);

    // Fallback uses sendMessage with forceMarkdown to skip card creation
    // while preserving journal writes.
    const fallbackCalls = shared.sendMessageMock.mock.calls.filter(
      (call: any[]) => call[3]?.forceMarkdown === true,
    );
    expect(fallbackCalls.length).toBeGreaterThanOrEqual(1);
    expect(fallbackCalls[0][2]).toBe("complete final answer");
  });

  it("acquires session lock with the resolved sessionKey", async () => {
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
      data: {
        msgId: "lock_test",
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

    expect(shared.acquireSessionLockMock).toHaveBeenCalledTimes(1);
    expect(shared.acquireSessionLockMock).toHaveBeenCalledWith("s1");
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
        log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as any,
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
      } as any),
    ).rejects.toThrow("dispatch crash");

    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it("attempts to finalize active card when dispatchReply throws", async () => {
    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("dispatch crash"));
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    const card = { cardInstanceId: "card_on_error", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);

    await expect(
      handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
        dingtalkConfig: { dmPolicy: "open", messageType: "card", ackReaction: "" } as any,
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
      } as any),
    ).rejects.toThrow("dispatch crash");

    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    expect(shared.finishAICardMock).toHaveBeenCalledWith(card, "❌ 处理失败", expect.anything());
  });

  it("cardRealTimeStream finalize uses accumulated multi-turn content instead of last-turn-only deliver text", async () => {
    const card = { cardInstanceId: "card_accum", state: "1", lastUpdated: Date.now() } as any;
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
        showThinking: false,
      } as any,
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
    } as any);

    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    const finalizeContent = shared.finishAICardMock.mock.calls[0][1];
    expect(finalizeContent).toContain("Turn 1");
    expect(finalizeContent).toContain("Turn 2");
    expect(finalizeContent).not.toBe("Turn 2 short summary");
  });

  it("card finalize with empty deliver(final) text still finalizes card instead of early-returning", async () => {
    const card = { cardInstanceId: "card_empty_final", state: "1", lastUpdated: Date.now() } as any;
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
      dingtalkConfig: { dmPolicy: "open", messageType: "card", showThinking: false } as any,
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
    } as any);

    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
  });

  it("cardRealTimeStream=false: finalize uses rawFinalText not reasoning content from controller", async () => {
    const card = { cardInstanceId: "card_no_realtime", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    const runtime = buildRuntime();
    runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        replyOptions?.onReasoningStream?.({ text: "deep thinking about the problem" });
        await new Promise((r) => setTimeout(r, 350));
        await dispatcherOptions.deliver({ text: "Here is the final answer." }, { kind: "final" });
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
        showThinking: false,
        cardRealTimeStream: false,
      } as any,
      data: {
        msgId: "mid_norealtime",
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

    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    const finalizeContent = shared.finishAICardMock.mock.calls[0][1];
    expect(finalizeContent).toBe("Here is the final answer.");
    expect(finalizeContent).not.toContain("思考中");
  });

  it("file-only response finalizes card with Done instead of reasoning content", async () => {
    const card = { cardInstanceId: "card_file_only", state: "1", lastUpdated: Date.now() } as any;
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
        showThinking: false,
      } as any,
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
    } as any);

    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    const finalizeContent = shared.finishAICardMock.mock.calls[0][1];
    expect(finalizeContent).not.toContain("思考中");
    expect(finalizeContent).not.toContain("send");
  });

  it("learns group/user targets from inbound displayName metadata", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({ text: "hello", messageType: "text" });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "default",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown" } as any,
      data: {
        msgId: "mid_learn_target_1",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "cid_group_target_1",
        conversationTitle: "Dev Group",
        senderId: "union_user_1",
        senderStaffId: "staff_user_1",
        senderNick: "Alice",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    const groups = listKnownGroupTargets({
      storePath: "/tmp/store.json",
      accountId: "default",
      query: "Dev Group",
    });
    const users = listKnownUserTargets({
      storePath: "/tmp/store.json",
      accountId: "default",
      query: "Alice",
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.conversationId).toBe("cid_group_target_1");
    expect(users).toHaveLength(1);
    expect(users[0]?.canonicalUserId).toBe("staff_user_1");
  });

    it('sends proactive permission hint only once within cooldown window', async () => {
        recordProactiveRiskObservation({
            accountId: 'main',
            targetId: 'manager123',
            level: 'high',
            reason: 'Forbidden.AccessDenied.AccessTokenPermissionDenied',
            source: 'proactive-api',
        });
        shared.sendBySessionMock.mockResolvedValue(undefined);

        const params = {
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: {
                dmPolicy: 'open',
                messageType: 'markdown',
                ackReaction: '',
                proactivePermissionHint: { enabled: true, cooldownHours: 24 },
            } as any,
            data: {
                msgId: 'm10',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'manager123',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any;

        await handleDingTalkMessage(params);
        await handleDingTalkMessage(params);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    });

    it('does not send proactive permission hint without proactive API risk observation', async () => {
        shared.sendBySessionMock.mockResolvedValue(undefined);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: {
                dmPolicy: 'open',
                messageType: 'markdown',
                ackReaction: '',
                proactivePermissionHint: { enabled: true, cooldownHours: 24 },
            } as any,
            data: {
                msgId: 'm11',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: '0341234567',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).not.toHaveBeenCalled();
    });

    it('matches proactive permission hint risk using senderOriginalId when senderStaffId is present', async () => {
        recordProactiveRiskObservation({
            accountId: 'main',
            targetId: 'raw_sender_1',
            level: 'high',
            reason: 'Forbidden.AccessDenied.AccessTokenPermissionDenied',
            source: 'proactive-api',
        });
        shared.sendBySessionMock.mockResolvedValue(undefined);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: {
                dmPolicy: 'open',
                messageType: 'markdown',
                ackReaction: '',
                proactivePermissionHint: { enabled: true, cooldownHours: 24 },
            } as any,
            data: {
                msgId: 'm11_raw_id',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'raw_sender_1',
                senderStaffId: 'staff_sender_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(String(shared.sendBySessionMock.mock.calls[0]?.[2])).toContain('主动推送可能失败');
    });

    it('injects group turn context prompt with authoritative sender metadata', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
            data: {
                msgId: 'm_group_turn_ctx',
                msgtype: 'text',
                text: { content: 'hello group' },
                conversationType: '2',
                conversationId: 'cid_group_ctx',
                conversationTitle: 'Dev Group',
                senderId: 'raw_sender_1',
                senderStaffId: 'staff_sender_1',
                senderNick: 'Alice',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                GroupSystemPrompt: expect.stringContaining('Current DingTalk group turn context:'),
            }),
        );
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                GroupSystemPrompt: expect.stringContaining('senderDingtalkId: staff_sender_1'),
            }),
        );
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                GroupSystemPrompt: expect.stringContaining('senderName: Alice'),
            }),
        );
    });

    it('concurrent messages create independent cards with distinct IDs', async () => {
        let resolveA!: () => void;
        const gateA = new Promise<void>((r) => { resolveA = r; });

        const cardA = { cardInstanceId: 'card_A', state: '1', lastUpdated: Date.now() } as any;
        const cardB = { cardInstanceId: 'card_B', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock
            .mockResolvedValueOnce(cardA)
            .mockResolvedValueOnce(cardB);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        const runtimeA = buildRuntime();
        runtimeA.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async ({ dispatcherOptions }) => {
            await gateA;
            await dispatcherOptions.deliver({ text: 'reply A' }, { kind: 'final' });
            return { queuedFinal: 'reply A' };
        });
        const runtimeB = buildRuntime();
        runtimeB.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: 'reply B' }, { kind: 'final' });
            return { queuedFinal: 'reply B' };
        });
        shared.getRuntimeMock
            .mockReturnValueOnce(runtimeA)
            .mockReturnValueOnce(runtimeB);

        const baseParams = {
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', ackReaction: '' } as any,
        };

        const promiseA = handleDingTalkMessage({
            ...baseParams,
            data: {
                msgId: 'concurrent_A', msgtype: 'text', text: { content: 'hello A' },
                conversationType: '1', conversationId: 'cid_same', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        const promiseB = handleDingTalkMessage({
            ...baseParams,
            data: {
                msgId: 'concurrent_B', msgtype: 'text', text: { content: 'hello B' },
                conversationType: '1', conversationId: 'cid_same', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        await promiseB;
        resolveA();
        await promiseA;

        expect(shared.createAICardMock).toHaveBeenCalledTimes(2);
        expect(shared.finishAICardMock).toHaveBeenCalledTimes(2);

        const finishCalls = shared.finishAICardMock.mock.calls;
        const finishedCardIds = finishCalls.map((call: any[]) => call[0].cardInstanceId);
        expect(finishedCardIds).toContain('card_A');
        expect(finishedCardIds).toContain('card_B');
    });

    it('concurrent messages pass correct card reference to sendMessage', async () => {
        let resolveA!: () => void;
        const gateA = new Promise<void>((r) => { resolveA = r; });

        const cardA = { cardInstanceId: 'card_A', state: '1', lastUpdated: Date.now() } as any;
        const cardB = { cardInstanceId: 'card_B', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock
            .mockResolvedValueOnce(cardA)
            .mockResolvedValueOnce(cardB);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        const runtimeA = buildRuntime();
        runtimeA.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async ({ dispatcherOptions }) => {
            await gateA;
            await dispatcherOptions.deliver({ text: 'tool A' }, { kind: 'tool' });
            await dispatcherOptions.deliver({ text: 'reply A' }, { kind: 'final' });
            return { queuedFinal: 'reply A' };
        });
        const runtimeB = buildRuntime();
        runtimeB.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: 'tool B' }, { kind: 'tool' });
            await dispatcherOptions.deliver({ text: 'reply B' }, { kind: 'final' });
            return { queuedFinal: 'reply B' };
        });
        shared.getRuntimeMock
            .mockReturnValueOnce(runtimeA)
            .mockReturnValueOnce(runtimeB);

        const baseParams = {
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', ackReaction: '' } as any,
        };

        const promiseA = handleDingTalkMessage({
            ...baseParams,
            data: {
                msgId: 'bind_A', msgtype: 'text', text: { content: 'hello A' },
                conversationType: '1', conversationId: 'cid_same', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        const promiseB = handleDingTalkMessage({
            ...baseParams,
            data: {
                msgId: 'bind_B', msgtype: 'text', text: { content: 'hello B' },
                conversationType: '1', conversationId: 'cid_same', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        await promiseB;
        resolveA();
        await promiseA;

        const sendCalls = shared.sendMessageMock.mock.calls;
        const toolCallA = sendCalls.find((call: any[]) => call[2] === 'tool A');
        const toolCallB = sendCalls.find((call: any[]) => call[2] === 'tool B');
        expect(toolCallA).toBeTruthy();
        expect(toolCallB).toBeTruthy();
        expect(toolCallA![3]?.card?.cardInstanceId).toBe('card_A');
        expect(toolCallB![3]?.card?.cardInstanceId).toBe('card_B');
        expect(toolCallA![3]?.cardUpdateMode).toBe('append');
        expect(toolCallB![3]?.cardUpdateMode).toBe('append');
    });

    it('message A card in terminal state still finalizes without affecting message B', async () => {
        const cardA = { cardInstanceId: 'card_term', state: '3', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(cardA);
        shared.isCardInTerminalStateMock.mockImplementation((state: string) => state === '3' || state === '5');

        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', ackReaction: '' } as any,
            data: {
                msgId: 'term_card', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).not.toHaveBeenCalled();
        const cardSendCalls = shared.sendMessageMock.mock.calls.filter((call: any[]) => call[3]?.card);
        expect(cardSendCalls).toHaveLength(0);
    });

    it('sends markdown fallback in post-dispatch when card fails mid-stream', async () => {
        const card = { cardInstanceId: 'card_mid_fail', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockImplementation((state: string) => state === '3' || state === '5');

        shared.streamAICardMock.mockImplementation(async () => {
            card.state = '5';
            throw new Error('stream api error');
        });

        const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };

        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
                replyOptions?.onPartialReply?.({ text: 'partial content' });
                await new Promise((r) => setTimeout(r, 350));
                await dispatcherOptions.deliver({ text: 'complete final answer' }, { kind: 'final' });
                return { queuedFinal: 'complete final answer' };
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: log as any,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', cardRealTimeStream: true } as any,
            data: {
                msgId: 'mid_fail_test', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        const debugLogs = log.debug.mock.calls.map((args: unknown[]) => String(args[0]));
        expect(debugLogs.some((msg) => msg.includes('Card failed during streaming, sending markdown fallback'))).toBe(true);

        // Fallback uses sendMessage with forceMarkdown to skip card creation
        // while preserving journal writes.
        const fallbackCalls = shared.sendMessageMock.mock.calls.filter(
            (call: any[]) => call[3]?.forceMarkdown === true
        );
        expect(fallbackCalls.length).toBeGreaterThanOrEqual(1);
        expect(fallbackCalls[0][2]).toBe('complete final answer');
    });

    it('acquires session lock with the resolved sessionKey', async () => {
        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
            data: {
                msgId: 'lock_test', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.acquireSessionLockMock).toHaveBeenCalledTimes(1);
        expect(shared.acquireSessionLockMock).toHaveBeenCalledWith('s1');
    });

    it('releases session lock even when dispatchReply throws', async () => {
        const releaseFn = vi.fn();
        shared.acquireSessionLockMock.mockResolvedValueOnce(releaseFn);

        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockRejectedValueOnce(new Error('dispatch crash'));
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await expect(handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
            data: {
                msgId: 'lock_crash', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any)).rejects.toThrow('dispatch crash');

        expect(releaseFn).toHaveBeenCalledTimes(1);
    });

    it('attempts to finalize active card when dispatchReply throws', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockRejectedValueOnce(new Error('dispatch crash'));
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        const card = { cardInstanceId: 'card_on_error', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);

        await expect(handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', ackReaction: '' } as any,
            data: {
                msgId: 'lock_crash_card', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any)).rejects.toThrow('dispatch crash');

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        expect(shared.finishAICardMock).toHaveBeenCalledWith(card, '❌ 处理失败', expect.anything());
    });

    it('cardRealTimeStream finalize uses accumulated multi-turn content instead of last-turn-only deliver text', async () => {
        const card = { cardInstanceId: 'card_accum', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
                // Turn 1
                replyOptions?.onPartialReply?.({ text: 'Turn 1: Full inspection report with tables and analysis' });
                await new Promise((r) => setTimeout(r, 350));

                // Runtime signals new assistant turn (after tool call)
                replyOptions?.onAssistantMessageStart?.();

                // Turn 2: text starts fresh
                replyOptions?.onPartialReply?.({ text: 'Turn 2 short summary' });
                await new Promise((r) => setTimeout(r, 350));

                // deliver(final) only provides last turn's text
                await dispatcherOptions.deliver({ text: 'Turn 2 short summary' }, { kind: 'final' });
                return {};
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', cardRealTimeStream: true, ackReaction: '', showThinking: false } as any,
            data: {
                msgId: 'mid_accum_test', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        const finalizeContent = shared.finishAICardMock.mock.calls[0][1];
        expect(finalizeContent).toContain('Turn 1');
        expect(finalizeContent).toContain('Turn 2');
        expect(finalizeContent).not.toBe('Turn 2 short summary');
    });

  // ==================== @Sub-Agent 回归测试 ====================
  describe('@sub-agent feature', () => {
    it('respects groupPolicy allowlist for sub-agent routing', async () => {
      const runtime = buildRuntime();
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValue({
        text: '@expert1 帮我看看',
        messageType: 'text',
        atMentions: [{ name: 'expert1' }],
      });
      shared.sendBySessionMock.mockResolvedValue(undefined);

      await handleDingTalkMessage({
        cfg: {
          agents: {
            list: [{ id: 'expert1', name: '专家1' }],
          },
        },
        accountId: 'main',
        sessionWebhook: 'https://session.webhook',
        log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
        dingtalkConfig: {
          dmPolicy: 'open',
          groupPolicy: 'allowlist',
          allowFrom: ['allowed_group'],
          messageType: 'markdown',
          showThinking: false,
        } as any,
        data: {
          msgId: 'm_subagent_1',
          msgtype: 'text',
          text: { content: '@expert1 帮我看看' },
          conversationType: '2', // group chat
          conversationId: 'blocked_group', // not in allowlist
          senderId: 'user_1',
          chatbotUserId: 'bot_1',
          sessionWebhook: 'https://session.webhook',
          createAt: Date.now(),
        },
      } as any);

      // Should send access denied message, not sub-agent response
      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(String(shared.sendBySessionMock.mock.calls[0]?.[2])).toContain('访问受限');
    });

    it('processes multiple sub-agents sequentially, not in parallel', async () => {
      const callOrder: string[] = [];
      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions }) => {
          callOrder.push('dispatch_start');
          await dispatcherOptions.deliver({ text: 'response' }, { kind: 'final' });
          callOrder.push('dispatch_end');
          return { queuedFinal: 'done' };
        });
      // Use mockReturnValue instead of mockReturnValueOnce to ensure all getDingTalkRuntime calls return our runtime
      shared.getRuntimeMock.mockReturnValue(runtime);
      shared.extractMessageContentMock.mockReturnValue({
        text: '@agent1 @agent2 帮我看看',
        messageType: 'text',
        atMentions: [{ name: 'agent1' }, { name: 'agent2' }],
      });

      await handleDingTalkMessage({
        cfg: {
          agents: {
            list: [
              { id: 'agent1', name: 'Agent1' },
              { id: 'agent2', name: 'Agent2' },
            ],
          },
        },
        accountId: 'main',
        sessionWebhook: 'https://session.webhook',
        log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
        dingtalkConfig: {
          dmPolicy: 'open',
          messageType: 'markdown',
          showThinking: false,
        } as any,
        data: {
          msgId: 'm_subagent_2',
          msgtype: 'text',
          text: { content: '@agent1 @agent2 帮我看看' },
          conversationType: '2', // group chat
          conversationId: 'group_1',
          senderId: 'user_1',
          chatbotUserId: 'bot_1',
          sessionWebhook: 'https://session.webhook',
          createAt: Date.now(),
        },
      } as any);

      // Sequential processing means dispatch is called twice in order
      expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
      // If parallel, we might see interleaved calls; sequential ensures complete one before next
      expect(callOrder).toEqual(['dispatch_start', 'dispatch_end', 'dispatch_start', 'dispatch_end']);
    });

    it('handles @mention of real user without error', async () => {
      const runtime = buildRuntime();
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValue({
        text: '@张三 你好',
        messageType: 'text',
        atMentions: [{ name: '张三', userId: 'real_user_123' }], // has userId = real user
      });

      await handleDingTalkMessage({
        cfg: {
          agents: {
            list: [{ id: 'main', name: '助手', default: true }],
          },
        },
        accountId: 'main',
        sessionWebhook: 'https://session.webhook',
        log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
        dingtalkConfig: {
          dmPolicy: 'open',
          messageType: 'markdown',
          showThinking: false,
        } as any,
        data: {
          msgId: 'm_subagent_3',
          msgtype: 'text',
          text: { content: '@张三 你好' },
          conversationType: '2', // group chat
          conversationId: 'group_1',
          senderId: 'user_1',
          chatbotUserId: 'bot_1',
          sessionWebhook: 'https://session.webhook',
          createAt: Date.now(),
        },
      } as any);

      // Should NOT show "未找到助手" error for real user
      expect(shared.sendBySessionMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.stringContaining('未找到'),
        expect.anything(),
      );
    });

    it('does not show error when @mention matches real user count from atUserDingtalkIds', async () => {
      const runtime = buildRuntime();
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      // @张三 (真人) - atUserDingtalkIds has 1 entry
      shared.extractMessageContentMock.mockReturnValue({
        text: '@张三 你好',
        messageType: 'text',
        atMentions: [{ name: '张三' }], // no userId (text mode)
        atUserDingtalkIds: ['dingtalk_id_zhangsan'], // 1 real user
      });

      await handleDingTalkMessage({
        cfg: {
          agents: {
            list: [{ id: 'main', name: '助手', default: true }],
          },
        },
        accountId: 'main',
        sessionWebhook: 'https://session.webhook',
        log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
        dingtalkConfig: {
          dmPolicy: 'open',
          messageType: 'markdown',
          showThinking: false,
        } as any,
        data: {
          msgId: 'm_text_real_user',
          msgtype: 'text',
          text: { content: '@张三 你好' },
          conversationType: '2', // group chat
          conversationId: 'group_1',
          senderId: 'user_1',
          chatbotUserId: 'bot_1',
          sessionWebhook: 'https://session.webhook',
          createAt: Date.now(),
        },
      } as any);

      // unmatchedNames (1) <= realUserCount (1), so no error should be shown
      expect(shared.sendBySessionMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.stringContaining('未找到'),
        expect.anything(),
      );
    });

    it('does not show error when real users are present (conservative heuristic)', async () => {
      const runtime = buildRuntime();
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      // @张三 @不存在的agent - atUserDingtalkIds has 1 entry, but 2 @mentions
      // With conservative heuristic: if realUserCount > 0, never report invalid agent names
      // This avoids false positives where real user names are incorrectly reported as missing agents
      shared.extractMessageContentMock.mockReturnValue({
        text: '@张三 @不存在的agent 你好',
        messageType: 'text',
        atMentions: [{ name: '张三' }, { name: '不存在的agent' }],
        atUserDingtalkIds: ['dingtalk_id_zhangsan'], // only 1 real user
      });
      shared.sendBySessionMock.mockResolvedValue(undefined);

      await handleDingTalkMessage({
        cfg: {
          agents: {
            list: [{ id: 'main', name: '助手', default: true }],
          },
        },
        accountId: 'main',
        sessionWebhook: 'https://session.webhook',
        log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
        dingtalkConfig: {
          dmPolicy: 'open',
          messageType: 'markdown',
          showThinking: false,
        } as any,
        data: {
          msgId: 'm_text_invalid_agent',
          msgtype: 'text',
          text: { content: '@张三 @不存在的agent 你好' },
          conversationType: '2', // group chat
          conversationId: 'group_1',
          senderId: 'user_1',
          chatbotUserId: 'bot_1',
          sessionWebhook: 'https://session.webhook',
          createAt: Date.now(),
        },
      } as any);

      // Conservative heuristic: realUserCount > 0, so no error should be shown
      // even though there's an invalid agent name
      expect(shared.sendBySessionMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.stringContaining('未找到'),
        expect.anything(),
      );
    });

    it('shows error when no real users and invalid agent name', async () => {
      const runtime = buildRuntime();
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      // @不存在的agent - no atUserDingtalkIds (no real users)
      // Only show error when realUserCount === 0 AND there are unmatchedNames
      shared.extractMessageContentMock.mockReturnValue({
        text: '@不存在的agent 你好',
        messageType: 'text',
        atMentions: [{ name: '不存在的agent' }],
        atUserDingtalkIds: [], // no real users
      });
      shared.sendBySessionMock.mockResolvedValue(undefined);

      await handleDingTalkMessage({
        cfg: {
          agents: {
            list: [{ id: 'main', name: '助手', default: true }],
          },
        },
        accountId: 'main',
        sessionWebhook: 'https://session.webhook',
        log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
        dingtalkConfig: {
          dmPolicy: 'open',
          messageType: 'markdown',
          showThinking: false,
        } as any,
        data: {
          msgId: 'm_text_invalid_agent_no_real_users',
          msgtype: 'text',
          text: { content: '@不存在的agent 你好' },
          conversationType: '2', // group chat
          conversationId: 'group_1',
          senderId: 'user_1',
          chatbotUserId: 'bot_1',
          sessionWebhook: 'https://session.webhook',
          createAt: Date.now(),
        },
      } as any);

      // realUserCount === 0 && unmatchedNames.length > 0, so error should be shown
      expect(shared.sendBySessionMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.stringContaining('未找到'),
        expect.anything(),
      );
    });

    it('uses correct sessionWebhook for each sub-agent in order', async () => {
      const webhookCalls: Array<{ agentId: string; webhook: string; responsePrefix: string }> = [];
      const runtime = buildRuntime();
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
        .fn()
        .mockImplementation(async ({ dispatcherOptions }) => {
          // Capture which agent is being processed by checking responsePrefix
          webhookCalls.push({
            agentId: dispatcherOptions.responsePrefix.includes('Agent1') ? 'agent1' : 'agent2',
            webhook: 'https://session.webhook',
            responsePrefix: dispatcherOptions.responsePrefix,
          });
          await dispatcherOptions.deliver({ text: 'response' }, { kind: 'final' });
          return { queuedFinal: 'done' };
        });
      shared.getRuntimeMock.mockReturnValue(runtime);
      shared.extractMessageContentMock.mockReturnValue({
        text: '@Agent1 @Agent2 帮我看看',
        messageType: 'text',
        atMentions: [{ name: 'Agent1' }, { name: 'Agent2' }],
      });

      await handleDingTalkMessage({
        cfg: {
          agents: {
            list: [
              { id: 'agent1', name: 'Agent1' },
              { id: 'agent2', name: 'Agent2' },
            ],
          },
        },
        accountId: 'main',
        sessionWebhook: 'https://session.webhook',
        log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
        dingtalkConfig: {
          dmPolicy: 'open',
          messageType: 'markdown',
          showThinking: false,
        } as any,
        data: {
          msgId: 'm_webhook_order',
          msgtype: 'text',
          text: { content: '@Agent1 @Agent2 帮我看看' },
          conversationType: '2', // group chat
          conversationId: 'group_1',
          senderId: 'user_1',
          chatbotUserId: 'bot_1',
          sessionWebhook: 'https://session.webhook',
          createAt: Date.now(),
        },
      } as any);

      // Verify order: agent1 should be processed before agent2
      expect(webhookCalls).toHaveLength(2);
      expect(webhookCalls[0].agentId).toBe('agent1');
      expect(webhookCalls[1].agentId).toBe('agent2');
      // All should use the same sessionWebhook from the inbound message
      expect(webhookCalls.every(c => c.webhook === 'https://session.webhook')).toBe(true);
      // Response prefixes should be distinct for each agent
      expect(webhookCalls[0].responsePrefix).toContain('[Agent1]');
      expect(webhookCalls[1].responsePrefix).toContain('[Agent2]');
    });

    it('falls back to resolveAgentRoute with agentId suffix when buildAgentSessionKey is unavailable', async () => {
      const runtime = buildRuntime();
      // Remove buildAgentSessionKey to trigger fallback path
      delete (runtime.channel.routing as any).buildAgentSessionKey;
      shared.getRuntimeMock.mockReturnValueOnce(runtime);
      shared.extractMessageContentMock.mockReturnValue({
        text: '@expert1 help',
        messageType: 'text',
        atMentions: [{ name: 'expert1' }],
      });

      await handleDingTalkMessage({
        cfg: {
          agents: { list: [{ id: 'expert1', name: 'expert1' }] },
        },
        accountId: 'main',
        sessionWebhook: 'https://session.webhook',
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
        data: {
          msgId: 'fb1', msgtype: 'text', text: { content: '@expert1 help' },
          conversationType: '2', conversationId: 'group_1',
          senderId: 'u1', chatbotUserId: 'bot_1',
          sessionWebhook: 'https://session.webhook', createAt: Date.now(),
        },
      } as any);

      // resolveAgentRoute should be called (fallback path)
      expect(runtime.channel.routing.resolveAgentRoute).toHaveBeenCalled();
    });
  });

    it('card finalize with empty deliver(final) text still finalizes card instead of early-returning', async () => {
        const card = { cardInstanceId: 'card_empty_final', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions }) => {
                await dispatcherOptions.deliver({ text: '' }, { kind: 'final' });
                return {};
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', showThinking: false } as any,
            data: {
                msgId: 'mid_empty_final', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    });

    it('cardRealTimeStream=false: finalize uses rawFinalText not reasoning content from controller', async () => {
        const card = { cardInstanceId: 'card_no_realtime', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
                replyOptions?.onReasoningStream?.({ text: 'deep thinking about the problem' });
                await new Promise((r) => setTimeout(r, 350));
                await dispatcherOptions.deliver({ text: 'Here is the final answer.' }, { kind: 'final' });
                return {};
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', showThinking: false, cardRealTimeStream: false } as any,
            data: {
                msgId: 'mid_norealtime', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        const finalizeContent = shared.finishAICardMock.mock.calls[0][1];
        expect(finalizeContent).toBe('Here is the final answer.');
        expect(finalizeContent).not.toContain('思考中');
    });

    it('file-only response finalizes card with Done instead of reasoning content', async () => {
        const card = { cardInstanceId: 'card_file_only', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
                replyOptions?.onReasoningStream?.({ text: 'Let me send the file' });
                await new Promise((r) => setTimeout(r, 350));
                // Bot sent file via tool, deliver(final) has no text and no media
                await dispatcherOptions.deliver({ text: '' }, { kind: 'final' });
                return {};
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', cardRealTimeStream: true, showThinking: false } as any,
            data: {
                msgId: 'mid_file_only', msgtype: 'text', text: { content: 'send me the file' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        const finalizeContent = shared.finishAICardMock.mock.calls[0][1];
        expect(finalizeContent).not.toContain('思考中');
        expect(finalizeContent).not.toContain('send');
    });

    it('cardAtSender: sends @mention after card finalize in group chat', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({ text: 'hello', messageType: 'text' });
        const card = { cardInstanceId: 'card_at_1', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);
        shared.sendBySessionMock.mockResolvedValue({});

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', cardAtSender: '✅ 回复完成' } as any,
            data: {
                msgId: 'mid_at_group', msgtype: 'text', text: { content: 'hello' },
                conversationType: '2', conversationId: 'cid_group_1', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        // Should have called sendBySession with atUserId for the @mention
        const atCalls = shared.sendBySessionMock.mock.calls.filter(
            (call: any[]) => call[3]?.atUserId === 'user_1',
        );
        expect(atCalls.length).toBe(1);
    });

    it('cardAtSender: does NOT send @mention when cardAtSender is false (default)', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({ text: 'hello', messageType: 'text' });
        const card = { cardInstanceId: 'card_at_2', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card' } as any,
            data: {
                msgId: 'mid_at_noconfig', msgtype: 'text', text: { content: 'hello' },
                conversationType: '2', conversationId: 'cid_group_1', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        const atCalls = shared.sendBySessionMock.mock.calls.filter(
            (call: any[]) => call[3]?.atUserId === 'user_1',
        );
        expect(atCalls.length).toBe(0);
    });

    it('cardAtSender: does NOT send @mention in direct messages even when enabled', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({ text: 'hello', messageType: 'text' });
        const card = { cardInstanceId: 'card_at_3', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', cardAtSender: '✅ 回复完成' } as any,
            data: {
                msgId: 'mid_at_dm', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        const atCalls = shared.sendBySessionMock.mock.calls.filter(
            (call: any[]) => call[3]?.atUserId === 'user_1',
        );
        expect(atCalls.length).toBe(0);
    });

    it('cardAtSender: swallows @mention error without affecting card finalization', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({ text: 'hello', messageType: 'text' });
        const card = { cardInstanceId: 'card_at_4', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);
        shared.sendBySessionMock.mockRejectedValueOnce(new Error('webhook expired'));

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', cardAtSender: '✅ 回复完成' } as any,
            data: {
                msgId: 'mid_at_err', msgtype: 'text', text: { content: 'hello' },
                conversationType: '2', conversationId: 'cid_group_1', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        // Card finalization succeeded despite @mention failure
    });

  it("cardAtSender: sends @mention after card finalize in group chat", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({ text: "hello", messageType: "text" });
    const card = { cardInstanceId: "card_at_1", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.sendBySessionMock.mockResolvedValue({});

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", cardAtSender: "✅ 回复完成" } as any,
      data: {
        msgId: "mid_at_group",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    // Should have called sendBySession with atUserId for the @mention
    const atCalls = shared.sendBySessionMock.mock.calls.filter(
      (call: any[]) => call[3]?.atUserId === "user_1",
    );
    expect(atCalls.length).toBe(1);
  });

  it("cardAtSender: does NOT send @mention when cardAtSender is false (default)", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({ text: "hello", messageType: "text" });
    const card = { cardInstanceId: "card_at_2", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card" } as any,
      data: {
        msgId: "mid_at_noconfig",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    const atCalls = shared.sendBySessionMock.mock.calls.filter(
      (call: any[]) => call[3]?.atUserId === "user_1",
    );
    expect(atCalls.length).toBe(0);
  });

  it("cardAtSender: does NOT send @mention in direct messages even when enabled", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({ text: "hello", messageType: "text" });
    const card = { cardInstanceId: "card_at_3", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", cardAtSender: "✅ 回复完成" } as any,
      data: {
        msgId: "mid_at_dm",
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

    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    const atCalls = shared.sendBySessionMock.mock.calls.filter(
      (call: any[]) => call[3]?.atUserId === "user_1",
    );
    expect(atCalls.length).toBe(0);
  });

  it("cardAtSender: swallows @mention error without affecting card finalization", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({ text: "hello", messageType: "text" });
    const card = { cardInstanceId: "card_at_4", state: "1", lastUpdated: Date.now() } as any;
    shared.createAICardMock.mockResolvedValueOnce(card);
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.sendBySessionMock.mockRejectedValueOnce(new Error("webhook expired"));

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "card", cardAtSender: "✅ 回复完成" } as any,
      data: {
        msgId: "mid_at_err",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "cid_group_1",
        senderId: "user_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    // Card finalization succeeded despite @mention failure
  });

  it("handleDingTalkMessage drops message when groupPolicy is disabled", async () => {
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { groupPolicy: "disabled" } as any,
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
      },
    } as any);

    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
    expect(shared.sendMessageMock).not.toHaveBeenCalled();
  });

  it("handleDingTalkMessage allows group listed in groups config (allowlist)", async () => {
    const rt = buildRuntime();
    shared.getRuntimeMock.mockReturnValue(rt);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        groupPolicy: "allowlist",
        groups: { cid_allowed: {} },
      } as any,
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
      },
    } as any);

    // Should not send deny message
    const denyCalls = shared.sendBySessionMock.mock.calls.filter(
      (call: any[]) => typeof call[2] === "string" && call[2].includes("访问受限"),
    );
    expect(denyCalls.length).toBe(0);
  });

  it("handleDingTalkMessage blocks sender not in groupAllowFrom", async () => {
    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        groupPolicy: "open",
        groupAllowFrom: ["user_ok"],
      } as any,
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
      },
    } as any);

    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("访问受限");
  });

  it("handleDingTalkMessage legacy fallback: allowFrom with groupId still works (allowlist)", async () => {
    const rt = buildRuntime();
    shared.getRuntimeMock.mockReturnValue(rt);

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: {
        groupPolicy: "allowlist",
        allowFrom: ["cid_legacy"],
      } as any,
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
      },
    } as any);

    // Should NOT be blocked
    const denyCalls = shared.sendBySessionMock.mock.calls.filter(
      (call: any[]) => typeof call[2] === "string" && call[2].includes("访问受限"),
    );
    expect(denyCalls.length).toBe(0);
  });

  it("handleDingTalkMessage concatenates extracted attachment text into inboundText", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);
    shared.extractMessageContentMock.mockReturnValueOnce({
      text: "[钉钉文档]\n\n",
      messageType: "interactiveCardFile",
      docSpaceId: "space_attach_concat",
      docFileId: "file_attach_concat",
    });
    shared.downloadGroupFileMock.mockResolvedValueOnce({
      path: "/tmp/.openclaw/media/inbound/report.pdf",
      mimeType: "application/pdf",
    });
    shared.extractAttachmentTextMock.mockResolvedValueOnce({
      text: "第一章 概述\n本报告介绍了...",
      sourceType: "pdf",
      truncated: false,
    });

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: "https://session.webhook",
      log: undefined,
      dingtalkConfig: { dmPolicy: "open", messageType: "markdown", robotCode: "robot_1" } as any,
      data: {
        msgId: "msg_attach_concat",
        msgtype: "interactiveCard",
        content: {
          fileName: "report.pdf",
          biz_custom_action_url:
            "dingtalk://dingtalkclient/page/yunpan?route=previewDentry&spaceId=space_attach_concat&fileId=file_attach_concat&type=file",
        },
        conversationType: "1",
        conversationId: "cid_dm_attach_concat",
        senderId: "user_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://session.webhook",
        createAt: Date.now(),
      },
    } as any);

    // The extracted text MUST be concatenated into RawBody/CommandBody
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: expect.stringContaining("[附件内容摘录]"),
      }),
    );
    expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: expect.stringContaining("第一章 概述\n本报告介绍了..."),
      }),
    );
  });
});
