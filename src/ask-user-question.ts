import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getAccessToken } from "./auth";
import { updateCardVariables } from "./card-callback-service";
import { DINGTALK_ASK_USER_CARD_TEMPLATE } from "./card/card-template";
import { resolveRobotCode } from "./config";
import axios from "./http-client";
import { handleDingTalkMessage } from "./inbound-handler";
import type {
  DingTalkConfig,
  DingTalkInboundMessage,
  HandleDingTalkMessageParams,
  Logger,
} from "./types";
import { formatDingTalkErrorPayloadLog, getProxyBypassOption } from "./utils";

const DINGTALK_API = "https://api.dingtalk.com";
const PENDING_QUESTION_TTL_MS = 5 * 60 * 1000;
const TOOL_NAME = "dingtalk_ask_user_question";
const ANSWER_FIELD_PREFIX = "answer";

type AskUserOption = {
  label?: string;
  value?: string;
  description?: string;
};

type AskUserQuestion = {
  question?: string;
  header?: string;
  options?: AskUserOption[];
  multiSelect?: boolean;
};

type FormFieldType =
  | "TEXT"
  | "TEXT_ARRAY"
  | "TEXT_AREA"
  | "NUMBER"
  | "SELECT"
  | "MULTI_SELECT"
  | "DATE"
  | "TIME"
  | "DATETIME"
  | "CHECKBOX"
  | "SWITCH"
  | "CHECKBOX_GROUP"
  | "MULTI_CHECKBOX_GROUP";

type RawValue = string | number | boolean;
type SelectValue = { index: number; value: RawValue };
type MultiSelectValue = { index: number[]; value: RawValue[] };
type AnswerEntry = { question: string; answer: string };

type AskUserQuestionContext = {
  cfg: HandleDingTalkMessageParams["cfg"];
  accountId: string;
  data: DingTalkInboundMessage;
  sessionWebhook: string;
  log?: Logger;
  dingtalkConfig: DingTalkConfig;
};

type FormField = {
  name: string;
  label?: string;
  type: FormFieldType;
  hidden?: boolean;
  required?: boolean;
  requiredMsg?: string;
  readOnly?: boolean;
  placeholder?: string;
  format?: string;
  defaultValue?: RawValue | RawValue[] | SelectValue | MultiSelectValue;
  // DingTalk form protocol documentation also exposes this misspelled key.
  defautValue?: RawValue | RawValue[] | SelectValue | MultiSelectValue;
  options?: Array<{ value: string; text: string }>;
  minRows?: number;
  maxRows?: number;
  addText?: string;
};

type PendingQuestion = AskUserQuestionContext & {
  questionId: string;
  outTrackId: string;
  title: string;
  questions: Array<{
    fieldName: string;
    title: string;
    options: Array<{ value: string; text: string }>;
    multiSelect: boolean;
  }>;
  submitted: boolean;
  ttlTimer?: ReturnType<typeof setTimeout>;
};

type ParsedCardCallback = {
  outTrackId?: string;
  actionId?: string;
  params: Record<string, unknown>;
  hasBusinessPayload: boolean;
};

const questionContextStorage = new AsyncLocalStorage<AskUserQuestionContext>();
const pendingQuestionsByTrackId = new Map<string, PendingQuestion>();
const pendingQuestionsByQuestionId = new Map<string, PendingQuestion>();

function jsonToolResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export function withDingTalkQuestionContext<T>(
  context: AskUserQuestionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return questionContextStorage.run(context, fn);
}

function stringifyCardData(data: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return result;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOption(option: AskUserOption, index: number): { value: string; text: string } {
  const text = readString(option.label) ?? readString(option.description) ?? `选项 ${index + 1}`;
  const value = readString(option.value) ?? text;
  return { value, text };
}

function normalizeFormOption(option: unknown, index: number): { value: string; text: string } {
  const record = asRecord(option) ?? {};
  const value = readString(record.value) ?? `option_${index + 1}`;
  const text = readString(record.text) ?? value;
  return { value, text };
}

export function buildQuestionForm(questions: AskUserQuestion[]): {
  title: string;
  desc: string;
  fields: FormField[];
  parsed: PendingQuestion["questions"];
} {
  const parsed = questions.map((question, index) => {
    const options = Array.isArray(question.options)
      ? question.options.map((option, optionIndex) => normalizeOption(option, optionIndex))
      : [];
    const title =
      readString(question.header) ?? readString(question.question) ?? `问题 ${index + 1}`;
    const fieldName = `${ANSWER_FIELD_PREFIX}_${index}`;
    return {
      fieldName,
      title,
      options,
      multiSelect: Boolean(question.multiSelect),
    };
  });

  const fields: FormField[] = parsed.map((question) => {
    if (question.options.length === 0) {
      return {
        name: question.fieldName,
        label: question.title,
        type: "TEXT",
        required: true,
        placeholder: "请输入回答",
      };
    }
    return {
      name: question.fieldName,
      label: question.title,
      type: question.multiSelect ? "MULTI_CHECKBOX_GROUP" : "CHECKBOX_GROUP",
      required: true,
      options: question.options,
    };
  });

  const first = questions[0] ?? {};
  const title = readString(first.header) ?? readString(first.question) ?? "需要你的确认";
  const desc = readString(first.question) ?? title;
  return { title, desc, fields, parsed };
}

const FORM_FIELD_TYPES = new Set<FormFieldType>([
  "TEXT",
  "TEXT_ARRAY",
  "TEXT_AREA",
  "NUMBER",
  "SELECT",
  "MULTI_SELECT",
  "DATE",
  "TIME",
  "DATETIME",
  "CHECKBOX",
  "SWITCH",
  "CHECKBOX_GROUP",
  "MULTI_CHECKBOX_GROUP",
]);

export function buildQuestionFormFromFields(params: {
  title?: string;
  description?: string;
  fields: FormField[];
}): {
  title: string;
  desc: string;
  fields: FormField[];
  parsed: PendingQuestion["questions"];
} {
  const fields = params.fields.map((field, index) => {
    const name = readString(field.name) ?? `${ANSWER_FIELD_PREFIX}_${index}`;
    const rawType = readString(field.type);
    const type = rawType && FORM_FIELD_TYPES.has(rawType as FormFieldType) ? rawType : "TEXT";
    const label = readString(field.label) ?? name;
    const normalized: FormField = {
      ...field,
      name,
      label,
      type: type as FormFieldType,
    };
    if (Array.isArray(field.options)) {
      normalized.options = field.options.map((option, optionIndex) =>
        normalizeFormOption(option, optionIndex),
      );
    }
    return normalized;
  });
  const parsed = fields.map((field) => ({
    fieldName: field.name,
    title: readString(field.label) ?? field.name,
    options: Array.isArray(field.options) ? field.options : [],
    multiSelect: field.type === "MULTI_CHECKBOX_GROUP" || field.type === "MULTI_SELECT",
  }));
  const firstLabel = readString(fields[0]?.label);
  const title = readString(params.title) ?? firstLabel ?? "需要你的确认";
  const desc = readString(params.description) ?? title;
  return { title, desc, fields, parsed };
}

async function createAndDeliverQuestionCard(params: {
  config: DingTalkConfig;
  conversationId: string;
  isDirect: boolean;
  templateId: string;
  outTrackId: string;
  cardData: Record<string, unknown>;
  log?: Logger;
}): Promise<void> {
  const token = await getAccessToken(params.config, params.log);
  const isGroup = !params.isDirect;
  const body = {
    cardTemplateId: params.templateId,
    outTrackId: params.outTrackId,
    cardData: {
      cardParamMap: stringifyCardData(params.cardData),
    },
    callbackType: "STREAM",
    imGroupOpenSpaceModel: { supportForward: true },
    imRobotOpenSpaceModel: { supportForward: true },
    openSpaceId: isGroup
      ? `dtv1.card//IM_GROUP.${params.conversationId}`
      : `dtv1.card//IM_ROBOT.${params.conversationId}`,
    userIdType: 1,
    imGroupOpenDeliverModel: isGroup
      ? {
          robotCode: resolveRobotCode(params.config),
          extension: { dynamicSummary: "true" },
        }
      : undefined,
    imRobotOpenDeliverModel: !isGroup
      ? {
          spaceType: "IM_ROBOT",
          robotCode: resolveRobotCode(params.config),
          extension: { dynamicSummary: "true" },
        }
      : undefined,
  };

  params.log?.debug?.(
    `[DingTalk][AskUser] POST /v1.0/card/instances/createAndDeliver body=${JSON.stringify(body)}`,
  );
  const resp = await axios.post(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, body, {
    headers: {
      "x-acs-dingtalk-access-token": token,
      "Content-Type": "application/json",
    },
    ...getProxyBypassOption(params.config),
  });
  params.log?.debug?.(
    `[DingTalk][AskUser] createAndDeliver response status=${resp.status} data=${JSON.stringify(resp.data)}`,
  );
  const deliverResults = (
    resp.data?.result as
      | { deliverResults?: Array<{ success?: boolean; errorMsg?: string }> }
      | undefined
  )?.deliverResults;
  const failedDelivery = Array.isArray(deliverResults)
    ? deliverResults.find((item) => item?.success === false)
    : undefined;
  if (failedDelivery) {
    throw new Error(failedDelivery.errorMsg?.trim() || "DingTalk question card delivery failed");
  }
}

function storePendingQuestion(ctx: PendingQuestion): void {
  pendingQuestionsByTrackId.set(ctx.outTrackId, ctx);
  pendingQuestionsByQuestionId.set(ctx.questionId, ctx);
  ctx.ttlTimer = setTimeout(() => {
    if (!pendingQuestionsByTrackId.has(ctx.outTrackId) || ctx.submitted) {
      return;
    }
    consumePendingQuestion(ctx);
    void updateQuestionCard(ctx, {
      card_status: "expired",
      question_desc: "问题已失效，请重新发起。",
      form_btn_text: "已失效",
    }).catch((err) => {
      ctx.log?.warn?.(`[DingTalk][AskUser] Failed to expire question card: ${String(err)}`);
    });
  }, PENDING_QUESTION_TTL_MS);
}

function consumePendingQuestion(ctx: PendingQuestion): void {
  pendingQuestionsByTrackId.delete(ctx.outTrackId);
  pendingQuestionsByQuestionId.delete(ctx.questionId);
  if (ctx.ttlTimer) {
    clearTimeout(ctx.ttlTimer);
  }
}

async function updateQuestionCard(
  ctx: PendingQuestion,
  variables: Record<string, unknown>,
): Promise<void> {
  const token = await getAccessToken(ctx.dingtalkConfig, ctx.log);
  await updateCardVariables(ctx.outTrackId, variables, token, ctx.dingtalkConfig);
}

function parseEmbeddedJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function parseAskUserCardCallback(payload: unknown): ParsedCardCallback {
  const record = asRecord(payload) ?? {};
  const content = asRecord(parseEmbeddedJson(record.content));
  const value = asRecord(parseEmbeddedJson(record.value));
  const privateData =
    asRecord(content?.cardPrivateData) ??
    asRecord(parseEmbeddedJson(record.cardPrivateData)) ??
    asRecord(value?.cardPrivateData);
  const params =
    asRecord(privateData?.params) ?? asRecord(content?.params) ?? asRecord(value?.params) ?? {};
  const actionIds = privateData?.actionIds;
  const actionId =
    Array.isArray(actionIds) && typeof actionIds[0] === "string" ? actionIds[0] : undefined;
  const outTrackId =
    readString(record.outTrackId) ??
    readString(content?.outTrackId) ??
    readString(value?.outTrackId) ??
    readString(privateData?.outTrackId);
  return {
    outTrackId,
    actionId,
    params,
    hasBusinessPayload: Boolean(params.form || params.user_cancel || params.user_cacel),
  };
}

function readFormAnswer(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const raw = record.value;
    if (Array.isArray(raw)) {
      return raw.map((item) => String(item));
    }
    if (raw !== undefined && raw !== null) {
      return [String(raw)];
    }
  }
  return [String(value)];
}

function formatAnswerText(
  question: PendingQuestion["questions"][number],
  values: string[],
): string {
  if (values.length === 0) {
    return "";
  }
  const labels = values.map((value) => {
    return question.options.find((option) => option.value === value)?.text ?? value;
  });
  return labels.join(", ");
}

function buildAnswerMessage(ctx: PendingQuestion, answers: AnswerEntry[]): string {
  const lines = answers.map(({ question, answer }) => `- ${question}: ${answer}`);
  return `用户回答了你的问题:\n${lines.join("\n")}`;
}

async function injectAnswerSyntheticMessage(
  ctx: PendingQuestion,
  text: string,
  suffix: string,
): Promise<void> {
  const syntheticData: DingTalkInboundMessage = {
    msgId: `${ctx.data.msgId || ctx.outTrackId}:ask-user-${suffix}:${ctx.questionId}`,
    msgtype: "text",
    createAt: Date.now(),
    text: { content: text },
    conversationType: ctx.data.conversationType,
    conversationId: ctx.data.conversationId,
    conversationTitle: ctx.data.conversationTitle,
    senderId: ctx.data.senderId,
    senderStaffId: ctx.data.senderStaffId,
    senderNick: ctx.data.senderNick,
    chatbotUserId: ctx.data.chatbotUserId,
    sessionWebhook: ctx.data.sessionWebhook,
  };
  await withDingTalkQuestionContext(
    {
      cfg: ctx.cfg,
      accountId: ctx.accountId,
      data: syntheticData,
      sessionWebhook: ctx.sessionWebhook,
      log: ctx.log,
      dingtalkConfig: ctx.dingtalkConfig,
    },
    () =>
      handleDingTalkMessage({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        data: syntheticData,
        sessionWebhook: ctx.sessionWebhook,
        log: ctx.log,
        dingtalkConfig: ctx.dingtalkConfig,
      }),
  );
}

export async function handleDingTalkAskUserCardCallback(params: {
  payload: unknown;
  cfg: HandleDingTalkMessageParams["cfg"];
  accountId: string;
  config: DingTalkConfig;
  log?: Logger;
}): Promise<{ handled: boolean }> {
  const parsed = parseAskUserCardCallback(params.payload);
  const ctx =
    (parsed.outTrackId ? pendingQuestionsByTrackId.get(parsed.outTrackId) : undefined) ??
    (parsed.actionId ? pendingQuestionsByQuestionId.get(parsed.actionId) : undefined);
  if (!ctx) {
    return { handled: false };
  }

  if (!parsed.hasBusinessPayload) {
    params.log?.debug?.(
      `[DingTalk][AskUser] Ignoring non-business card callback outTrackId=${ctx.outTrackId}`,
    );
    return { handled: true };
  }

  if (ctx.submitted) {
    params.log?.debug?.(`[DingTalk][AskUser] Duplicate submit ignored question=${ctx.questionId}`);
    return { handled: true };
  }

  const isCancel = parsed.params.user_cancel === "true" || parsed.params.user_cacel === "true";
  ctx.submitted = true;

  if (isCancel) {
    await updateQuestionCard(ctx, {
      card_status: "cancelled",
      question_desc: "已取消。",
      form_btn_text: "已取消",
    });
    consumePendingQuestion(ctx);
    setImmediate(() => {
      void injectAnswerSyntheticMessage(ctx, `用户取消了问题: ${ctx.title}`, "cancelled").catch(
        (err) => {
          params.log?.error?.(
            `[DingTalk][AskUser] Failed to inject cancellation message: ${String(err)}`,
          );
        },
      );
    });
    return { handled: true };
  }

  const form = asRecord(parsed.params.form);
  if (!form) {
    ctx.submitted = false;
    params.log?.warn?.(
      `[DingTalk][AskUser] Missing form payload question=${ctx.questionId} params=${JSON.stringify(parsed.params)}`,
    );
    return { handled: true };
  }

  const answers: AnswerEntry[] = [];
  const selectedValues: string[] = [];
  for (const question of ctx.questions) {
    const values = readFormAnswer(form[question.fieldName]);
    selectedValues.push(...values);
    const answerText = formatAnswerText(question, values);
    if (answerText) {
      answers.push({ question: question.title, answer: answerText });
    }
  }

  if (answers.length === 0) {
    ctx.submitted = false;
    params.log?.warn?.(
      `[DingTalk][AskUser] Empty form answer question=${ctx.questionId} form=${JSON.stringify(form)}`,
    );
    return { handled: true };
  }

  const selectedText = answers.map(({ answer }) => answer).join(", ");
  await updateQuestionCard(ctx, {
    card_status: "submitted",
    question_desc: `已选择：${selectedText}。`,
    selected_text: selectedText,
    selected_values: JSON.stringify(selectedValues),
    form_btn_text: "已提交",
  });
  consumePendingQuestion(ctx);

  const message = buildAnswerMessage(ctx, answers);
  setImmediate(() => {
    void injectAnswerSyntheticMessage(ctx, message, "submitted").catch((err) => {
      params.log?.error?.(`[DingTalk][AskUser] Failed to inject answer message: ${String(err)}`);
    });
  });
  return { handled: true };
}

const AskUserQuestionSchema = {
  type: "object",
  additionalProperties: false,
  anyOf: [{ required: ["questions"] }, { required: ["fields"] }],
  properties: {
    title: {
      type: "string",
      description: "Card title. Used with fields; omit to use the first field label.",
    },
    description: {
      type: "string",
      description: "Short description shown above the form. Used with fields.",
    },
    questions: {
      type: "array",
      description:
        "Blocking question(s) that must be answered by the DingTalk user before the assistant can continue. Prefer exactly one question per card. " +
        "Do not use for explanations, status updates, capability introductions, or retrospective questions.",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "header", "options"],
        properties: {
          question: { type: "string", description: "The question to ask the user" },
          header: { type: "string", description: "Short label for the question (max 12 chars)" },
          options: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label"],
              properties: {
                label: { type: "string", description: "Display text for this option" },
                value: {
                  type: "string",
                  description: "Machine-readable value returned to the assistant; omit to use label",
                },
                description: {
                  type: "string",
                  description: "Explanation of what this option means",
                },
              },
            },
            description:
              "Available choices. Leave empty ([]) for free-text input — the user will see a text field instead. " +
              "Use two options for confirmation.",
          },
          multiSelect: {
            type: "boolean",
            description: "Whether multiple options can be selected (ignored when options is empty)",
          },
        },
      },
    },
    fields: {
      type: "array",
      description:
        "Advanced DingTalk form variable protocol. Use this when you need field types beyond the simple questions DSL, such as TEXT_AREA, NUMBER, SELECT, MULTI_SELECT, DATE, TIME, DATETIME, CHECKBOX, SWITCH, TEXT_ARRAY, CHECKBOX_GROUP, or MULTI_CHECKBOX_GROUP.",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "label", "type"],
        properties: {
          name: { type: "string", description: "Unique form field key" },
          label: { type: "string", description: "Field label shown to the user" },
          type: {
            type: "string",
            enum: [
              "TEXT",
              "TEXT_ARRAY",
              "TEXT_AREA",
              "NUMBER",
              "SELECT",
              "MULTI_SELECT",
              "DATE",
              "TIME",
              "DATETIME",
              "CHECKBOX",
              "SWITCH",
              "CHECKBOX_GROUP",
              "MULTI_CHECKBOX_GROUP",
            ],
            description: "DingTalk form field type",
          },
          hidden: { type: "boolean" },
          required: { type: "boolean" },
          requiredMsg: { type: "string" },
          readOnly: { type: "boolean" },
          placeholder: { type: "string" },
          format: { type: "string" },
          defaultValue: {},
          defautValue: {
            description:
              "Compatibility alias for DingTalk form protocol documentation typo; prefer defaultValue when possible.",
          },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["value", "text"],
              properties: {
                value: { type: "string" },
                text: { type: "string" },
              },
            },
          },
          minRows: { type: "number" },
          maxRows: { type: "number" },
          addText: { type: "string" },
        },
      },
    },
  },
} as const;

export function getAskUserQuestionSchemaForTest(): typeof AskUserQuestionSchema {
  return AskUserQuestionSchema;
}

export function registerDingTalkAskUserQuestionTool(api: OpenClawPluginApi): void {
  const registerTool = (api as OpenClawPluginApi & { registerTool?: OpenClawPluginApi["registerTool"] })
    .registerTool;
  if (typeof registerTool !== "function") {
    api.logger?.debug?.(`${TOOL_NAME}: registerTool unavailable, skipping tool registration`);
    return;
  }

  registerTool.call(api, {
    name: TOOL_NAME,
    label: "Ask User Question",
    description:
      "Ask the user a blocking question via an interactive DingTalk card when the current task cannot continue without the user's answer. " +
      "Returns immediately after sending the card. " +
      "The user's answer will arrive as a new message in the conversation. " +
      "Do NOT poll or re-call this tool — just wait for the response message. " +
      "For selection questions, provide options. " +
      "For free-text input, set options to an empty array. " +
      "Do not call this tool for normal explanations, why/how questions, capability introductions, or cases where you can answer directly.",
    parameters: AskUserQuestionSchema as any,
    async execute(_toolCallId: string, params: unknown) {
      const context = questionContextStorage.getStore();
      if (!context) {
        return jsonToolResult({
          status: "failed",
          error: "dingtalk_ask_user_question can only be used in a DingTalk message context",
        });
      }
      const templateId = DINGTALK_ASK_USER_CARD_TEMPLATE.templateId;

      const record = asRecord(params) ?? {};
      const rawFields = Array.isArray(record.fields) ? (record.fields as FormField[]) : [];
      const rawQuestions = Array.isArray(record.questions)
        ? (record.questions as AskUserQuestion[])
        : [];
      if (rawFields.length === 0 && rawQuestions.length === 0) {
        return jsonToolResult({
          status: "failed",
          error: "questions or fields must contain at least one item",
        });
      }

      const questionId = `q_${randomUUID()}`;
      const outTrackId = `ask_${randomUUID()}`;
      const { title, desc, fields, parsed } =
        rawFields.length > 0
          ? buildQuestionFormFromFields({
              title: readString(record.title),
              description: readString(record.description),
              fields: rawFields,
            })
          : buildQuestionForm(rawQuestions);
      const cardData = {
        question_id: questionId,
        question_title: title,
        question_desc: desc,
        card_status: "pending",
        form_btn_text: "提交",
        selected_text: "",
        selected_values: "[]",
        form: { fields },
      };

      try {
        await createAndDeliverQuestionCard({
          config: context.dingtalkConfig,
          conversationId:
            context.data.conversationType === "1"
              ? context.data.senderStaffId || context.data.senderId || context.data.conversationId
              : context.data.conversationId,
          isDirect: context.data.conversationType === "1",
          templateId,
          outTrackId,
          cardData,
          log: context.log,
        });
      } catch (err) {
        const detail = formatDingTalkErrorPayloadLog("ask_user_create", err, "[DingTalk]");
        return jsonToolResult({
          status: "failed",
          error: detail || (err instanceof Error ? err.message : String(err)),
        });
      }

      storePendingQuestion({
        ...context,
        questionId,
        outTrackId,
        title,
        questions: parsed,
        submitted: false,
      });

      context.log?.info?.(
        `[DingTalk][AskUser] question card sent question=${questionId} outTrackId=${outTrackId}`,
      );
      return jsonToolResult({
        status: "pending",
        questionId,
        outTrackId,
        message:
          "Question card sent to the user. Their answer will arrive as a follow-up message in this conversation.",
      });
    },
  });
  api.logger?.debug?.(`${TOOL_NAME}: registered tool`);
}
