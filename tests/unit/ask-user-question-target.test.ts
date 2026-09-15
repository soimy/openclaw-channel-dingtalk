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
  invalidateAskUserQuestionsForScope,
  recoverAskUserQuestionsForAccount,
  registerDingTalkAskUserQuestionTool,
} from "../../src/card/ask-user-question";
import {
  withDingTalkQuestionContext,
  type DingTalkQuestionContext,
} from "../../src/card/ask-user-question-context";
import { resolveAskUserQuestion } from "../../src/card/ask-user-question-store";
import { parseQuestionTarget } from "../../src/card/ask-user-question-target";

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

function response() {
  return JSON.parse(shared.inbound.mock.calls[0][0].data.text.content.split("\n")[1]);
}

function state(result: Result) {
  return resolveAskUserQuestion(
    { storePath: context.storePath!, accountId: "main" },
    { questionId: result.details.questionId },
  );
}

describe("targeted question delivery and collection", () => {
  it("delivers to another user and resumes only the initiator route with respondent attribution", async () => {
    const result = await send({ type: "user", id: "staff_B" });
    expect(result.details.status).toBe("pending");
    expect(shared.post.mock.calls[0][1]).toMatchObject({
      openSpaceId: "dtv1.card//IM_ROBOT.staff_B",
      userIdType: 1,
      imRobotOpenSpaceModel: { supportForward: false },
      callbackType: "STREAM",
    });
    await submit(result, "staff_A");
    expect(shared.inbound).not.toHaveBeenCalled();
    await submit(result, "staff_B");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    expect(shared.inbound.mock.calls[0][0]).toMatchObject({
      accountId: "main",
      data: { conversationId: "origin_chat", senderStaffId: "staff_A" },
      sessionWebhook: context.sessionWebhook,
      routeOverride: context.resolvedRoute,
      subAgentOptions: context.continuationSubAgentOptions,
      inboundOrigin: "ask-user",
    });
    expect(response().responses).toEqual([
      {
        respondent_user_id: "staff_B",
        status: "submitted",
        answers: [{ question: "原因", answer: "answer" }],
      },
    ]);
    expect(state(result)?.terminalReason).toBe("submitted");
  });

  it("collects all named group respondents once without publishing their answers on the card", async () => {
    const result = await send(group);
    expect(shared.post.mock.calls[0][1]).toMatchObject({
      openSpaceId: "dtv1.card//IM_GROUP.cid_Target",
      imGroupOpenSpaceModel: { supportForward: false },
    });
    await submit(result, "staff_B", { form: { reason: "private B" } });
    expect(shared.inbound).not.toHaveBeenCalled();
    expect(state(result)?.state).toBe("pending");
    await submit(result, "STAFF_B", { form: { reason: "overwrite attempt" } });
    await submit(result, "staff_C", { form: { reason: "private C" } });
    await submit(result, "staff_C");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    expect(response().responses.map((r: any) => r.answers[0].answer)).toEqual([
      "private B",
      "private C",
    ]);
    expect(JSON.stringify(shared.update.mock.calls)).not.toContain("private B");
    expect(JSON.stringify(shared.update.mock.calls)).not.toContain("private C");
  });

  it("rejects missing identity, outsiders, and callbacks from another bot account", async () => {
    const result = await send(group);
    await submit(result, undefined);
    await submit(result, "outsider");
    await submit(result, "staff_B", { form: { reason: "wrong bot" } }, "other");
    expect(shared.update).not.toHaveBeenCalled();
    expect(shared.inbound).not.toHaveBeenCalled();
    await submit(result, "staff_B");
    await submit(result, "staff_C");
    expect(response().responses[0].answers[0].answer).toBe("answer");
  });

  it("ignores malformed and non-business callbacks without consuming a respondent", async () => {
    const result = await send({ type: "user", id: "staff_B" });
    await submit(result, "staff_B", {});
    await submit(result, "staff_B", { form: "bad" });
    expect(shared.inbound).not.toHaveBeenCalled();
    await submit(result, "staff_B");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
  });

  it("records individual cancellation and empty submission without cancelling other respondents", async () => {
    const result = await send(group);
    await submit(result, "staff_B", { user_cancel: true });
    expect(shared.inbound).not.toHaveBeenCalled();
    await submit(result, "staff_C", { form: {} });
    expect(response().responses.map((r: any) => r.status)).toEqual(["cancelled", "empty"]);
  });

  it("handles concurrent callbacks and serializes progress before terminal updates", async () => {
    const result = await send(group);
    let release!: () => void;
    shared.update.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = submit(result, "staff_B");
    await vi.waitFor(() => expect(shared.update).toHaveBeenCalledTimes(1));
    const second = submit(result, "staff_C");
    const duplicate = submit(result, "staff_C");
    expect(shared.inbound).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second, duplicate]);
    expect(shared.update.mock.calls[1][1].card_status).toBe("submitted");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("preserves instructions while updating progress (cancel=%s)", async (cancel) => {
    const result = await withDingTalkQuestionContext(context, () =>
      factory().execute("call", {
        title: "收集原因",
        description: "请填写原因，并注明日期。",
        fields,
        target: { ...group, respondentUserIds: ["staff_B", "staff_C", "staff_D"] },
      }),
    );
    const initial = shared.post.mock.calls[0][1].cardData.cardParamMap;
    expect(initial.question_desc).toContain("请填写原因，并注明日期。");
    await submit(result, "staff_B", cancel ? { user_cancel: true } : { form: { reason: "private B" } });
    expect(shared.update.mock.calls[0][1]).toEqual({ form_btn_text: "1/3" });
    await submit(result, "staff_B");
    expect(shared.update).toHaveBeenCalledTimes(1);
    await submit(result, "staff_C", { form: { reason: "private C" } });
    expect(shared.update.mock.calls[1][1]).toEqual({ form_btn_text: "2/3" });
    expect(shared.inbound).not.toHaveBeenCalled();
    const rendered = { ...initial, ...shared.update.mock.calls[1][1] };
    expect(rendered.question_desc).toBe(initial.question_desc);
    expect(rendered.form).toBe(initial.form);
    await submit(result, "staff_D");
    expect(shared.update.mock.calls[2][1]).toMatchObject({ card_status: "submitted", form_btn_text: "已结束" });
    expect(shared.inbound).toHaveBeenCalledTimes(1);
  });

  it("returns partial responses and missing respondents at the persisted deadline", async () => {
    vi.useFakeTimers();
    const result = await send(group);
    await submit(result, "staff_B");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    expect(response()).toMatchObject({
      status: "expired",
      responses: [
        { respondent_user_id: "staff_B", status: "submitted" },
        { respondent_user_id: "staff_C", status: "missing" },
      ],
    });
    await submit(result, "staff_C");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
  });

  it("keeps a targeted card valid when a message arrives during delivery", async () => {
    let release!: () => void;
    shared.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 200, data: {} });
        }),
    );
    const pending = send(group);
    await vi.waitFor(() => expect(shared.post).toHaveBeenCalledTimes(1));
    invalidateAskUserQuestionsForScope({
      accountId: "main",
      storePath: context.storePath!,
      questionScopeKey: context.questionScopeKey!,
      reason: "superseded_by_message",
    });
    release();
    const result = await pending;
    expect(result.details.status).toBe("pending");
    await submit(result, "staff_B");
    await submit(result, "staff_C");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
  });

  it("keeps collecting after a failed progress update", async () => {
    const result = await send(group);
    shared.update.mockRejectedValueOnce(new Error("card update failed"));
    await submit(result, "staff_B");
    await submit(result, "staff_C");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    expect(response().responses).toHaveLength(2);
  });

  it("expires collections without a persistence store once", async () => {
    vi.useFakeTimers();
    context.storePath = undefined;
    const result = await send(group);
    await submit(result, "staff_B");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    await submit(result, "staff_C");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
  });

  it("does not lose the timeout result when lazy cleanup runs before the live timer", async () => {
    vi.useFakeTimers();
    const result = await send(group);
    await submit(result, "staff_B");
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    expect(state(result)?.terminalReason).toBe("expired");
    await submit(result, "staff_C");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    expect(response().responses[1].status).toBe("missing");
  });

  it("finishes only once when the last answer's card update crosses the deadline", async () => {
    vi.useFakeTimers();
    const result = await send({ type: "user", id: "staff_B" });
    let release!: () => void;
    shared.update.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = submit(result, "staff_B");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    release();
    await pending;
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    expect(response().status).toBe("submitted");
  });

  it("keeps default current-user authorization and delivery unchanged", async () => {
    const result = await send();
    expect(shared.post.mock.calls[0][1]).toMatchObject({
      openSpaceId: "dtv1.card//IM_ROBOT.staff_A",
      imRobotOpenSpaceModel: { supportForward: true },
    });
    await submit(result, "staff_B");
    expect(shared.inbound).not.toHaveBeenCalled();
    await submit(result, "staff_A");
    expect(shared.inbound.mock.calls[0][0].data.text.content).toContain("用户回答了交互卡片:");
  });

  it("preserves group origin when delivering to another group", async () => {
    context.data.conversationType = "2";
    const result = await send(group);
    await submit(result, "staff_B");
    await submit(result, "staff_C");
    expect(shared.inbound.mock.calls[0][0].data).toMatchObject({
      conversationType: "2",
      conversationId: "origin_chat",
    });
  });

  it("preserves a collection on a new initiator message", async () => {
    const result = await send(group);
    await submit(result, "staff_B");
    invalidateAskUserQuestionsForScope({
      accountId: "main",
      storePath: context.storePath!,
      questionScopeKey: context.questionScopeKey!,
      reason: "superseded_by_message",
    });
    await submit(result, "staff_C");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    expect(state(result)?.terminalReason).toBe("submitted");
  });

  it("preserves a collection alongside a new ordinary question in the same origin scope", async () => {
    const old = await send(group);
    await submit(old, "staff_B");
    await send();
    await submit(old, "staff_C");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    expect(state(old)?.terminalReason).toBe("submitted");
  });

  it("invalidates partial collections after restart without persisting answers or fabricating a continuation", async () => {
    const result = await send(group);
    await submit(result, "staff_B", { form: { reason: "private response" } });
    clearPendingQuestionsForTest();
    await recoverAskUserQuestionsForAccount({
      accountId: "main",
      storePath: context.storePath!,
      config: context.dingtalkConfig,
    });
    await submit(result, "staff_C");
    expect(shared.inbound).not.toHaveBeenCalled();
    expect(state(result)?.terminalReason).toBe("restart_invalidated");
    expect(JSON.stringify(state(result))).not.toContain("private response");
  });

  it("closes the card when pausing the initiating run fails", async () => {
    context.onQuestionCardSent = async () => false;
    const result = await send(group);
    expect(result.details.status).toBe("failed");
    await submit(result, "staff_B");
    expect(shared.inbound).not.toHaveBeenCalled();
    expect(state(result)?.terminalReason).toBe("pause_failed");
  });

  it("reports delivery failures without pausing the run", async () => {
    shared.post.mockRejectedValueOnce(new Error("delivery error"));
    const result = await send(group);
    expect(result.details.status).toBe("failed");
    expect(context.onQuestionCardSent).not.toHaveBeenCalled();
  });

  it("marks continuation failure without allowing callback retries to duplicate the run", async () => {
    shared.inbound.mockRejectedValueOnce(new Error("dispatch error"));
    const result = await send({ type: "user", id: "staff_B" });
    await submit(result, "staff_B");
    await vi.waitFor(() => expect(state(result)?.terminalReason).toBe("dispatch_failed"));
    await submit(result, "staff_B");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    {},
    { type: "room", id: "x" },
    { type: "user", id: " " },
    { type: "user", id: "B", respondentUserIds: ["C"] },
    { type: "group", id: "g" },
    { ...group, respondentUserIds: [] },
    { ...group, respondentUserIds: ["B", "b"] },
    { ...group, respondentUserIds: ["B C"] },
    { ...group, respondentUserIds: Array.from({ length: 51 }, (_, i) => String(i)) },
    { ...group, public: true },
  ])("rejects invalid targets before delivery: %j", async (target) => {
    const result = await send(target);
    expect(result.details.status).toBe("failed");
    expect(shared.post).not.toHaveBeenCalled();
  });

  it("normalizes explicit IDs without guessing their type or changing case", () => {
    expect(parseQuestionTarget({ type: "user", id: " staff_B " })).toEqual({
      type: "user",
      id: "staff_B",
      respondentUserIds: ["staff_B"],
    });
  });
});
