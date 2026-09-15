import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { getAskUserQuestionSchemaForTest } from "../../src/card/ask-user-question";

const validate = new Ajv({ strict: false }).compile(getAskUserQuestionSchemaForTest());
const fields = [{ name: "answer", label: "Answer", type: "TEXT" }];
const questions = [{ question: "Choose", header: "Choice", options: [] }];

describe("ask-user action-dependent schema", () => {
  it.each([
    {},
    { action: "create" },
    { action: "cancel" },
    { action: "cancel", questionId: "" },
    { action: "other" },
    { fields: [] },
    { questions: [] },
    { fields, questions },
    { action: "create", questionId: "q_existing" },
  ])("rejects invalid input %j before execution", (input) => {
    expect(validate(input)).toBe(false);
  });
  it.each([
    { fields },
    { questions },
    { action: "create", fields },
    { action: "create", questions },
    { action: "list" },
    { action: "cancel", questionId: "q_existing" },
  ])("accepts supported input %j", (input) => {
    expect(validate(input)).toBe(true);
  });
});
