import { describe, expect, it } from "vitest";
import {
  buildQuestionForm,
  buildQuestionFormFromFields,
  getAskUserQuestionSchemaForTest,
  parseAskUserCardCallback,
} from "../../src/card/ask-user-question";
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


