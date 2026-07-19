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

describe("handleDingTalkAskUserCardCallback terminal actions", () => {
  it("updates cancelled cards and injects a cancellation message", async () => {
    registerPendingQuestionForTest({
      cfg: {} as any,
      accountId: "default",
      data: {
        msgId: "msg_cancel",
        msgtype: "text",
        createAt: Date.now(),
        text: { content: "ask" },
        conversationType: "1",
        conversationId: "conv_1",
        senderId: "sender_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://example.com/webhook",
      },
      sessionWebhook: "https://example.com/webhook",
      dingtalkConfig: {} as any,
      questionId: "q_cancel",
      outTrackId: "ask_cancel",
      title: "补充执行参数",
      questions: [
        {
          fieldName: "answer_0",
          title: "确认",
          options: [],
          multiSelect: false,
        },
      ],
    });

    const result = await handleDingTalkAskUserCardCallback({
      payload: {
        outTrackId: "ask_cancel",
        content: JSON.stringify({
          cardPrivateData: {
            actionIds: ["q_cancel"],
            params: {
              user_cancel: "true",
            },
          },
        }),
      },
      cfg: {} as any,
      accountId: "default",
      config: {} as any,
      clickerUserId: "staff_1",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toEqual({ handled: true });
    expect(updateCardVariables).toHaveBeenCalledWith(
      "ask_cancel",
      expect.objectContaining({
        card_status: "cancelled",
        question_desc: "已取消。",
        form_btn_text: "已取消",
      }),
      "access-token",
      {},
    );
    expect(handleDingTalkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          msgId: "msg_cancel:ask-user-cancelled:q_cancel",
          text: {
            content: [
              "用户取消了交互卡片:",
              "- question_id: q_cancel",
              "- question_title: 补充执行参数",
              "- status: cancelled",
            ].join("\n"),
          },
        }),
      }),
    );
  });

  it("expires pending questions and injects a timeout message", async () => {
    vi.useFakeTimers();
    registerPendingQuestionForTest({
      cfg: {} as any,
      accountId: "default",
      data: {
        msgId: "msg_expire",
        msgtype: "text",
        createAt: Date.now(),
        text: { content: "ask" },
        conversationType: "1",
        conversationId: "conv_1",
        senderId: "sender_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://example.com/webhook",
      },
      sessionWebhook: "https://example.com/webhook",
      dingtalkConfig: {} as any,
      questionId: "q_expire",
      outTrackId: "ask_expire",
      title: "补充执行参数",
      questions: [
        {
          fieldName: "answer_0",
          title: "确认",
          options: [],
          multiSelect: false,
        },
      ],
    });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(updateCardVariables).toHaveBeenCalledWith(
      "ask_expire",
      expect.objectContaining({
        card_status: "expired",
        question_desc: "问题已失效，请重新发起。",
        form_btn_text: "已失效",
      }),
      "access-token",
      {},
    );

    await expect(
      handleDingTalkAskUserCardCallback({
        payload: {
          outTrackId: "ask_expire",
          content: JSON.stringify({
            cardPrivateData: {
              actionIds: ["q_expire"],
              params: { form: { answer_0: "late" } },
            },
          }),
        },
        cfg: {} as any,
        accountId: "default",
        config: {} as any,
      }),
    ).resolves.toEqual({ handled: true });

    await vi.advanceTimersToNextTimerAsync();
    expect(handleDingTalkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          msgId: "msg_expire:ask-user-expired:q_expire",
          text: {
            content: [
              "交互卡片已超时:",
              "- question_id: q_expire",
              "- question_title: 补充执行参数",
              "- status: expired",
            ].join("\n"),
          },
        }),
      }),
    );
  });

  it("consumes optional fields submissions even when every answer is empty", async () => {
    registerPendingQuestionForTest({
      cfg: {} as any,
      accountId: "default",
      data: {
        msgId: "msg_1",
        msgtype: "text",
        createAt: Date.now(),
        text: { content: "ask" },
        conversationType: "1",
        conversationId: "conv_1",
        senderId: "sender_1",
        senderStaffId: "staff_1",
        chatbotUserId: "bot_1",
        sessionWebhook: "https://example.com/webhook",
      },
      sessionWebhook: "https://example.com/webhook",
      dingtalkConfig: {} as any,
      questionId: "q_empty",
      outTrackId: "ask_empty",
      title: "补充执行参数",
      questions: [
        {
          fieldName: "optional_reason",
          title: "执行原因",
          options: [],
          multiSelect: false,
        },
      ],
    });

    const result = await handleDingTalkAskUserCardCallback({
      payload: {
        outTrackId: "ask_empty",
        content: JSON.stringify({
          cardPrivateData: {
            actionIds: ["q_empty"],
            params: {
              form: {
                optional_reason: "",
              },
            },
          },
        }),
      },
      cfg: {} as any,
      accountId: "default",
      config: {} as any,
      clickerUserId: "staff_1",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toEqual({ handled: true });
    expect(updateCardVariables).toHaveBeenCalledWith(
      "ask_empty",
      expect.objectContaining({
        card_status: "submitted",
        question_desc: "已提交，未填写任何内容。",
        selected_text: "",
        selected_values: "[]",
        form_btn_text: "已提交",
      }),
      "access-token",
      {},
    );
    expect(handleDingTalkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          text: {
            content: [
              "用户提交了空交互卡片:",
              "- question_id: q_empty",
              "- question_title: 补充执行参数",
              "- status: submitted",
            ].join("\n"),
          },
        }),
      }),
    );

    await expect(
      handleDingTalkAskUserCardCallback({
        payload: {
          outTrackId: "ask_empty",
          content: JSON.stringify({
            cardPrivateData: {
              actionIds: ["q_empty"],
              params: { form: { optional_reason: "" } },
            },
          }),
        },
        cfg: {} as any,
        accountId: "default",
        config: {} as any,
      }),
    ).resolves.toEqual({ handled: true });
  });

});

