/**
 * End-to-end regression for the "钉钉'确认'消息无响应" incident, driven through
 * the REAL `handleDingTalkMessage`.
 *
 * Proves the ported per-conversation promise-chain queue
 * (DingTalk-Real-AI/dingtalk-openclaw-connector port):
 *  1. A message that arrives while another is still being processed is QUEUED
 *     (its core dispatch does not start until the active run finishes) — it is
 *     never dropped silently.
 *  2. While queued, a pre-created AI Card shows a "已排队" acknowledgement.
 *  3. Once the active run finishes, the queued message is auto-reprocessed
 *     (zero re-send required).
 *  4. The queued message reuses its pre-created card for the real reply
 *     (in-place update): no second card is created.
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
  commitAICardBlocksMock: vi.fn(),
  finishAICardMock: vi.fn(),
  isCardInTerminalStateMock: vi.fn(),
  recallAICardMessageMock: vi.fn(),
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
  commitAICardBlocks: shared.commitAICardBlocksMock,
  finishAICard: shared.finishAICardMock,
  formatContentForCard: shared.formatContentForCardMock,
  isCardInTerminalState: shared.isCardInTerminalStateMock,
  recallAICardMessage: shared.recallAICardMessageMock,
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
// NOTE: inbound-session-queue, session-lock, and reply-session-conflict are NOT
// mocked — we exercise the real promise-chain serializer + real per-session lock.
import { handleDingTalkMessage } from "../../src/inbound-handler";
import { resetProactivePermissionHintStateForTest } from "../../src/inbound-handler";
import {
  chainInboundSessionTask,
  MAX_INBOUND_SESSION_QUEUE_DEPTH,
  MAX_INBOUND_SESSION_QUEUE_WAIT_MS,
  QUEUE_BUSY_ACK_PHRASES,
  resetInboundSessionQueueForTest,
} from "../../src/inbound-session-queue";
import { dispatchInboundViaSessionQueue } from "../../src/inbound-session-queue-dispatcher";
import * as messageContextStore from "../../src/message-context-store";
import { clearTargetDirectoryStateCache } from "../../src/targeting/target-directory-store";

const TEST_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-queue-int-"));
const STORE_PATH = path.join(TEST_TMP_DIR, "store-queue.json");
const SESSION_KEY = "agent:main:dingtalk:direct:user-queue";

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
        saveMediaBuffer: vi
          .fn()
          .mockResolvedValue({ path: "/tmp/m.png", contentType: "image/png" }),
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

let cardSerial = 0;
function buildMessage(text: string, msgId: string) {
  return {
    cfg: {},
    accountId: "main",
    sessionWebhook: `https://session.webhook/${msgId}`,
    log: undefined,
    dingtalkConfig: { dmPolicy: "open", clientId: "robot_x", messageType: "card" } as any,
    data: {
      msgId,
      msgtype: "text",
      text: { content: text },
      conversationType: "1",
      conversationId: "cid_queue_1",
      senderId: "user-queue",
      senderNick: "排队用户",
      chatbotUserId: "bot_1",
      sessionWebhook: `https://session.webhook/${msgId}`,
      createAt: Date.now(),
    },
  } as any;
}

// Mirrors how the gateway invokes a message: the queue dispatcher wraps the
// real handleDingTalkMessage and threads the optional preCreatedCard through.
function dispatch(msg: any): Promise<void> {
  return dispatchInboundViaSessionQueue(
    {
      cfg: msg.cfg,
      accountId: msg.accountId,
      data: msg.data,
      dingtalkConfig: msg.dingtalkConfig,
      log: msg.log,
    },
    (preCreatedCard) => handleDingTalkMessage({ ...msg, preCreatedCard }),
  );
}

describe('inbound session queue (钉钉"确认"无响应 regression)', () => {
  beforeEach(() => {
    clearTargetDirectoryStateCache();
    fs.rmSync(path.join(TEST_TMP_DIR, "dingtalk-state"), { recursive: true, force: true });

    shared.sendBySessionMock.mockReset();
    shared.sendBySessionMock.mockResolvedValue({ ok: true });
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockResolvedValue({ ok: true });
    shared.dispatchMock.mockReset();
    shared.extractMessageContentMock.mockReset();
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.isBtwRequestTextMock.mockReset();
    shared.isBtwRequestTextMock.mockReturnValue(false);
    shared.createAICardMock.mockReset();
    shared.commitAICardBlocksMock.mockReset();
    shared.commitAICardBlocksMock.mockResolvedValue(undefined);
    shared.finishAICardMock.mockReset();
    shared.finishAICardMock.mockResolvedValue(undefined);
    shared.isCardInTerminalStateMock.mockReset();
    shared.recallAICardMessageMock.mockReset();
    shared.recallAICardMessageMock.mockResolvedValue(true);
    shared.streamAICardMock.mockReset();
    shared.streamAICardMock.mockResolvedValue(undefined);
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
    resetInboundSessionQueueForTest();
    cardSerial = 0;
  });

  afterEach(() => {
    resetInboundSessionQueueForTest();
    vi.useRealTimers();
  });

  it("queues a busy message, acks it on a pre-created card, then auto-reprocesses it (no drop, in-place card)", async () => {
    // Each createAICard call yields a distinct fake card so we can tell the
    // active run's card apart from the queued message's ACK card.
    shared.createAICardMock.mockImplementation(async () => ({
      cardInstanceId: `card_${(cardSerial += 1)}`,
      outTrackId: `card_${cardSerial}`,
      state: "INPUTING",
      storePath: STORE_PATH,
      lastStreamedContent: "",
      lastUpdated: Date.now(),
    }));
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.extractMessageContentMock.mockImplementation((data: any) => ({
      text: data?.text?.content,
      messageType: "text",
    }));

    // A's core dispatch hangs on a gate to simulate a long active run.
    let resolveADispatch: () => void = () => {};
    const aDispatchGate = new Promise<void>((resolve) => {
      resolveADispatch = resolve;
    });
    let dispatchCallCount = 0;
    shared.dispatchMock.mockImplementation(() => {
      dispatchCallCount += 1;
      if (dispatchCallCount === 1) {
        // A: hang until the test releases it.
        return aDispatchGate.then(() => ({ queuedFinal: undefined }));
      }
      // B (and beyond): resolve immediately.
      return Promise.resolve({ queuedFinal: undefined });
    });

    // A arrives first on an idle queue → runs immediately.
    const aPromise = dispatch(buildMessage("查询A", "msg_a"));
    // Let A's handler progress up to its (hanging) dispatch.
    await vi.waitFor(() => expect(shared.dispatchMock).toHaveBeenCalledTimes(1));

    // While A is still running, B arrives on the SAME conversation.
    const bPromise = dispatch(buildMessage("确认", "msg_b"));
    // Yield so the dispatcher can detect busyness and prepare B's ACK card.
    await vi.waitFor(() => expect(shared.createAICardMock).toHaveBeenCalledTimes(2));

    // Assertion 1: B is QUEUED — its core dispatch has NOT started while A runs.
    expect(shared.dispatchMock).toHaveBeenCalledTimes(1);

    // Assertion 2: B's ACK was streamed onto a pre-created card with a
    // queue-busy acknowledgement phrase.
    const ackStreamCalls = shared.streamAICardMock.mock.calls.filter((call: any[]) =>
      (QUEUE_BUSY_ACK_PHRASES as readonly string[]).includes(call[1]),
    );
    expect(ackStreamCalls.length).toBe(1);

    // Now release A's long-running dispatch.
    resolveADispatch();
    await Promise.all([aPromise, bPromise]);

    // Assertion 3: B was auto-reprocessed after A finished — its dispatch ran.
    // Total dispatch calls = 2 (A then B), in order.
    expect(shared.dispatchMock).toHaveBeenCalledTimes(2);

    // Assertion 4: B reused its pre-created ACK card — createAICard was called
    // exactly twice (A's real card + B's ACK card), NOT three times (B did not
    // create a second real card; it streamed its reply into the ACK card).
    expect(shared.createAICardMock).toHaveBeenCalledTimes(2);
    // The 2nd createAICard call is B's ACK card, prepared from the inbound
    // "确认" text (quoteContent). Use find() to be tolerant of the `log`
    // argument being undefined (expect.anything() rejects undefined).
    const bAckCreateCall = shared.createAICardMock.mock.calls.find(
      (call: any[]) => call[3]?.quoteContent === "确认",
    );
    expect(bAckCreateCall).toBeTruthy();
  });

  it("expires a queued message with a terminal card update without running its handler", async () => {
    shared.createAICardMock.mockImplementation(async () => ({
      cardInstanceId: `card_${(cardSerial += 1)}`,
      outTrackId: `card_${cardSerial}`,
      state: "INPUTING",
      storePath: STORE_PATH,
      lastStreamedContent: "",
      lastUpdated: Date.now(),
    }));
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.extractMessageContentMock.mockImplementation((data: any) => ({
      text: data?.text?.content,
      messageType: "text",
    }));
    vi.useFakeTimers({ toFake: ["setTimeout"] });

    let resolveADispatch: () => void = () => {};
    const aDispatchGate = new Promise<void>((resolve) => {
      resolveADispatch = resolve;
    });
    shared.dispatchMock.mockImplementation(() =>
      aDispatchGate.then(() => ({ queuedFinal: undefined })),
    );

    const aPromise = dispatch(buildMessage("查询A", "msg_timeout_a"));
    await vi.waitFor(() => expect(shared.dispatchMock).toHaveBeenCalledTimes(1));
    const bPromise = dispatch(buildMessage("确认", "msg_timeout_b"));
    await vi.waitFor(() => expect(shared.createAICardMock).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(MAX_INBOUND_SESSION_QUEUE_WAIT_MS);
    await bPromise;

    expect(shared.dispatchMock).toHaveBeenCalledTimes(1);
    const timeoutUpdate = shared.streamAICardMock.mock.calls.find(
      (call: any[]) => call[1].includes("这条消息未执行") && call[2] === true,
    );
    expect(timeoutUpdate).toBeTruthy();

    resolveADispatch();
    await aPromise;
    // The expired task stays in the serialized tail only long enough to skip
    // itself; it must never dispatch after the active run finishes.
    expect(shared.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a message beyond the per-conversation depth cap without invoking its handler", async () => {
    shared.createAICardMock.mockResolvedValue(null);
    let releaseActive: () => void = () => {};
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const queued = [chainInboundSessionTask("main:cid_queue_1", () => activeGate)];
    for (let index = 1; index < MAX_INBOUND_SESSION_QUEUE_DEPTH; index += 1) {
      queued.push(chainInboundSessionTask("main:cid_queue_1", async () => undefined));
    }
    const rejectedHandler = vi.fn(async () => undefined);
    await dispatchInboundViaSessionQueue(
      {
        cfg: {},
        accountId: "main",
        data: buildMessage("确认", "msg_queue_full").data,
        dingtalkConfig: { dmPolicy: "open", messageType: "card" } as any,
      },
      rejectedHandler,
    );

    expect(rejectedHandler).not.toHaveBeenCalled();
    expect(shared.sendMessageMock).toHaveBeenCalledTimes(1);
    expect(shared.sendMessageMock.mock.calls[0][2]).toContain("排队上限");

    releaseActive();
    await Promise.all(queued);
  });

  it("ask-user reinjections BYPASS the queue (no queue-busy ACK card prepared)", async () => {
    shared.createAICardMock.mockImplementation(async () => ({
      cardInstanceId: `card_${(cardSerial += 1)}`,
      outTrackId: `card_${cardSerial}`,
      state: "INPUTING",
      storePath: STORE_PATH,
      lastStreamedContent: "",
      lastUpdated: Date.now(),
    }));
    shared.isCardInTerminalStateMock.mockReturnValue(false);
    shared.extractMessageContentMock.mockImplementation((data: any) => ({
      text: data?.text?.content,
      messageType: "text",
    }));

    // A (stream) is an active run whose dispatch hangs, keeping the
    // conversation's queue busy.
    let resolveADispatch: () => void = () => {};
    const aDispatchGate = new Promise<void>((resolve) => {
      resolveADispatch = resolve;
    });
    let dispatchCallCount = 0;
    shared.dispatchMock.mockImplementation(() => {
      dispatchCallCount += 1;
      if (dispatchCallCount === 1) {
        return aDispatchGate.then(() => ({ queuedFinal: undefined }));
      }
      return Promise.resolve({ queuedFinal: undefined });
    });

    const aPromise = dispatch(buildMessage("提问", "msg_a"));
    await vi.waitFor(() => expect(shared.dispatchMock).toHaveBeenCalledTimes(1));

    // An ask-user answer is delivered by a DIRECT call to handleDingTalkMessage
    // (ask-user-question.ts does this) — it never enters the gateway dispatcher,
    // so the queue is bypassed and NO queue-busy ACK card is prepared for it.
    const answerMsg = buildMessage("答复", "msg_answer");
    answerMsg.inboundOrigin = "ask-user";
    const answerPromise = handleDingTalkMessage(answerMsg);
    // Let the dispatcher run synchronously up to its first real await.
    await Promise.resolve();
    await Promise.resolve();

    const ackStreamCalls = shared.streamAICardMock.mock.calls.filter((call: any[]) =>
      (QUEUE_BUSY_ACK_PHRASES as readonly string[]).includes(call[1]),
    );
    expect(ackStreamCalls.length).toBe(0);

    // Release A so the answer (which still acquires the per-session lock inside
    // the handler) can proceed and the test leaves no pending work behind.
    resolveADispatch();
    await Promise.all([aPromise, answerPromise]);
    expect(shared.dispatchMock).toHaveBeenCalledTimes(2);
  });
});
