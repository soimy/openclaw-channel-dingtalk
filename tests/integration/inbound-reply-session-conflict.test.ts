/**
 * Integration: reproduces the "钉钉'确认'消息无响应" incident end-to-end through
 * the REAL handleDingTalkMessage handler.
 *
 * Scenario (from the 2026-07-23 incident handoff):
 *  - A long agent run (batch self-report submission, 2–5 min) occupies session
 *    agent:main:dingtalk:direct:test-user-1 in `processing` state.
 *  - User sends "确认" as a new inbound message.
 *  - The openclaw core's reply resolver rejects the dispatch with
 *    "reply session initialization conflicted for <sessionKey>".
 *
 * Before this PR: the error propagated to the gateway catch block
 * (outcome=error, 128ms fast-fail) and the message was silently dropped —
 * the bot showed no reaction for ~38 minutes.
 *
 * After this PR: the handler retries the dispatch with backoff, and if the
 * conflict still persists, sends an immediate "处理中" acknowledgement via
 * sessionWebhook so the user is never left without feedback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  isBtwRequestTextMock: vi.fn(),
  isAbortRequestTextMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  dispatchMock: vi.fn(),
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
  deliverBtwReply: vi.fn(),
  stripLeadingMentions: (text: string) => text.replace(/^(?:@\S+\s+)*/u, ""),
  buildBtwBlockquote: vi.fn(),
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

// NOTE: session-lock and reply-session-conflict are NOT mocked — we exercise
// the real retry helper + real per-session lock, exactly as in production.
import { handleDingTalkMessage } from "../../src/inbound-handler";
import { resetProactivePermissionHintStateForTest } from "../../src/inbound-handler";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
import { clearTargetDirectoryStateCache } from "../../src/targeting/target-directory-store";
import * as messageContextStore from "../../src/message-context-store";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const TEST_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-conflict-int-"));
const STORE_PATH = path.join(TEST_TMP_DIR, "store-conflict.json");
const MEDIA_PATH = path.join(TEST_TMP_DIR, "media", "test.png");
const SESSION_KEY = "agent:main:dingtalk:direct:test-user-1";

const REPLY_SESSION_CONFLICT_ERROR = new Error(
  `reply session initialization conflicted for ${SESSION_KEY}`,
);

function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({
          agentId: "main",
          sessionKey: SESSION_KEY,
          mainSessionKey: SESSION_KEY,
        }),
        buildAgentSessionKey: vi.fn().mockReturnValue("agent-session-key"),
      },
      media: {
        saveMediaBuffer: vi.fn().mockResolvedValue({
          path: MEDIA_PATH,
          contentType: "image/png",
        }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue(STORE_PATH),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: SESSION_KEY }),
        dispatchReplyWithBufferedBlockDispatcher: shared.dispatchMock,
      },
    },
  };
}

function buildConfirmMessage() {
  return {
    cfg: {},
    accountId: "main",
    sessionWebhook: "https://session.webhook/confirm",
    log: undefined,
    dingtalkConfig: { dmPolicy: "open" } as any,
    data: {
      msgId: "msg_confirm_test_1",
      msgtype: "text",
      text: { content: "确认" },
      conversationType: "1",
      conversationId: "cid_test_1",
      senderId: "test-user-1",
      senderNick: "测试用户",
      chatbotUserId: "bot_1",
      sessionWebhook: "https://session.webhook/confirm",
      createAt: Date.now(),
    },
  } as any;
}

describe("inbound reply-session init conflict (钉钉\"确认\"无响应 regression)", () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    fs.rmSync(path.join(TEST_TMP_DIR, "dingtalk-state"), { recursive: true, force: true });

    shared.sendBySessionMock.mockReset();
    shared.sendBySessionMock.mockResolvedValue({ ok: true });
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockResolvedValue({ ok: true });
    shared.dispatchMock.mockReset();
    shared.extractMessageContentMock.mockReset();
    shared.extractMessageContentMock.mockReturnValue({ text: "确认", messageType: "text" });
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.isBtwRequestTextMock.mockReset();
    shared.isBtwRequestTextMock.mockReturnValue(false);
    shared.createAICardMock.mockReset();
    // No card → markdown reply mode, keeps the assertion surface small.
    shared.createAICardMock.mockResolvedValue(null);
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries the dispatch on reply-session conflict, then sends 处理中 ack (no silent drop)", async () => {
    // Every dispatch attempt conflicts (simulates an active run that never
    // drains within the retry budget — the worst case from the incident).
    shared.dispatchMock.mockRejectedValue(REPLY_SESSION_CONFLICT_ERROR);
    // Speed past the real backoff delays (1.5s + 3s + 4.5s).
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    const pending = handleDingTalkMessage(buildConfirmMessage());
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    // Default retry policy = 3 retries → 4 total attempts (1 initial + 3).
    expect(shared.dispatchMock).toHaveBeenCalledTimes(4);
    // The user received an immediate acknowledgement instead of silence.
    expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    const [config, webhook, ackText] = shared.sendBySessionMock.mock.calls[0];
    expect(webhook).toBe("https://session.webhook/confirm");
    expect(ackText).toContain("处理中");
    // No proactive sendMessage fallback used because sessionWebhook was set.
    expect(shared.sendMessageMock).not.toHaveBeenCalled();
  });

  it("falls back to proactive sendMessage when no sessionWebhook is available", async () => {
    shared.dispatchMock.mockRejectedValue(REPLY_SESSION_CONFLICT_ERROR);
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    const msg = buildConfirmMessage();
    msg.sessionWebhook = undefined;
    msg.data.sessionWebhook = undefined;
    const pending = handleDingTalkMessage(msg);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(shared.dispatchMock).toHaveBeenCalledTimes(4);
    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
    expect(shared.sendMessageMock).toHaveBeenCalledTimes(1);
    expect(shared.sendMessageMock.mock.calls[0][2]).toContain("处理中");
  });

  it("recovers when a retried dispatch eventually succeeds (no ack sent)", async () => {
    // First two attempts conflict (active run draining), third succeeds.
    shared.dispatchMock
      .mockRejectedValueOnce(REPLY_SESSION_CONFLICT_ERROR)
      .mockRejectedValueOnce(REPLY_SESSION_CONFLICT_ERROR)
      .mockResolvedValueOnce({ queuedFinal: undefined });
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    const pending = handleDingTalkMessage(buildConfirmMessage());
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(shared.dispatchMock).toHaveBeenCalledTimes(3);
    // Recovered → no fallback ack via sessionWebhook, and no "处理中" ack via
    // proactive sendMessage either. (The markdown reply strategy may still
    // finalize/deliver the normal reply through sendMessage — that is expected
    // and is NOT the conflict ack.)
    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
    expect(
      shared.sendMessageMock.mock.calls.some(
        (c) => typeof c[2] === "string" && c[2].includes("处理中"),
      ),
    ).toBe(false);
  });

  it("does NOT swallow unrelated dispatch errors (rethrows, no ack)", async () => {
    const unrelated = new Error("network timeout from upstream");
    shared.dispatchMock.mockRejectedValue(unrelated);

    await expect(handleDingTalkMessage(buildConfirmMessage())).rejects.toThrow(
      "network timeout from upstream",
    );

    // Single attempt — non-conflict errors are not retried.
    expect(shared.dispatchMock).toHaveBeenCalledTimes(1);
    // No ack for non-conflict errors.
    expect(shared.sendBySessionMock).not.toHaveBeenCalled();
    expect(shared.sendMessageMock).not.toHaveBeenCalled();
  });
});
