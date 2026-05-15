import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => {
  const http = {
    post: vi.fn(),
    put: vi.fn(),
    get: vi.fn(),
    isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
  };
  return {
    http,
    getRuntimeMock: vi.fn(),
    isAbortRequestTextMock: vi.fn(),
    isBtwRequestTextMock: vi.fn(),
  };
});

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => shared.http),
    isAxiosError: shared.http.isAxiosError,
  },
  isAxiosError: shared.http.isAxiosError,
}));

vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("token_abc"),
}));

vi.mock("../../src/runtime", () => ({
  getDingTalkRuntime: shared.getRuntimeMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  isAbortRequestText: shared.isAbortRequestTextMock,
  isBtwRequestText: shared.isBtwRequestTextMock,
}));

import { clearCardRunRegistryForTest } from "../../src/card/card-run-registry";
import { handleDingTalkMessage, resetProactivePermissionHintStateForTest } from "../../src/inbound-handler";
import { clearMessageContextCacheForTest } from "../../src/message-context-store";
import { clearTargetDirectoryStateCache } from "../../src/targeting/target-directory-store";
import type { DingTalkConfig, Logger } from "../../src/types";

const TEST_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-group-card-lifecycle-"));
const STORE_PATH = path.join(TEST_TMP_DIR, "store.json");
const TARGET_GROUP_ID = "cid//Vc7N7lA5mymGresI0XAw==";
const SESSION_WEBHOOK = "https://session.webhook/group-card-lifecycle";

function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi
          .fn()
          .mockReturnValue({ agentId: "main", sessionKey: `session:${TARGET_GROUP_ID}`, mainSessionKey: `session:${TARGET_GROUP_ID}` }),
        buildAgentSessionKey: vi.fn().mockReturnValue(`agent-session:${TARGET_GROUP_ID}`),
      },
      media: {
        saveMediaBuffer: vi.fn(),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue(STORE_PATH),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: `session:${TARGET_GROUP_ID}` }),
        dispatchReplyWithBufferedBlockDispatcher: vi
          .fn()
          .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
            if (replyOptions?.sourceReplyDeliveryMode !== "automatic") {
              return {
                queuedFinal: false,
                counts: { final: 0 },
                sourceReplyDeliveryMode: "message_tool_only",
              };
            }
            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPartialReply?.({ text: "正在生成群聊卡片回复" });
            await dispatcherOptions.deliver({ text: "这是群聊卡片的最终回复" }, { kind: "final" });
            return { queuedFinal: false, counts: { final: 1 } };
          }),
      },
    },
  };
}

function createLog(): Logger & { entries: string[] } {
  const entries: string[] = [];
  const push = (level: string) => (message: string) => {
    entries.push(`[${level}] ${message}`);
  };
  return {
    entries,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

function setupDingTalkHttpMocks() {
  shared.http.post.mockImplementation(async (url: string) => {
    if (url.includes("/v1.0/card/instances/createAndDeliver")) {
      return {
        status: 200,
        data: {
          result: {
            processQueryKey: "process_group_1",
            outTrackId: "out_group_1",
            cardInstanceId: "card_group_1",
            deliverResults: [{ success: true, carrierId: "process_group_1" }],
          },
        },
      };
    }

    if (url === SESSION_WEBHOOK) {
      return { status: 200, data: { ok: true } };
    }

    throw new Error(`Unexpected POST ${url}`);
  });
  shared.http.put.mockResolvedValue({ status: 200, data: { ok: true } });
}

function rejectPrivateDataInstanceUpdates() {
  shared.http.put.mockImplementation(async (url: string, body?: Record<string, any>) => {
    if (url.includes("/v1.0/card/instances") && body?.cardUpdateOptions?.updatePrivateDataByKey === true) {
      throw {
        isAxiosError: true,
        message: "private data update is not allowed for group shared card data",
        response: {
          status: 400,
          data: {
            code: "invalidParameter",
            message: "updatePrivateDataByKey is only valid with userPrivateData",
          },
        },
      };
    }
    return { status: 200, data: { ok: true } };
  });
}

describe("inbound group card lifecycle integration", () => {
  beforeEach(() => {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
    clearTargetDirectoryStateCache();
    clearCardRunRegistryForTest();
    clearMessageContextCacheForTest();
    resetProactivePermissionHintStateForTest();

    shared.http.post.mockReset();
    shared.http.put.mockReset();
    shared.http.get.mockReset();
    shared.getRuntimeMock.mockReset();
    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    shared.isAbortRequestTextMock.mockReset();
    shared.isAbortRequestTextMock.mockReturnValue(false);
    shared.isBtwRequestTextMock.mockReset();
    shared.isBtwRequestTextMock.mockReturnValue(false);
    setupDingTalkHttpMocks();
  });

  it("handles an @clawdbot group message through card lifecycle without markdown fallback", async () => {
    const log = createLog();
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValueOnce(runtime);

    await handleDingTalkMessage({
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
      },
      accountId: "main",
      sessionWebhook: SESSION_WEBHOOK,
      log,
      dingtalkConfig: {
        clientId: "robot_code_1",
        clientSecret: "secret",
        groupPolicy: "open",
        messageType: "card",
        cardStreamingMode: "answer",
        ackReaction: "",
      } as DingTalkConfig,
      data: {
        msgId: "group_card_lifecycle_msg_1",
        msgtype: "text",
        text: { content: "@clawdbot 请总结一下这个群聊问题" },
        conversationType: "2",
        conversationId: TARGET_GROUP_ID,
        conversationTitle: "真机验证群",
        senderId: "sender_user_1",
        senderStaffId: "staff_sender_1",
        senderNick: "Alice",
        chatbotUserId: "clawdbot",
        sessionWebhook: SESSION_WEBHOOK,
        createAt: Date.now(),
      },
    });

    const logText = log.entries.join("\n");
    expect(logText).toContain("[DingTalk][AICard] conversationType=2");
    expect(logText).toContain("deliver(final) received");
    expect(logText).toContain("Calling commitAICardBlocks");
    expect(logText).toContain("Card finalized: outTrackId=out_group_1 state=FINISHED");
    expect(logText).toContain("这是群聊卡片的最终回复");
    expect(logText).not.toContain("Card failed during streaming, sending markdown fallback");
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          sourceReplyDeliveryMode: "automatic",
        }),
      }),
    );

    const createCalls = shared.http.post.mock.calls.filter(([url]) =>
      String(url).includes("/v1.0/card/instances/createAndDeliver"),
    );
    const sessionWebhookCalls = shared.http.post.mock.calls.filter(([url]) => url === SESSION_WEBHOOK);
    const streamingCalls = shared.http.put.mock.calls.filter(([url]) =>
      String(url).includes("/v1.0/card/streaming"),
    );
    const instanceUpdateCalls = shared.http.put.mock.calls.filter(([url]) =>
      String(url).includes("/v1.0/card/instances"),
    );

    expect(createCalls).toHaveLength(1);
    expect(sessionWebhookCalls).toHaveLength(0);
    expect(streamingCalls.length).toBeGreaterThanOrEqual(3);
    expect(instanceUpdateCalls.length).toBeGreaterThanOrEqual(1);

    const createBody = createCalls[0]?.[1] as Record<string, any>;
    expect(createBody.openSpaceId).toBe(`dtv1.card//IM_GROUP.${TARGET_GROUP_ID}`);
    expect(createBody.imGroupOpenDeliverModel).toMatchObject({
      robotCode: "robot_code_1",
    });
    expect(createBody.cardData?.cardParamMap?.quoteContent).toBe("@clawdbot 请总结一下这个群聊问题");

    const finalInstanceBody = instanceUpdateCalls.at(-1)?.[1] as Record<string, any>;
    expect(finalInstanceBody.outTrackId).toBe("out_group_1");
    expect(finalInstanceBody.cardData?.cardParamMap?.flowStatus).toBe("3");
    expect(finalInstanceBody.cardData?.cardParamMap?.content).toContain("这是群聊卡片的最终回复");
    expect(finalInstanceBody.cardData?.cardParamMap?.blockList).toContain("这是群聊卡片的最终回复");
  });

  it("does not request private-data updates for shared group card block updates", async () => {
    rejectPrivateDataInstanceUpdates();
    const log = createLog();

    await handleDingTalkMessage({
      cfg: {},
      accountId: "main",
      sessionWebhook: SESSION_WEBHOOK,
      log,
      dingtalkConfig: {
        clientId: "robot_code_1",
        clientSecret: "secret",
        groupPolicy: "open",
        messageType: "card",
        cardStreamingMode: "all",
        ackReaction: "",
      } as DingTalkConfig,
      data: {
        msgId: "group_card_lifecycle_private_update_msg",
        msgtype: "text",
        text: { content: "@clawdbot 请继续分析" },
        conversationType: "2",
        conversationId: TARGET_GROUP_ID,
        conversationTitle: "真机验证群",
        senderId: "sender_user_1",
        senderStaffId: "staff_sender_1",
        senderNick: "Alice",
        chatbotUserId: "clawdbot",
        sessionWebhook: SESSION_WEBHOOK,
        createAt: Date.now(),
      },
    });

    const logText = log.entries.join("\n");
    expect(logText).toContain("Card finalized: outTrackId=out_group_1 state=FINISHED");
    expect(logText).not.toContain("Card failed during streaming, sending markdown fallback");
    expect(shared.http.post.mock.calls.filter(([url]) => url === SESSION_WEBHOOK)).toHaveLength(0);

    const instanceUpdateBodies = shared.http.put.mock.calls
      .filter(([url]) => String(url).includes("/v1.0/card/instances"))
      .map(([, body]) => body as Record<string, any>);
    expect(instanceUpdateBodies.length).toBeGreaterThan(0);
    expect(instanceUpdateBodies.every((body) => body.cardUpdateOptions?.updatePrivateDataByKey !== true)).toBe(true);
  });
});
