import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirror the mock setup from tests/unit/inbound-handler.test.ts

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
  isAbortRequestTextMock: vi.fn(),
  isBtwRequestTextMock: vi.fn(),
  deliverBtwReplyMock: vi.fn(),
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

vi.mock("../../src/session-lock", () => ({
  acquireSessionLock: shared.acquireSessionLockMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  isAbortRequestText: shared.isAbortRequestTextMock,
  isBtwRequestText: shared.isBtwRequestTextMock,
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

vi.mock("../../src/messaging/btw-deliver", () => ({
  deliverBtwReply: shared.deliverBtwReplyMock,
  buildBtwBlockquote: vi.fn((senderName: string, rawQuestion: string) => {
    const prefix = senderName ? `${senderName}: ` : "";
    return `> ${prefix}${rawQuestion}\n\n`;
  }),
}));

import { handleDingTalkMessage } from "../../src/inbound-handler";
import * as messageContextStore from "../../src/message-context-store";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
import {
  clearTargetDirectoryStateCache,
} from "../../src/targeting/target-directory-store";
import { resetProactivePermissionHintStateForTest } from "../../src/inbound-handler";
import path from "node:path";
import fs from "node:fs";

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
          .mockImplementation(async ({ dispatcherOptions }: any) => {
            await dispatcherOptions.deliver({ text: "btw answer" });
            return { queuedFinal: "queued final" };
          }),
      },
    },
  };
}

const baseData = {
  msgId: "btw_m1",
  msgtype: "text",
  text: { content: "/btw foo" },
  conversationType: "1",
  conversationId: "cid_btw",
  senderId: "user_1",
  senderNick: "王滨",
  chatbotUserId: "bot_1",
  sessionWebhook: "https://session.webhook/btw",
  createAt: Date.now(),
};

async function invokeWithFakeInbound(text: string, overrides: Record<string, unknown> = {}) {
  return handleDingTalkMessage({
    cfg: {},
    accountId: "main",
    sessionWebhook: "https://session.webhook/btw",
    log: undefined,
    dingtalkConfig: { dmPolicy: "open" } as any,
    data: { ...baseData, text: { content: text }, senderNick: overrides.senderNick ?? "王滨", ...overrides },
  } as any);
}

describe("inbound-handler /btw bypass", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    fs.rmSync(path.join(path.dirname("/tmp/store.json"), "dingtalk-state"), {
      recursive: true,
      force: true,
    });
    shared.sendBySessionMock.mockReset();
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockResolvedValue({ ok: true });
    shared.sendBySessionMock.mockResolvedValue({ ok: true });
    shared.prepareMediaInputMock.mockReset();
    shared.resolveOutboundMediaTypeMock.mockReset();
    shared.resolveOutboundMediaTypeMock.mockReturnValue("file");
    shared.extractMessageContentMock.mockReset();
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
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.isBtwRequestTextMock.mockReset();
    shared.isBtwRequestTextMock.mockReturnValue(false);
    shared.deliverBtwReplyMock.mockReset();
    shared.deliverBtwReplyMock.mockResolvedValue({ ok: true });

    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    shared.extractMessageContentMock.mockReturnValue({ text: "/btw foo", messageType: "text" });
    resetProactivePermissionHintStateForTest();
    clearCardRunRegistryForTest();
    messageContextStore.clearMessageContextCacheForTest();
    shared.createAICardMock.mockResolvedValue({
      cardInstanceId: "card_1",
      state: "1",
      lastUpdated: Date.now(),
    });
  });

  beforeEach(() => {
    // Set defaults for btw bypass tests
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.isBtwRequestTextMock.mockReturnValue(true);
  });

  it("does NOT acquire session lock when /btw is matched", async () => {
    await invokeWithFakeInbound("/btw foo");
    expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
  });

  it("dispatches via dispatchReplyWithBufferedBlockDispatcher with a custom deliver", async () => {
    const rt = buildRuntime();
    const dispatchSpy = vi.fn(async ({ dispatcherOptions }: any) => {
      // Simulate openclaw streaming back a payload
      await dispatcherOptions.deliver({ text: "side answer" });
      return { queuedFinal: "queued" };
    });
    rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher = dispatchSpy;
    shared.getRuntimeMock.mockReturnValue(rt);

    await invokeWithFakeInbound("/btw foo", { senderNick: "王滨" });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(shared.deliverBtwReplyMock).toHaveBeenCalledTimes(1);
    const call = vi.mocked(shared.deliverBtwReplyMock).mock.calls[0][0];
    expect(call.senderName).toBe("王滨");
    expect(call.rawQuestion).toBe("/btw foo");
    expect(call.replyText).toBe("side answer");
  });
});
