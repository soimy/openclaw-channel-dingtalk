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


async function execute(params: unknown) {
  return withDingTalkQuestionContext(context, () => factory().execute("manage", params));
}

describe("independent targeted collections", () => {
  it("keeps multiple targeted forms and an ordinary form independent", async () => {
    const ordinary = await send();
    const first = await send(group);
    const second = await send(group);
    expect(state(ordinary)?.state).toBe("pending");
    await submit(first, "staff_B");
    await submit(second, "staff_B");
    await submit(first, "staff_C");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    expect(state(second)?.state).toBe("pending");
    await submit(second, "staff_C");
    expect(shared.inbound).toHaveBeenCalledTimes(2);
  });

  it("keeps in-memory-only collections independent", async () => {
    context.storePath = undefined;
    const first = await send(group);
    await send(group);
    await send();
    await submit(first, "staff_B");
    await submit(first, "staff_C");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, 1441, "30", null])("rejects invalid timeout %s before delivery", async value => {
    const result = await execute({ target: group, fields, timeoutMinutes: value });
    expect(result.details.status).toBe("failed");
    expect(shared.post).not.toHaveBeenCalled();
  });

  it("rejects custom timeouts for legacy forms", async () => {
    expect((await execute({ fields, timeoutMinutes: 30 })).details.status).toBe("failed");
    expect(shared.post).not.toHaveBeenCalled();
  });

  it("honors a longer deadline across ordinary chat and expires once", async () => {
    vi.useFakeTimers();
    const result = await execute({ target: group, fields, timeoutMinutes: 30 });
    expect(state(result)?.expiresAt).toBe(Date.now() + 30 * 60_000);
    await submit(result, "staff_B");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    invalidateAskUserQuestionsForScope({ storePath: context.storePath!, accountId: "main",
      questionScopeKey: context.questionScopeKey!, reason: "superseded_by_message" });
    expect(state(result)?.state).toBe("pending");
    expect(shared.inbound).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    expect(response().status).toBe("expired");
    expect(response().responses[1].status).toBe("missing");
    await submit(result, "staff_C");
    expect(shared.inbound).toHaveBeenCalledTimes(1);
  });

  it("ends a long collection early when everyone responds", async () => {
    vi.useFakeTimers();
    const result = await execute({ target: group, fields, timeoutMinutes: 1440 });
    await submit(result, "staff_B");
    await submit(result, "staff_C");
    await vi.advanceTimersByTimeAsync(1440 * 60_000);
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    expect(response().status).toBe("submitted");
  });

  it("lists owned collections and cancels only the selected one with partial results", async () => {
    vi.useFakeTimers();
    const first = await send(group);
    const second = await send(group);
    await submit(first, "staff_B", { form: { reason: "partial" } });
    const listed = await execute({ action: "list" });
    expect((listed.details as any).collections).toHaveLength(2);
    const cancelled = await execute({ action: "cancel", questionId: first.details.questionId });
    expect(cancelled.details.status).toBe("cancelled");
    expect((cancelled.details as any).result).toContain("partial");
    expect(state(first)?.terminalReason).toBe("cancelled");
    expect(state(second)?.state).toBe("pending");
    expect((await execute({ action: "cancel", questionId: first.details.questionId })).details.status).toBe("failed");
    await submit(first, "staff_C");
    expect(shared.inbound).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(shared.inbound).toHaveBeenCalledTimes(1);
    expect(response().question_id).toBe(second.details.questionId);
  });

  it.each(["owner", "account", "conversation", "agent"])("rejects management from another %s", async mismatch => {
    const result = await send(group);
    if (mismatch === "owner") context.data = { ...context.data, senderStaffId: "staff_C" };
    if (mismatch === "account") context.accountId = "other";
    if (mismatch === "conversation") context.data = { ...context.data, conversationId: "other" };
    if (mismatch === "agent") context.resolvedRoute = { ...context.resolvedRoute!, agentId: "other" };
    expect((await execute({ action: "list" })).details).toMatchObject({ collections: [] });
    expect((await execute({ action: "cancel", questionId: result.details.questionId })).details.status).toBe("failed");
    expect(shared.update).not.toHaveBeenCalled();
  });

  it("does not cancel a legacy form through collection management", async () => {
    const result = await send();
    expect((await execute({ action: "cancel", questionId: result.details.questionId })).details.status).toBe("failed");
    expect((await execute({ action: "list" })).details).toMatchObject({ collections: [] });
  });

  it("serializes an in-flight progress update before initiator cancellation", async () => {
    const result = await send(group);
    let release!: () => void;
    shared.update.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = submit(result, "staff_B");
    await vi.waitFor(() => expect(shared.update).toHaveBeenCalledTimes(1));
    const cancel = execute({ action: "cancel", questionId: result.details.questionId });
    await submit(result, "staff_C");
    release();
    await Promise.all([first, cancel]);
    expect(shared.update.mock.calls[1][1].card_status).toBe("cancelled");
    expect(shared.inbound).not.toHaveBeenCalled();
  });
});
