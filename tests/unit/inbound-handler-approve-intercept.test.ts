import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig, DingTalkInboundMessage } from "../../src/types";

const shared = vi.hoisted(() => ({
  tryInterceptApproveCommandMock: vi.fn(),
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  isAbortRequestTextMock: vi.fn(),
}));

vi.mock("../../src/approval/approval-command-intercept", () => ({
  tryInterceptApproveCommand: shared.tryInterceptApproveCommandMock,
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

import { handleDingTalkMessage, resetProactivePermissionHintStateForTest } from "../../src/inbound-handler";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
import { clearTargetDirectoryStateCache } from "../../src/targeting/target-directory-store";
import * as messageContextStore from "../../src/message-context-store";

function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi
          .fn()
          .mockReturnValue({ agentId: "main", sessionKey: "session-main", mainSessionKey: "session-main" }),
        buildAgentSessionKey: vi.fn().mockReturnValue("agent-session-key"),
      },
      media: {
        saveMediaBuffer: vi.fn(),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/inbound-approval-test/store.json"),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: "session-main" }),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockResolvedValue({ queuedFinal: "ok" }),
      },
    },
  };
}

function message(overrides: Partial<DingTalkInboundMessage> = {}): DingTalkInboundMessage {
  return {
    msgId: `msg_${Math.random()}`,
    msgtype: "text",
    text: { content: "hello" },
    conversationType: "1",
    conversationId: "staffA",
    senderId: "staffA",
    senderStaffId: "staffA",
    chatbotUserId: "bot",
    senderNick: "Staff A",
    createAt: Date.now(),
    sessionWebhook: "https://session.webhook",
    ...overrides,
  } as DingTalkInboundMessage;
}

async function invoke(text: string, overrides: Partial<DingTalkInboundMessage> = {}) {
  shared.extractMessageContentMock.mockReturnValue({ text, messageType: "text" });
  await handleDingTalkMessage({
    cfg: {},
    accountId: "main",
    sessionWebhook: "https://session.webhook",
    log: undefined,
    dingtalkConfig: { dmPolicy: "open", groupPolicy: "open" } as unknown as DingTalkConfig,
    data: message(overrides),
  });
}

describe("inbound-handler · /approve early intercept", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    resetProactivePermissionHintStateForTest();
    clearCardRunRegistryForTest();
    fs.rmSync(path.join(path.dirname("/tmp/inbound-approval-test/store.json"), "dingtalk-state"), {
      recursive: true,
      force: true,
    });
    shared.tryInterceptApproveCommandMock.mockReset().mockResolvedValue(false);
    shared.sendBySessionMock.mockReset();
    shared.sendMessageMock.mockReset().mockResolvedValue({ ok: true });
    shared.extractMessageContentMock.mockReset();
    shared.acquireSessionLockMock.mockReset().mockResolvedValue(vi.fn());
    shared.isAbortRequestTextMock.mockReset().mockReturnValue(false);
    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    messageContextStore.clearMessageContextCacheForTest();
  });

  it("does not call the approval intercept for ordinary messages", async () => {
    await invoke("hello");

    expect(shared.tryInterceptApproveCommandMock).not.toHaveBeenCalled();
  });

  it("calls approval intercept for direct /approve commands and bypasses reply dispatch", async () => {
    shared.tryInterceptApproveCommandMock.mockResolvedValue(true);

    await invoke("/approve abc deny");

    expect(shared.tryInterceptApproveCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/approve abc deny", senderId: "staffA" }),
    );
    expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
    expect(shared.sendMessageMock).not.toHaveBeenCalled();
  });

  it("strips leading @mentions before checking group approve commands", async () => {
    shared.tryInterceptApproveCommandMock.mockResolvedValue(true);

    await invoke("@OpenClaw /approve abc once", {
      conversationType: "2",
      conversationId: "cid-group",
      conversationTitle: "Group",
    });

    expect(shared.tryInterceptApproveCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/approve abc once" }),
    );
    expect(shared.acquireSessionLockMock).not.toHaveBeenCalled();
  });

  it("continues the normal pipeline when the intercept returns false", async () => {
    shared.tryInterceptApproveCommandMock.mockResolvedValue(false);

    await invoke("/approve abc once");

    expect(shared.acquireSessionLockMock).toHaveBeenCalledWith("session-main");
  });
});
