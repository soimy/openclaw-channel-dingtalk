import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  axiosPost: vi.fn(async () => ({
    status: 200,
    data: { result: { deliverResults: [{ success: true }] } },
  })),
}));

vi.mock("../../src/platform/auth", () => ({
  getAccessToken: vi.fn(async () => "access-token"),
}));

vi.mock("../../src/card/card-callback-service", () => ({
  updateCardVariables: vi.fn(async () => undefined),
}));

vi.mock("../../src/gateway/inbound-handler", () => ({
  handleDingTalkMessage: vi.fn(async () => undefined),
}));

vi.mock("../../src/shared/http-client", () => ({
  default: { post: shared.axiosPost },
}));

import {
  clearPendingQuestionsForTest,
  registerDingTalkAskUserQuestionTool,
} from "../../src/card/ask-user-question";
import {
  type DingTalkQuestionContext,
  withDingTalkQuestionContext,
  withDingTalkQuestionToolRun,
  getDingTalkQuestionToolContext,
  resolveDingTalkQuestionToolContext,
} from "../../src/card/ask-user-question-context";

type AskUserTool = {
  execute: (toolCallId: string, params: unknown) => Promise<any>;
};

type AskUserToolFactory = (context: OpenClawPluginToolContext) => AskUserTool;

function questionContext(params: {
  conversationType: "1" | "2";
  conversationId: string;
  senderId: string;
  sessionKey: string;
}): DingTalkQuestionContext {
  return {
    cfg: {} as any,
    accountId: "main",
    data: {
      msgId: `msg_${params.conversationId}`,
      msgtype: "text",
      createAt: Date.now(),
      text: { content: "ask" },
      conversationType: params.conversationType,
      conversationId: params.conversationId,
      senderId: params.senderId,
      chatbotUserId: "bot_1",
      sessionWebhook: "https://example.com/webhook",
    },
    sessionWebhook: "https://example.com/webhook",
    dingtalkConfig: {
      clientId: "client",
      clientSecret: "secret",
      robotCode: "robot",
    } as any,
    resolvedRoute: {
      agentId: "main",
      sessionKey: params.sessionKey,
      mainSessionKey: params.sessionKey,
    },
    questionScopeKey: `main:${params.sessionKey}:${params.senderId}`,
    onQuestionCardSent: async () => true,
  };
}

function registerToolFactory(): {
  factory: AskUserToolFactory;
  options: unknown;
} {
  let factory: AskUserToolFactory | undefined;
  let options: unknown;
  registerDingTalkAskUserQuestionTool({
    registerTool: (registered: unknown, registeredOptions: unknown) => {
      factory = registered as AskUserToolFactory;
      options = registeredOptions;
    },
    logger: {},
  } as any);
  return { factory: factory!, options };
}

const QUESTION_PARAMS = {
  questions: [
    {
      question: "是否继续？",
      header: "确认",
      options: [
        { label: "继续", value: "yes" },
        { label: "取消", value: "no" },
      ],
    },
  ],
};

describe("Ask User session-bound tool context", () => {
  beforeEach(() => {
    shared.axiosPost.mockClear();
  });

  afterEach(() => {
    clearPendingQuestionsForTest();
  });

  it("delivers to the current group session even when ambient async context is a direct chat", async () => {
    const directContext = questionContext({
      conversationType: "1",
      conversationId: "direct_conversation",
      senderId: "direct_user",
      sessionKey: "agent:main:dingtalk:direct:direct_user",
    });
    const groupContext = questionContext({
      conversationType: "2",
      conversationId: "group_conversation",
      senderId: "group_user",
      sessionKey: "agent:main:dingtalk:group:group_conversation",
    });

    const registered = registerToolFactory();
    const groupTool = await withDingTalkQuestionContext(groupContext, async () =>
      registered.factory({
        sessionKey: "agent:main:dingtalk:group:group_conversation",
      }),
    );

    await withDingTalkQuestionContext(directContext, () =>
      groupTool.execute("tool_group", QUESTION_PARAMS),
    );

    expect(registered.options).toEqual({ name: "dingtalk_ask_user_question" });
    expect(shared.axiosPost).toHaveBeenCalledTimes(1);
    expect(shared.axiosPost.mock.calls[0]?.[1]).toMatchObject({
      openSpaceId: "dtv1.card//IM_GROUP.group_conversation",
      imGroupOpenDeliverModel: {
        robotCode: "client",
      },
    });
  });

  it("fails closed when the runtime session has no bound DingTalk context", async () => {
    const staleDirectContext = questionContext({
      conversationType: "1",
      conversationId: "direct_conversation",
      senderId: "direct_user",
      sessionKey: "agent:main:dingtalk:direct:direct_user",
    });

    const { factory } = registerToolFactory();
    const unboundTool = await withDingTalkQuestionContext(staleDirectContext, async () =>
      factory({ sessionKey: "agent:main:cli:unbound" }),
    );
    const result = await unboundTool.execute("tool_unbound", QUESTION_PARAMS);

    expect(result.details).toEqual({
      status: "failed",
      error: "dingtalk_ask_user_question can only be used in a DingTalk message context",
    });
    expect(shared.axiosPost).not.toHaveBeenCalled();
  });

  it("accepts the host's isolated DM policy key while preserving the main transcript route", async () => {
    const context = questionContext({
      conversationType: "1",
      conversationId: "dm",
      senderId: "original_id",
      sessionKey: "agent:main:main",
    });
    context.data.senderStaffId = "staff_id";
    const { factory } = registerToolFactory();
    const tool = await withDingTalkQuestionContext(context, async () =>
      factory({
        sessionKey: "agent:main:dingtalk:main:direct:staff_id",
        messageChannel: "dingtalk",
        agentAccountId: "main",
        requesterSenderId: "staff_id",
      }),
    );
    await tool.execute("policy_alias", QUESTION_PARAMS);
    expect(shared.axiosPost).toHaveBeenCalledTimes(1);
    expect(shared.axiosPost.mock.calls[0]?.[1]).toMatchObject({
      openSpaceId: "dtv1.card//IM_ROBOT.staff_id",
    });
    expect(context.resolvedRoute?.sessionKey).toBe("agent:main:main");
  });

  it.each([
    { messageChannel: "telegram" },
    { messageChannel: undefined },
    { agentAccountId: "other" },
    { agentAccountId: undefined },
    { requesterSenderId: "other_user" },
    { requesterSenderId: undefined },
    { sessionKey: "agent:main:dingtalk:main:direct:other_user" },
    { sessionKey: "agent:other:dingtalk:main:direct:direct_user" },
  ])("rejects a policy alias with mismatched or missing trusted identity: %j", async (override) => {
    const context = questionContext({
      conversationType: "1",
      conversationId: "dm",
      senderId: "direct_user",
      sessionKey: "agent:main:main",
    });
    const { factory } = registerToolFactory();
    const tool = await withDingTalkQuestionContext(context, async () =>
      factory({
        sessionKey: "agent:main:dingtalk:main:direct:direct_user",
        messageChannel: "dingtalk",
        agentAccountId: "main",
        requesterSenderId: "direct_user",
        ...override,
      }),
    );
    expect((await tool.execute("bad_alias", QUESTION_PARAMS)).details.status).toBe("failed");
    expect(shared.axiosPost).not.toHaveBeenCalled();
  });

  it.each(["group", "named-session", "no-inbound"])(
    "does not use a DM policy alias for %s",
    async (kind) => {
      const context = questionContext({
        conversationType: kind === "group" ? "2" : "1",
        conversationId: "conversation",
        senderId: "direct_user",
        sessionKey: kind === "named-session" ? "agent:main:custom" : "agent:main:main",
      });
      context.resolvedRoute!.mainSessionKey = "agent:main:main";
      const { factory } = registerToolFactory();
      const create = async () =>
        factory({
          sessionKey: "agent:main:dingtalk:main:direct:direct_user",
          messageChannel: "dingtalk",
          agentAccountId: "main",
          requesterSenderId: "direct_user",
        });
      const tool =
        kind === "no-inbound" ? await create() : await withDingTalkQuestionContext(context, create);
      expect((await tool.execute("bad_scope", QUESTION_PARAMS)).details.status).toBe("failed");
      expect(shared.axiosPost).not.toHaveBeenCalled();
    },
  );

  it("rebinds a cached tool to the active message and rejects it after dispatch", async () => {
    const first = questionContext({
      conversationType: "1",
      conversationId: "dm",
      senderId: "user",
      sessionKey: "agent:main:main",
    });
    const second = {
      ...first,
      data: { ...first.data, msgId: "new-message" },
      onQuestionCardSent: vi.fn(async () => true),
    };
    first.onQuestionCardSent = vi.fn(async () => true);
    const trusted = {
      sessionKey: "agent:main:dingtalk:main:direct:user",
      messageChannel: "dingtalk",
      agentAccountId: "main",
      requesterSenderId: "user",
    };
    const { factory } = registerToolFactory();
    const cached = await withDingTalkQuestionContext(first, () =>
      withDingTalkQuestionToolRun(first, async () => factory(trusted)),
    );
    expect((await cached.execute("ended", QUESTION_PARAMS)).details.status).toBe("failed");
    await withDingTalkQuestionContext(second, () =>
      withDingTalkQuestionToolRun(second, async () => {
        expect(resolveDingTalkQuestionToolContext(trusted, first)).toBe(second);
        await cached.execute("next-message", QUESTION_PARAMS);
      }),
    );
    expect(first.onQuestionCardSent).not.toHaveBeenCalled();
    expect(second.onQuestionCardSent).toHaveBeenCalledOnce();
    expect((await cached.execute("ended-again", QUESTION_PARAMS)).details.status).toBe("failed");
    expect(shared.axiosPost).toHaveBeenCalledTimes(1);
  });

  it("does not rebind cached tools across senders or ambiguous concurrent turns", async () => {
    const first = questionContext({
      conversationType: "1",
      conversationId: "dm",
      senderId: "user",
      sessionKey: "agent:main:main",
    });
    const trusted = {
      sessionKey: "agent:main:dingtalk:main:direct:user",
      messageChannel: "dingtalk",
      agentAccountId: "main",
      requesterSenderId: "user",
    };
    const captured = await withDingTalkQuestionToolRun(first, async () => first);
    const other = { ...first, data: { ...first.data, senderId: "other" } };
    await withDingTalkQuestionToolRun(other, async () => {
      expect(resolveDingTalkQuestionToolContext(trusted, captured)).toBeUndefined();
    });
    const second = { ...first };
    const third = { ...first };
    await withDingTalkQuestionToolRun(second, () =>
      withDingTalkQuestionToolRun(third, async () => {
        expect(resolveDingTalkQuestionToolContext(trusted, captured)).toBeUndefined();
        expect(resolveDingTalkQuestionToolContext(trusted, second)).toBe(second);
      }),
    );
  });

  it("binds a tool prepared outside inbound scope only to a matching active turn, with failure cleanup", async () => {
    const context = questionContext({
      conversationType: "1",
      conversationId: "dm",
      senderId: "user",
      sessionKey: "agent:main:main",
    });
    const trusted = {
      sessionKey: "agent:main:dingtalk:main:direct:user",
      messageChannel: "dingtalk",
      agentAccountId: "main",
      requesterSenderId: "user",
    };
    expect(getDingTalkQuestionToolContext(trusted)).toBeUndefined();
    await expect(
      withDingTalkQuestionToolRun(context, async () => {
        expect(resolveDingTalkQuestionToolContext(trusted, undefined)).toBe(context);
        expect(
          resolveDingTalkQuestionToolContext({ ...trusted, agentAccountId: "other" }, undefined),
        ).toBeUndefined();
        throw new Error("dispatch failure");
      }),
    ).rejects.toThrow("dispatch failure");
    expect(resolveDingTalkQuestionToolContext(trusted, undefined)).toBeUndefined();
  });

  it("keeps concurrent runs isolated when they share the same session key", async () => {
    const sessionKey = "agent:main:dingtalk:group:shared_group";
    const firstCallback = vi.fn(async () => true);
    const secondCallback = vi.fn(async () => true);
    const firstContext = questionContext({
      conversationType: "2",
      conversationId: "shared_group",
      senderId: "first_user",
      sessionKey,
    });
    const secondContext = questionContext({
      conversationType: "2",
      conversationId: "shared_group",
      senderId: "second_user",
      sessionKey,
    });
    firstContext.onQuestionCardSent = firstCallback;
    secondContext.onQuestionCardSent = secondCallback;

    const { factory } = registerToolFactory();
    let releaseFirstFactory: (() => void) | undefined;
    const secondFactoryCompleted = new Promise<void>((resolve) => {
      releaseFirstFactory = resolve;
    });
    const firstToolPromise = withDingTalkQuestionContext(firstContext, async () => {
      await secondFactoryCompleted;
      return factory({ sessionKey });
    });
    const secondTool = await withDingTalkQuestionContext(secondContext, async () => {
      releaseFirstFactory?.();
      return factory({ sessionKey });
    });
    const firstTool = await firstToolPromise;

    await withDingTalkQuestionContext(secondContext, () =>
      firstTool.execute("tool_first", QUESTION_PARAMS),
    );

    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(secondCallback).not.toHaveBeenCalled();

    clearPendingQuestionsForTest();
    await withDingTalkQuestionContext(firstContext, () =>
      secondTool.execute("tool_second", QUESTION_PARAMS),
    );

    expect(secondCallback).toHaveBeenCalledTimes(1);
  });
});
