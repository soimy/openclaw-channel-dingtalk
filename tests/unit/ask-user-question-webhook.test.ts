import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ post: vi.fn(), update: vi.fn(), inbound: vi.fn() }));
vi.mock("../../src/platform/auth", () => ({ getAccessToken: vi.fn(async () => "token") }));
vi.mock("../../src/shared/http-client", () => ({ default: { post: shared.post } }));
vi.mock("../../src/card/card-callback-service", () => ({ updateCardVariables: shared.update }));
vi.mock("../../src/gateway/inbound-handler", () => ({ handleDingTalkMessage: shared.inbound }));

import {
  clearPendingQuestionsForTest,
  handleDingTalkAskUserCardCallback,
  registerDingTalkAskUserQuestionTool,
} from "../../src/card/ask-user-question";
import {
  withDingTalkQuestionContext,
  type DingTalkQuestionContext,
} from "../../src/card/ask-user-question-context";

type Result = { details: { status: string; questionId: string; outTrackId: string } };
type Tool = { execute: (id: string, params: unknown) => Promise<Result> };
const group = { type: "group", id: "cid_Target", respondentUserIds: ["staff_B", "staff_C"] };
const fields = [{ name: "reason", label: "原因", type: "TEXT" }];
let directory: string;
let context: DingTalkQuestionContext;
let factory: () => Tool;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-target-"));
  context = {
    cfg: {} as any,
    accountId: "main",
    storePath: path.join(directory, "sessions.json"),
    questionScopeKey: "main:origin:staff_A",
    data: {
      msgId: "origin_msg",
      msgtype: "text",
      createAt: Date.now(),
      text: { content: "collect" },
      conversationType: "1",
      conversationId: "origin_chat",
      senderId: "sender_A",
      senderStaffId: "staff_A",
      chatbotUserId: "bot",
      sessionWebhook: "https://example.com/origin",
    },
    sessionWebhook: "https://example.com/origin",
    dingtalkConfig: { clientId: "client", clientSecret: "secret" } as any,
    resolvedRoute: {
      agentId: "agent_A",
      sessionKey: "origin_session",
      mainSessionKey: "origin_main",
    },
    continuationSubAgentOptions: { agentId: "agent_A" } as any,
    onQuestionCardSent: vi.fn(async () => true),
  };
  shared.post.mockResolvedValue({
    status: 200,
    data: { result: { deliverResults: [{ success: true }] } },
  });
  shared.update.mockResolvedValue(undefined);
  shared.inbound.mockResolvedValue(undefined);
  registerDingTalkAskUserQuestionTool({
    registerTool: (fn: any) => {
      factory = () => fn({});
    },
    logger: {},
  } as any);
});

afterEach(() => {
  clearPendingQuestionsForTest();
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function send(target?: unknown) {
  return withDingTalkQuestionContext(context, () =>
    factory().execute("call", {
      title: "收集原因",
      fields,
      ...(target === undefined ? {} : { target }),
    }),
  );
}

async function submit(
  result: Result,
  user: string | undefined,
  params: unknown = { form: { reason: "answer" } },
  accountId = "main",
) {
  const handled = await handleDingTalkAskUserCardCallback({
    payload: {
      outTrackId: result.details.outTrackId,
      content: JSON.stringify({
        cardPrivateData: { actionIds: [result.details.questionId], params },
      }),
    },
    cfg: context.cfg,
    accountId,
    storePath: context.storePath,
    config: context.dingtalkConfig,
    clickerUserId: user,
  });
  await Promise.resolve();
  return handled;
}

describe("targeted form webhook lifetime", () => {
  it.each(["1", "2"])(
    "preserves original routing and expiry for origin type %s after a long collection",
    async (conversationType) => {
      vi.useFakeTimers();
      const start = Date.now();
      context.data.conversationType = conversationType;
      context.data.conversationId = conversationType === "1" ? "cid_OriginDM" : "cid_OriginGroup";
      context.data.sessionWebhookExpiredTime = start + 60 * 60_000;
      const result = await withDingTalkQuestionContext(context, () =>
        factory().execute("call", {
          fields,
          target: { type: "user", id: "staff_B" },
          timeoutMinutes: 180,
        }),
      );
      await vi.advanceTimersByTimeAsync(61 * 60_000);
      await submit(result, "staff_B");
      expect(shared.inbound).toHaveBeenCalledOnce();
      expect(shared.inbound.mock.calls[0][0]).toMatchObject({
        replySessionWebhookExpiresAt: start + 60 * 60_000,
        data: {
          conversationType,
          conversationId: context.data.conversationId,
          senderStaffId: "staff_A",
        },
        routeOverride: context.resolvedRoute,
      });
    },
  );

  it("also preserves expiry on timeout after the webhook lifetime", async () => {
    vi.useFakeTimers();
    context.data.sessionWebhookExpiredTime = Date.now() + 60 * 60_000;
    await withDingTalkQuestionContext(context, () =>
      factory().execute("call", {
        fields,
        target: group,
        timeoutMinutes: 120,
      }),
    );
    await vi.advanceTimersByTimeAsync(120 * 60_000);
    expect(shared.inbound).toHaveBeenCalledOnce();
    expect(shared.inbound.mock.calls[0][0].replySessionWebhookExpiresAt).toBe(
      context.data.sessionWebhookExpiredTime,
    );
    expect(shared.inbound.mock.calls[0][0].data.text.content).toContain('"status":"expired"');
  });

  it("uses proactive delivery when a targeted form has no known webhook expiry", async () => {
    const result = await send({ type: "user", id: "staff_B" });
    await submit(result, "staff_B");
    expect(shared.inbound.mock.calls[0][0].replySessionWebhookExpiresAt).toBe(0);
  });

  it("does not change the original current-user question path", async () => {
    const result = await send();
    await submit(result, "staff_A");
    expect(shared.inbound.mock.calls[0][0]).not.toHaveProperty("replySessionWebhookExpiresAt");
    expect(shared.inbound.mock.calls[0][0].sessionWebhook).toBe(context.sessionWebhook);
  });
});
