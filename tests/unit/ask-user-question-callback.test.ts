import { afterEach, describe, expect, it, vi } from "vitest";
import { updateCardVariables } from "../../src/card-callback-service";
import {
  clearPendingQuestionsForTest,
  handleDingTalkAskUserCardCallback,
  registerPendingQuestionForTest,
} from "../../src/card/ask-user-question";
import { handleDingTalkMessage } from "../../src/inbound-handler";

vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn(async () => "access-token"),
}));

vi.mock("../../src/card-callback-service", () => ({
  updateCardVariables: vi.fn(async () => undefined),
}));

vi.mock("../../src/inbound-handler", () => ({
  handleDingTalkMessage: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.useRealTimers();
  clearPendingQuestionsForTest();
  vi.clearAllMocks();
});

describe("handleDingTalkAskUserCardCallback submit and ownership", () => {
  it("supersedes all earlier pending questions in the same user scope", async () => {
    const baseData = {
      msgId: "msg_multi",
      msgtype: "text",
      createAt: Date.now(),
      text: { content: "ask" },
      conversationType: "1",
      conversationId: "conv_1",
      senderId: "sender_1",
      senderStaffId: "staff_1",
      chatbotUserId: "bot_1",
      sessionWebhook: "https://example.com/webhook",
    };
    const questionScopeKey = "default:session_1:staff_1";
    const otherUserQuestionScopeKey = "default:session_1:staff_2";

    registerPendingQuestionForTest({
      cfg: {} as any,
      accountId: "default",
      data: baseData,
      sessionWebhook: "https://example.com/webhook",
      dingtalkConfig: {} as any,
      questionScopeKey,
      questionId: "q_old_1",
      outTrackId: "ask_old_1",
      title: "旧问题 1",
      questions: [
        {
          fieldName: "answer_0",
          title: "确认",
          options: [{ value: "ok", text: "确定" }],
          multiSelect: false,
        },
      ],
    });
    registerPendingQuestionForTest({
      cfg: {} as any,
      accountId: "default",
      data: {
        ...baseData,
        msgId: "msg_other_user",
        senderId: "sender_2",
        senderStaffId: "staff_2",
      },
      sessionWebhook: "https://example.com/webhook",
      dingtalkConfig: {} as any,
      questionScopeKey: otherUserQuestionScopeKey,
      questionId: "q_other_user",
      outTrackId: "ask_other_user",
      title: "其他用户的问题",
      questions: [
        {
          fieldName: "answer_0",
          title: "确认",
          options: [{ value: "ok", text: "确定" }],
          multiSelect: false,
        },
      ],
    });
    registerPendingQuestionForTest({
      cfg: {} as any,
      accountId: "default",
      data: baseData,
      sessionWebhook: "https://example.com/webhook",
      dingtalkConfig: {} as any,
      questionScopeKey,
      questionId: "q_old_2",
      outTrackId: "ask_old_2",
      title: "旧问题 2",
      questions: [
        {
          fieldName: "answer_0",
          title: "确认",
          options: [{ value: "ok", text: "确定" }],
          multiSelect: false,
        },
      ],
    });
    registerPendingQuestionForTest({
      cfg: {} as any,
      accountId: "default",
      data: baseData,
      sessionWebhook: "https://example.com/webhook",
      dingtalkConfig: {} as any,
      questionScopeKey,
      questionId: "q_new",
      outTrackId: "ask_new",
      title: "新问题",
      questions: [
        {
          fieldName: "answer_0",
          title: "确认",
          options: [{ value: "ok", text: "确定" }],
          multiSelect: false,
        },
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(updateCardVariables).toHaveBeenCalledWith(
      "ask_old_1",
      expect.objectContaining({
        card_status: "expired",
        question_desc: "已有新的问题卡片，请回答最新卡片。",
        form_btn_text: "已失效",
      }),
      "access-token",
      {},
    );
    expect(updateCardVariables).toHaveBeenCalledWith(
      "ask_old_2",
      expect.objectContaining({
        card_status: "expired",
        question_desc: "已有新的问题卡片，请回答最新卡片。",
        form_btn_text: "已失效",
      }),
      "access-token",
      {},
    );
    expect(updateCardVariables).not.toHaveBeenCalledWith(
      "ask_other_user",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    vi.clearAllMocks();

    await expect(
      handleDingTalkAskUserCardCallback({
        payload: {
          outTrackId: "ask_old_1",
          content: JSON.stringify({
            cardPrivateData: {
              actionIds: ["q_old_1"],
              params: { form: { answer_0: "ok" } },
            },
          }),
        },
        cfg: {} as any,
        accountId: "default",
        config: {} as any,
        clickerUserId: "staff_1",
      }),
    ).resolves.toEqual({ handled: true });
    await expect(
      handleDingTalkAskUserCardCallback({
        payload: {
          outTrackId: "ask_old_2",
          content: JSON.stringify({
            cardPrivateData: {
              actionIds: ["q_old_2"],
              params: { form: { answer_0: "ok" } },
            },
          }),
        },
        cfg: {} as any,
        accountId: "default",
        config: {} as any,
        clickerUserId: "staff_1",
      }),
    ).resolves.toEqual({ handled: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(handleDingTalkMessage).not.toHaveBeenCalled();

    await expect(
      handleDingTalkAskUserCardCallback({
        payload: {
          outTrackId: "ask_new",
          content: JSON.stringify({
            cardPrivateData: {
              actionIds: ["q_new"],
              params: { form: { answer_0: "ok" } },
            },
          }),
        },
        cfg: {} as any,
        accountId: "default",
        config: {} as any,
        clickerUserId: "staff_1",
      }),
    ).resolves.toEqual({ handled: true });
    expect(handleDingTalkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        inboundOrigin: "ask-user",
        data: expect.objectContaining({
          msgId: "msg_multi:ask-user-submitted:q_new",
          text: {
            content: [
              "用户回答了交互卡片:",
              "- question_id: q_new",
              "- question_title: 新问题",
              "- status: submitted",
              "- answers:",
              "  - 确认: 确定",
            ].join("\n"),
          },
        }),
      }),
    );
  });

  it("rejects submissions from users other than the card owner", async () => {
    registerPendingQuestionForTest({
      cfg: {} as any,
      accountId: "default",
      data: {
        msgId: "msg_owner",
        msgtype: "text",
        createAt: Date.now(),
        text: { content: "ask" },
        conversationType: "2",
        conversationId: "group_1",
        senderId: "sender_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://example.com/webhook",
      },
      sessionWebhook: "https://example.com/webhook",
      dingtalkConfig: {} as any,
      questionId: "q_owner",
      outTrackId: "ask_owner",
      title: "补充执行参数",
      questions: [
        {
          fieldName: "answer_0",
          title: "确认",
          options: [{ value: "ok", text: "确定" }],
          multiSelect: false,
        },
      ],
    });

    const result = await handleDingTalkAskUserCardCallback({
      payload: {
        outTrackId: "ask_owner",
        content: JSON.stringify({
          cardPrivateData: {
            actionIds: ["q_owner"],
            params: {
              form: {
                answer_0: "ok",
              },
            },
          },
        }),
      },
      cfg: {} as any,
      accountId: "default",
      config: {} as any,
      clickerUserId: "staff_2",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toEqual({ handled: true });
    expect(updateCardVariables).not.toHaveBeenCalled();
    expect(handleDingTalkMessage).not.toHaveBeenCalled();
  });


});

