/**
 * Integration: /btw arrives while a fake main lock is held.
 * Assert that BTW dispatch does NOT wait for the held lock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  isBtwRequestTextMock: vi.fn(),
  isAbortRequestTextMock: vi.fn(),
  acquireSessionLockRealModule: null as any,
  deliverBtwReplyMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  createAICardMock: vi.fn(),
  finishAICardMock: vi.fn(),
  isCardInTerminalStateMock: vi.fn(),
  streamAICardMock: vi.fn(),
  formatContentForCardMock: vi.fn((s: string) => s),
  extractAttachmentTextMock: vi.fn(),
  prepareMediaInputMock: vi.fn(),
  resolveOutboundMediaTypeMock: vi.fn(),
  downloadGroupFileMock: vi.fn(),
  getUnionIdByStaffIdMock: vi.fn(),
  resolveQuotedFileMock: vi.fn(),
  sendProactiveMediaMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  isAbortRequestText: shared.isAbortRequestTextMock,
  isBtwRequestText: shared.isBtwRequestTextMock,
}));

vi.mock("../../src/messaging/btw-deliver", () => ({
  deliverBtwReply: shared.deliverBtwReplyMock,
  buildBtwBlockquote: vi.fn((senderName: string, rawQuestion: string) => {
    const prefix = senderName ? `${senderName}: ` : "";
    return `> ${prefix}${rawQuestion}\n\n`;
  }),
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

vi.mock("../../src/messaging/attachment-text-extractor", () => ({
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
  downloadGroupFile: shared.downloadGroupFileMock,
  getUnionIdByStaffId: shared.getUnionIdByStaffIdMock,
  resolveQuotedFile: shared.resolveQuotedFileMock,
}));

// NOTE: session-lock is NOT mocked — we use the real module to verify lock bypass
import { acquireSessionLock } from "../../src/session-lock";
import { handleDingTalkMessage } from "../../src/inbound-handler";
import * as messageContextStore from "../../src/message-context-store";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
import { clearTargetDirectoryStateCache } from "../../src/targeting/target-directory-store";
import { resetProactivePermissionHintStateForTest } from "../../src/inbound-handler";
import path from "node:path";
import fs from "node:fs";

function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi
          .fn()
          .mockReturnValue({ agentId: "main", sessionKey: "session:cidBtw", mainSessionKey: "session:cidBtw" }),
        buildAgentSessionKey: vi.fn().mockReturnValue("agent-session-key"),
      },
      media: {
        saveMediaBuffer: vi.fn().mockResolvedValue({
          path: "/tmp/.openclaw/media/inbound/test.png",
          contentType: "image/png",
        }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/store-btw.json"),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: "session:cidBtw" }),
        dispatchReplyWithBufferedBlockDispatcher: vi
          .fn()
          .mockImplementation(async ({ dispatcherOptions }: any) => {
            await dispatcherOptions.deliver({ text: "btw side answer" });
            return { queuedFinal: "queued" };
          }),
      },
    },
  };
}

describe("inbound /btw integration", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    fs.rmSync(path.join(path.dirname("/tmp/store-btw.json"), "dingtalk-state"), {
      recursive: true,
      force: true,
    });
    shared.sendBySessionMock.mockReset();
    shared.sendBySessionMock.mockResolvedValue({ ok: true });
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockResolvedValue({ ok: true });
    shared.extractMessageContentMock.mockReset();
    shared.extractMessageContentMock.mockReturnValue({ text: "/btw foo", messageType: "text" });
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.isBtwRequestTextMock.mockReset();
    shared.isBtwRequestTextMock.mockReturnValue(true);
    shared.deliverBtwReplyMock.mockReset();
    shared.deliverBtwReplyMock.mockResolvedValue({ ok: true });
    shared.createAICardMock.mockReset();
    shared.createAICardMock.mockResolvedValue({ cardInstanceId: "card_1", state: "1", lastUpdated: Date.now() });
    shared.finishAICardMock.mockReset();
    shared.isCardInTerminalStateMock.mockReset();
    shared.extractAttachmentTextMock.mockReset();
    shared.extractAttachmentTextMock.mockResolvedValue(null);
    shared.prepareMediaInputMock.mockReset();
    shared.resolveOutboundMediaTypeMock.mockReset();
    shared.resolveOutboundMediaTypeMock.mockReturnValue("file");
    shared.downloadGroupFileMock.mockReset();
    shared.downloadGroupFileMock.mockResolvedValue(null);
    shared.getUnionIdByStaffIdMock.mockReset();
    shared.getUnionIdByStaffIdMock.mockResolvedValue("union_1");
    shared.resolveQuotedFileMock.mockReset();
    shared.resolveQuotedFileMock.mockResolvedValue(null);
    shared.sendProactiveMediaMock.mockReset();
    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    resetProactivePermissionHintStateForTest();
    clearCardRunRegistryForTest();
    messageContextStore.clearMessageContextCacheForTest();
  });

  it("dispatches /btw without waiting for held session lock", async () => {
    // Acquire the session lock for "session:cidBtw" — simulating a main run
    const release = await acquireSessionLock("session:cidBtw");
    try {
      // Trigger inbound /btw on the same session
      const start = Date.now();
      await handleDingTalkMessage({
        cfg: {},
        accountId: "main",
        sessionWebhook: "https://session.webhook/btw",
        log: undefined,
        dingtalkConfig: { dmPolicy: "open" } as any,
        data: {
          msgId: "btw_integ_1",
          msgtype: "text",
          text: { content: "/btw foo" },
          conversationType: "1",
          conversationId: "cidBtw",
          senderId: "user_1",
          senderNick: "王滨",
          chatbotUserId: "bot_1",
          sessionWebhook: "https://session.webhook/btw",
          createAt: Date.now(),
        },
      } as any);
      const elapsed = Date.now() - start;

      // BTW should complete quickly, not block on the held lock
      expect(elapsed).toBeLessThan(500);
      // deliverBtwReply was called
      expect(shared.deliverBtwReplyMock).toHaveBeenCalledTimes(1);
      const call = shared.deliverBtwReplyMock.mock.calls[0][0];
      expect(call.replyText).toBe("btw side answer");
    } finally {
      release();
    }
  });
});
