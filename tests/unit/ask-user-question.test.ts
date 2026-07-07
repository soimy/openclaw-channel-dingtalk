import { afterEach, describe, expect, it, vi } from "vitest";
import { updateCardVariables } from "../../src/card-callback-service";
import {
  clearPendingQuestionsForTest,
  buildQuestionFormFromFields,
  buildQuestionForm,
  getAskUserQuestionSchemaForTest,
  handleDingTalkAskUserCardCallback,
  parseAskUserCardCallback,
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

describe("AskUserQuestionSchema", () => {
  it("guides the assistant to provide a small question DSL instead of DingTalk form fields", () => {
    const schema = getAskUserQuestionSchemaForTest();
    const questionSchema = schema.properties.questions.items.properties;

    expect(schema.properties.questions.description).toContain("Lightweight blocking question DSL");
    expect(schema.properties.questions.description).toContain(
      "Do not use questions for complex forms",
    );
    expect(schema.properties.questions.description).toContain("Do not use for explanations");
    expect(schema.properties.fields.description).toContain("Advanced DingTalk form fields");
    expect(schema.properties.fields.description).toContain("top-level fields");
    expect(schema.properties.fields.description).toContain("Use one fields card");
    expect(schema.properties.fields.description).toContain("shaped as { fields }");
    expect(schema.properties.fields.description).toContain("Do not wrap fields inside form");
    expect(schema.properties.fields.description).toContain("{ value, text }");
    expect(schema.properties.fields.items.properties.type.enum).toContain("DATETIME");
    expect(schema.properties.fields.items.properties.type.enum).toContain("MULTI_CHECKBOX_GROUP");
    expect(schema.properties.fields.items.properties).not.toHaveProperty("format");
    expect(schema.properties.fields.items.properties.options.description).toContain(
      "Each option must be { value, text }",
    );
    expect(schema.properties.fields.items.properties.defautValue.description).toContain(
      "Compatibility alias",
    );
    expect(questionSchema.question.description).toBe("The question to ask the user");
    expect(questionSchema.header.description).toContain("Short label");
    expect(questionSchema.options.description).toContain("Leave empty ([]) for free-text input");
    expect(questionSchema.options.description).toContain("Use two options for confirmation");
    expect(questionSchema.multiSelect.description).toContain("ignored when options is empty");
  });
});

describe("buildQuestionFormFromFields", () => {
  it("accepts DingTalk form variable protocol fields", () => {
    const form = buildQuestionFormFromFields({
      title: "高级表单",
      description: "请补充执行参数",
      fields: [
        {
          name: "reason",
          label: "执行原因",
          type: "TEXT_AREA",
          required: true,
          minRows: 2,
          maxRows: 4,
        },
        {
          name: "priority",
          label: "优先级",
          type: "SELECT",
          required: true,
          options: [
            { value: "p0", text: "P0" },
            { value: "p1", text: "P1" },
          ],
        },
        {
          name: "notify",
          label: "完成后通知",
          type: "SWITCH",
          defaultValue: true,
        },
      ],
    });

    expect(form.title).toBe("高级表单");
    expect(form.desc).toBe("请补充执行参数");
    expect(form.fields).toEqual([
      {
        name: "reason",
        label: "执行原因",
        type: "TEXT_AREA",
        required: true,
        minRows: 2,
        maxRows: 4,
      },
      {
        name: "priority",
        label: "优先级",
        type: "SELECT",
        required: true,
        options: [
          { value: "p0", text: "P0" },
          { value: "p1", text: "P1" },
        ],
      },
      {
        name: "notify",
        label: "完成后通知",
        type: "SWITCH",
        defaultValue: true,
      },
    ]);
    expect(form.parsed).toEqual([
      { fieldName: "reason", title: "执行原因", options: [], multiSelect: false },
      {
        fieldName: "priority",
        title: "优先级",
        options: [
          { value: "p0", text: "P0" },
          { value: "p1", text: "P1" },
        ],
        multiSelect: false,
      },
      { fieldName: "notify", title: "完成后通知", options: [], multiSelect: false },
    ]);
  });

  it("preserves native date and time fields without requiring format", () => {
    const form = buildQuestionFormFromFields({
      title: "高级表单",
      fields: [
        {
          name: "exec_time",
          label: "执行时间",
          type: "TIME",
          required: true,
        },
        {
          name: "run_date",
          label: "执行日期",
          type: "DATE",
          required: true,
        },
      ],
    });

    expect(form.fields).toEqual([
      {
        name: "exec_time",
        label: "执行时间",
        type: "TIME",
        required: true,
      },
      {
        name: "run_date",
        label: "执行日期",
        type: "DATE",
        required: true,
      },
    ]);
  });
});

describe("buildQuestionForm", () => {
  it("maps the assistant question DSL to supported DingTalk form field types", () => {
    const form = buildQuestionForm([
      {
        question: "填写原因",
        header: "原因",
        options: [],
      },
      {
        question: "选择实例",
        header: "实例",
        options: [{ label: "mysql_odps", value: "400291853741" }],
      },
      {
        question: "选择多个实例",
        header: "多实例",
        multiSelect: true,
        options: [
          { label: "mysql_a", value: "1" },
          { label: "mysql_b", value: "2" },
        ],
      },
    ]);

    expect(form.fields).toEqual([
      {
        name: "answer_0",
        label: "原因",
        type: "TEXT",
        required: true,
        placeholder: "请输入回答",
      },
      {
        name: "answer_1",
        label: "实例",
        type: "CHECKBOX_GROUP",
        required: true,
        options: [{ value: "400291853741", text: "mysql_odps" }],
      },
      {
        name: "answer_2",
        label: "多实例",
        type: "MULTI_CHECKBOX_GROUP",
        required: true,
        options: [
          { value: "1", text: "mysql_a" },
          { value: "2", text: "mysql_b" },
        ],
      },
    ]);
  });
});

describe("parseAskUserCardCallback", () => {
  it("extracts form payload from DingTalk card callback content", () => {
    const parsed = parseAskUserCardCallback({
      outTrackId: "ask_1",
      content: JSON.stringify({
        cardPrivateData: {
          actionIds: ["q_single_001"],
          params: {
            form: {
              answer_0: "400291853741",
            },
          },
        },
      }),
    });

    expect(parsed).toEqual({
      outTrackId: "ask_1",
      actionId: "q_single_001",
      params: {
        form: {
          answer_0: "400291853741",
        },
      },
      hasBusinessPayload: true,
    });
  });

  it("recognizes cancel callbacks and ignores local form-state noise", () => {
    expect(
      parseAskUserCardCallback({
        outTrackId: "ask_2",
        content: JSON.stringify({
          cardPrivateData: {
            params: {
              user_cancel: true,
            },
          },
        }),
      }),
    ).toMatchObject({
      outTrackId: "ask_2",
      params: {
        user_cancel: true,
      },
      hasBusinessPayload: true,
    });

    expect(
      parseAskUserCardCallback({
        outTrackId: "ask_3",
        content: JSON.stringify({
          cardPrivateData: {
            params: {
              fromConfig: {
                fields: [],
              },
            },
          },
        }),
      }),
    ).toMatchObject({
      outTrackId: "ask_3",
      hasBusinessPayload: false,
    });
  });
});

describe("handleDingTalkAskUserCardCallback", () => {
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
    await new Promise((resolve) => setImmediate(resolve));
    expect(handleDingTalkMessage).toHaveBeenCalledWith(
      expect.objectContaining({
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
    await vi.runOnlyPendingTimersAsync();

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
