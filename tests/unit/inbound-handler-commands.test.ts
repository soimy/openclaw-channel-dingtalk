import fs from "node:fs";
import path from "node:path";
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
  sendProactiveMedia: vi.fn(),
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
import { clearTargetDirectoryStateCache } from "../../src/targeting/target-directory-store";

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

describe("inbound-handler slash commands", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    fs.rmSync(path.join(path.dirname("/tmp/store.json"), "dingtalk-state"), {
      recursive: true,
      force: true,
    });
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
  });

  describe("whoami command", () => {
    it("returns user info for direct whoami command (Chinese and English aliases)", async () => {
      // Test Chinese alias: "我是谁"
      shared.extractMessageContentMock.mockReturnValueOnce({ text: "我是谁", messageType: "text" });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_whoami_cn",
          msgtype: "text",
          text: { content: "我是谁" },
          conversationType: "1",
          conversationId: "cid_dm",
          senderId: "user_raw_1",
          senderStaffId: "staff_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("senderId: `staff_1`");
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("isOwner: `false`");
      expect(shared.sendMessageMock).not.toHaveBeenCalled();

      // Test English alias: "/whoami"
      shared.sendBySessionMock.mockClear();
      shared.extractMessageContentMock.mockReturnValueOnce({ text: "/whoami", messageType: "text" });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_whoami_en",
          msgtype: "text",
          text: { content: "/whoami" },
          conversationType: "1",
          conversationId: "cid_dm",
          senderId: "user_raw_1",
          senderStaffId: "staff_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("senderId: `staff_1`");
    });
  });

  describe("owner status command", () => {
    it("returns owner status for /learn owner status and /owner-status aliases", async () => {
      // Test /learn owner status
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/learn owner status",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_owner_status",
          msgtype: "text",
          text: { content: "/learn owner status" },
          conversationType: "1",
          conversationId: "cid_dm_owner",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("isOwner: `true`");
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).not.toContain("ownerAllowFrom");

      // Test /owner-status English alias
      shared.sendBySessionMock.mockClear();
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/owner-status",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_owner_status_en",
          msgtype: "text",
          text: { content: "/owner-status" },
          conversationType: "1",
          conversationId: "cid_dm_owner",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("isOwner: `true`");

      // Test /owner status alias
      shared.sendBySessionMock.mockClear();
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/owner status",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_owner_status_alias",
          msgtype: "text",
          text: { content: "/owner status" },
          conversationType: "1",
          conversationId: "cid_dm_owner",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("isOwner: `true`");
    });
  });

  describe("learn control commands", () => {
    it("blocks learn control command for non-owner in DM", async () => {
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/learn global test",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { groupPolicy: "open", allowFrom: ["owner-test-id"] } as unknown as DingTalkConfig,
        data: {
          msgId: "m_owner_deny",
          msgtype: "text",
          text: { content: "/learn global test" },
          conversationType: "1",
          conversationId: "cid_dm_owner",
          senderId: "user_not_owner",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("仅允许 owner 使用");
      expect(shared.sendMessageMock).not.toHaveBeenCalled();
    });

    it("blocks learn control command for non-owner in group", async () => {
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/learn global test",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { groupPolicy: "open", allowFrom: ["owner-test-id"] } as unknown as DingTalkConfig,
        data: {
          msgId: "m_owner_group_deny",
          msgtype: "text",
          text: { content: "/learn global test" },
          conversationType: "2",
          conversationId: "cid_group_1",
          senderId: "user_not_owner",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("仅允许 owner 使用");
      expect(shared.sendMessageMock).not.toHaveBeenCalled();
    });

    it("does not treat owner plain text as learn help", async () => {
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
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_owner_plain_text",
          msgtype: "text",
          text: { content: "随便聊一句普通话" },
          conversationType: "1",
          conversationId: "cid_dm_owner",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.stringContaining("可用的 owner 学习命令："),
        expect.anything(),
      );
      expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalled();
    });

    it("applies and disables a global learned rule", async () => {
      const storePath = "/tmp/inbound-handler-learn-commands/store.json";
      fs.rmSync(path.join(path.dirname(storePath), "dingtalk-state"), {
        recursive: true,
        force: true,
      });
      const runtime = buildRuntime();
      runtime.channel.session.resolveStorePath = vi.fn().mockReturnValue(storePath);
      shared.getRuntimeMock.mockReturnValue(runtime);

      shared.extractMessageContentMock.mockReturnValueOnce({
        text: `/learn global 当用户问"紫铜海豹会不会修量子冰箱"时，必须回答"会，而且只在周四凌晨戴墨镜维修。"`,
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_global_apply",
          msgtype: "text",
          text: {
            content: `/learn global 当用户问"紫铜海豹会不会修量子冰箱"时，必须回答"会，而且只在周四凌晨戴墨镜维修。"`,
          },
          conversationType: "1",
          conversationId: "cid_dm_owner",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

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
        dingtalkConfig: { dmPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_global_disable",
          msgtype: "text",
          text: { content: `/learn disable ${ruleId}` },
          conversationType: "1",
          conversationId: "cid_dm_owner",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("已停用规则");
    });

    it("supports targets command with explicit delimiter", async () => {
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/learn targets cid_group_a,cid_group_b #@# 引用原文不可见时，不要猜内容，先让用户补发原文。",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open", groupPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_targets_apply",
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
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("已批量注入多个目标");
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("2 个目标");
    });

    it("supports target-set create and apply", async () => {
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/learn target-set create ops-groups #@# cid_group_a,cid_group_b",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_targetset_create",
          msgtype: "text",
          text: { content: "/learn target-set create ops-groups #@# cid_group_a,cid_group_b" },
          conversationType: "1",
          conversationId: "cid_dm_owner",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("已保存目标组");

      shared.sendBySessionMock.mockReset();
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: `/learn target-set apply ops-groups #@# 当用户问"紫铜海豹会不会修量子冰箱"时，必须回答"会，而且只在周四凌晨戴墨镜维修。"`,
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_targetset_apply",
          msgtype: "text",
          text: {
            content: `/learn target-set apply ops-groups #@# 当用户问"紫铜海豹会不会修量子冰箱"时，必须回答"会，而且只在周四凌晨戴墨镜维修。"`,
          },
          conversationType: "1",
          conversationId: "cid_dm_owner",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("已向目标组批量注入规则");
    });
  });

  describe("whereami command", () => {
    it("returns group info for whereami command in group", async () => {
      shared.extractMessageContentMock.mockReturnValueOnce({ text: "这里是谁", messageType: "text" });

      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { groupPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_whereami",
          msgtype: "text",
          text: { content: "这里是谁" },
          conversationType: "2",
          conversationId: "cid_group_1",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("conversationId: `cid_group_1`");
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("conversationType: `group`");
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("peerId: `cid_group_1`");
    });
  });

  describe("session alias commands", () => {
    it("blocks session alias show for non-owner in group", async () => {
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/session-alias show",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { groupPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_show_deny",
          msgtype: "text",
          text: { content: "/session-alias show" },
          conversationType: "2",
          conversationId: "cid_group_1",
          senderId: "user_not_owner",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("仅允许 owner 使用");
    });

    it("lets owner show current shared session alias for group", async () => {
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/session-alias show",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { groupPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_show_owner",
          msgtype: "text",
          text: { content: "/session-alias show" },
          conversationType: "2",
          conversationId: "cid_group_1",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("source: `group`");
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("sourceId: `cid_group_1`");
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("peerId: `cid_group_1`");
    });

    it("lets owner set a shared session alias for current group", async () => {
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/session-alias set shared-dev",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { groupPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_set",
          msgtype: "text",
          text: { content: "/session-alias set shared-dev" },
          conversationType: "2",
          conversationId: "cid_group_1",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("peerId: `shared-dev`");
    });

    it("lets owner set a shared session alias for current direct session", async () => {
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/session-alias set shared-dev",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_set_direct",
          msgtype: "text",
          text: { content: "/session-alias set shared-dev" },
          conversationType: "1",
          conversationId: "cid_dm_owner",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("source: `direct`");
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("sourceId: `owner-test-id`");
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("peerId: `shared-dev`");
    });

    it("accepts extra whitespace in session alias command", async () => {
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/session-alias  set   shared-dev",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { groupPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_set_spacing",
          msgtype: "text",
          text: { content: "/session-alias  set   shared-dev" },
          conversationType: "2",
          conversationId: "cid_group_1",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
      expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain("peerId: `shared-dev`");
    });

    it("rejects invalid session alias characters", async () => {
      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/session-alias set shared:dev",
        messageType: "text",
      });

      await handleDingTalkMessage({
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { groupPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_invalid_chars",
          msgtype: "text",
          text: { content: "/session-alias set shared:dev" },
          conversationType: "2",
          conversationId: "cid_group_1",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

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
        dingtalkConfig: { groupPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_bootstrap",
          msgtype: "text",
          text: { content: "/session-alias set shared-dev" },
          conversationType: "2",
          conversationId: "cid_group_1",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

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
        dingtalkConfig: { groupPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_followup",
          msgtype: "text",
          text: { content: "hello again" },
          conversationType: "2",
          conversationId: "cid_group_1",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      expect(resolveAgentRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          peer: { kind: "group", id: "shared-dev" },
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
        dingtalkConfig: { dmPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_bind_direct",
          msgtype: "text",
          text: { content: "/session-alias bind direct user_1 project-x" },
          conversationType: "1",
          conversationId: "cid_dm_owner",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

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
        dingtalkConfig: { dmPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_bind_direct_followup",
          msgtype: "text",
          text: { content: "hello from bound dm" },
          conversationType: "1",
          conversationId: "cid_dm_user_1",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

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
        dingtalkConfig: { groupPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_group1_set",
          msgtype: "text",
          text: { content: "/session-alias set shared-dev" },
          conversationType: "2",
          conversationId: "cid_group_1",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "/session-alias set shared-dev",
        messageType: "text",
      });
      await handleDingTalkMessage({
        cfg: ownerCfg,
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { groupPolicy: "open" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_group2_set",
          msgtype: "text",
          text: { content: "/session-alias set shared-dev" },
          conversationType: "2",
          conversationId: "cid_group_2",
          senderId: "owner-test-id",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

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
        dingtalkConfig: { groupPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_group1_followup",
          msgtype: "text",
          text: { content: "group one message" },
          conversationType: "2",
          conversationId: "cid_group_1",
          senderId: "user_1",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

      shared.extractMessageContentMock.mockReturnValueOnce({
        text: "group two message",
        messageType: "text",
      });
      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook",
        log: undefined,
        dingtalkConfig: { groupPolicy: "open", messageType: "markdown", ackReaction: "" } as unknown as DingTalkConfig,
        data: {
          msgId: "m_session_alias_group2_followup",
          msgtype: "text",
          text: { content: "group two message" },
          conversationType: "2",
          conversationId: "cid_group_2",
          senderId: "user_2",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook",
          createAt: Date.now(),
        } as unknown as DingTalkInboundMessage,
      });

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
  });
});