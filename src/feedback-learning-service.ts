import { randomUUID } from "node:crypto";
import {
  appendFeedbackEvent,
  appendOutboundReplySnapshot,
  appendReflectionRecord,
  appendSessionLearningNote,
  FeedbackKind,
  FeedbackEventRecord,
  listActiveSessionLearningNotes,
  listLearnedRules,
  listOutboundReplySnapshots,
  listTargetLearnedRules,
  LearnedRuleRecord,
  OutboundReplySnapshot,
  ReflectionCategory,
  upsertTargetLearnedRule,
  upsertLearnedRule,
} from "./feedback-learning-store";
import type { DingTalkConfig, MessageContent } from "./types";

const NEGATIVE_SIGNAL_PATTERNS: Array<{ pattern: RegExp; category: ReflectionCategory }> = [
  { pattern: /(没看图|没看图片|看图|补发原图|别猜图)/i, category: "missing_image_context" },
  { pattern: /(引用|原文|原消息|别猜|没拿到|没看到)/i, category: "quoted_context_missing" },
  { pattern: /(不是这个意思|理解错|答偏|重新答|重新回答|我问的是)/i, category: "misunderstood_intent" },
];

function buildRuleInstruction(category: ReflectionCategory): string {
  switch (category) {
    case "missing_image_context":
      return "当用户要求看图/分析图片但当前上下文没有图片本体时，禁止臆测内容，先明确要求用户补发原图。";
    case "quoted_context_missing":
      return "当引用消息正文或附件不可见时，禁止根据上下文臆测引用内容，先说明缺失并请用户补发原文/原文件。";
    case "misunderstood_intent":
      return "当用户明显在纠正上一轮理解时，先复述其真实意图，再给出更直接的修正答案。";
    case "positive_direct_answer":
      return "保持直接、贴题、少绕弯的回答方式。";
    case "generic_negative":
    default:
      return "若用户对上一轮回复不满意，优先缩短答案、减少假设，并先确认关键信息是否完整。";
  }
}

function buildDiagnosis(kind: FeedbackKind, category: ReflectionCategory): string {
  if (kind === "explicit_positive") {
    return "用户通过显式正反馈认可了上一条回复，可以保留当前回答风格。";
  }
  switch (category) {
    case "missing_image_context":
      return "上一条回复很可能在缺少图片本体的情况下尝试分析图片，导致用户不满意。";
    case "quoted_context_missing":
      return "上一条回复很可能在引用正文/附件不可见时做了推断，导致用户不满意。";
    case "misunderstood_intent":
      return "用户在后续消息里明确纠正了上一轮理解，说明回答偏离了真实意图。";
    case "generic_negative":
    default:
      return "用户对上一条回复不满意，但当前证据不足以归到更具体的错误类型。";
  }
}

function inferCategory(params: {
  kind: FeedbackKind;
  signalText?: string;
  snapshot?: OutboundReplySnapshot | null;
  content?: MessageContent;
}): ReflectionCategory {
  if (params.kind === "explicit_positive") {
    return "positive_direct_answer";
  }

  const texts = [
    params.signalText || "",
    params.snapshot?.question || "",
    params.snapshot?.answer || "",
    params.content?.text || "",
  ].join("\n");

  if (params.kind === "explicit_negative") {
    if (/图|图片|截图|看图/.test(params.snapshot?.question || "")) {
      return "missing_image_context";
    }
    if (/引用|原文|原消息/.test(params.snapshot?.question || "")) {
      return "quoted_context_missing";
    }
  }

  for (const candidate of NEGATIVE_SIGNAL_PATTERNS) {
    if (candidate.pattern.test(texts)) {
      return candidate.category;
    }
  }
  return "generic_negative";
}

function latestSnapshotForTarget(
  storePath: string | undefined,
  accountId: string,
  targetId: string,
  processQueryKey?: string,
): OutboundReplySnapshot | null {
  const snapshots = listOutboundReplySnapshots({ storePath, accountId, targetId });
  if (snapshots.length === 0) {
    return null;
  }
  if (processQueryKey) {
    const matched = snapshots.find((snapshot) => snapshot.processQueryKey === processQueryKey);
    if (matched) {
      return matched;
    }
  }
  return snapshots[0] || null;
}

function updateLearnedRule(
  storePath: string | undefined,
  accountId: string,
  category: ReflectionCategory,
  kind: FeedbackKind,
): void {
  if (!storePath || kind === "explicit_positive") {
    return;
  }
  const ruleId = `rule_${category}`;
  const existing = listLearnedRules({ storePath, accountId }).find((rule) => rule.ruleId === ruleId);
  const negativeCount = (existing?.negativeCount || 0) + 1;
  const positiveCount = existing?.positiveCount || 0;
  const rule: LearnedRuleRecord = {
    ruleId,
    category,
    instruction: buildRuleInstruction(category),
    negativeCount,
    positiveCount,
    updatedAt: Date.now(),
    enabled: negativeCount >= 2,
  };
  upsertLearnedRule({ storePath, accountId, rule });
}

export function isFeedbackLearningEnabled(config: DingTalkConfig | undefined): boolean {
  return config?.feedbackLearningEnabled === true;
}

export function isFeedbackLearningAutoApplyEnabled(config: DingTalkConfig | undefined): boolean {
  return config?.feedbackLearningAutoApply === true;
}

export function recordOutboundReplyForLearning(params: {
  enabled: boolean;
  storePath?: string;
  accountId: string;
  targetId: string;
  sessionKey: string;
  question: string;
  answer: string;
  processQueryKey?: string;
  mode?: "card" | "markdown";
}): void {
  if (!params.enabled || !params.storePath || !params.answer.trim()) {
    return;
  }
  appendOutboundReplySnapshot({
    storePath: params.storePath,
    accountId: params.accountId,
    targetId: params.targetId,
    snapshot: {
      id: randomUUID(),
      targetId: params.targetId,
      sessionKey: params.sessionKey,
      question: params.question,
      answer: params.answer,
      processQueryKey: params.processQueryKey,
      mode: params.mode,
      createdAt: Date.now(),
    },
  });
}

export function recordExplicitFeedbackLearning(params: {
  enabled: boolean;
  autoApply?: boolean;
  storePath?: string;
  accountId: string;
  targetId: string;
  feedbackType: "feedback_up" | "feedback_down";
  userId?: string;
  processQueryKey?: string;
  noteTtlMs?: number;
}): void {
  if (!params.enabled || !params.storePath) {
    return;
  }
  const kind: FeedbackKind =
    params.feedbackType === "feedback_up" ? "explicit_positive" : "explicit_negative";
  const snapshot = latestSnapshotForTarget(
    params.storePath,
    params.accountId,
    params.targetId,
    params.processQueryKey,
  );
  const event: FeedbackEventRecord = {
    id: randomUUID(),
    kind,
    targetId: params.targetId,
    userId: params.userId,
    processQueryKey: params.processQueryKey,
    createdAt: Date.now(),
    snapshotId: snapshot?.id,
  };
  appendFeedbackEvent({
    storePath: params.storePath,
    accountId: params.accountId,
    targetId: params.targetId,
    event,
  });

  const category = inferCategory({ kind, snapshot });
  const reflection = {
    id: randomUUID(),
    targetId: params.targetId,
    sourceEventId: event.id,
    kind,
    category,
    diagnosis: buildDiagnosis(kind, category),
    suggestedInstruction: buildRuleInstruction(category),
    question: snapshot?.question,
    answer: snapshot?.answer,
    createdAt: Date.now(),
  };
  appendReflectionRecord({
    storePath: params.storePath,
    accountId: params.accountId,
    targetId: params.targetId,
    reflection,
  });

  if (params.autoApply && kind !== "explicit_positive") {
    appendSessionLearningNote({
      storePath: params.storePath,
      accountId: params.accountId,
      targetId: params.targetId,
      ttlMs: params.noteTtlMs,
      note: {
        id: randomUUID(),
        targetId: params.targetId,
        instruction: reflection.suggestedInstruction,
        source: kind,
        category,
        createdAt: Date.now(),
      },
    });
  }
  if (params.autoApply) {
    updateLearnedRule(params.storePath, params.accountId, category, kind);
  }
}

export function analyzeImplicitNegativeFeedback(params: {
  enabled: boolean;
  autoApply?: boolean;
  storePath?: string;
  accountId: string;
  targetId: string;
  signalText: string;
  content: MessageContent;
  noteTtlMs?: number;
}): void {
  if (!params.enabled || !params.storePath) {
    return;
  }

  const snapshot = latestSnapshotForTarget(params.storePath, params.accountId, params.targetId);
  if (!snapshot) {
    return;
  }

  const category = inferCategory({
    kind: "implicit_negative",
    signalText: params.signalText,
    snapshot,
    content: params.content,
  });
  if (category === "generic_negative" && !NEGATIVE_SIGNAL_PATTERNS.some((item) => item.pattern.test(params.signalText))) {
    return;
  }

  const event: FeedbackEventRecord = {
    id: randomUUID(),
    kind: "implicit_negative",
    targetId: params.targetId,
    createdAt: Date.now(),
    signalText: params.signalText,
    snapshotId: snapshot.id,
    sessionKey: snapshot.sessionKey,
  };
  appendFeedbackEvent({
    storePath: params.storePath,
    accountId: params.accountId,
    targetId: params.targetId,
    event,
  });

  const reflection = {
    id: randomUUID(),
    targetId: params.targetId,
    sourceEventId: event.id,
    kind: "implicit_negative" as const,
    category,
    diagnosis: buildDiagnosis("implicit_negative", category),
    suggestedInstruction: buildRuleInstruction(category),
    question: snapshot.question,
    answer: snapshot.answer,
    createdAt: Date.now(),
  };
  appendReflectionRecord({
    storePath: params.storePath,
    accountId: params.accountId,
    targetId: params.targetId,
    reflection,
  });
  if (params.autoApply) {
    appendSessionLearningNote({
      storePath: params.storePath,
      accountId: params.accountId,
      targetId: params.targetId,
      ttlMs: params.noteTtlMs,
      note: {
        id: randomUUID(),
        targetId: params.targetId,
        instruction: reflection.suggestedInstruction,
        source: "implicit_negative",
        category,
        createdAt: Date.now(),
      },
    });
    updateLearnedRule(params.storePath, params.accountId, category, "implicit_negative");
  }
}

function ruleMatchesContent(rule: LearnedRuleRecord, content: MessageContent): boolean {
  if (rule.manual) {
    return true;
  }
  switch (rule.category) {
    case "missing_image_context":
      return /图|图片|截图|看图|看下/.test(content.text) && !content.mediaPath && !(content.mediaPaths?.length);
    case "quoted_context_missing":
      return content.text.includes("[引用消息") || Boolean(content.quoted);
    case "misunderstood_intent":
      return /重新|再答|重答|补充/.test(content.text);
    case "generic_negative":
    case "positive_direct_answer":
    default:
      return false;
  }
}

function listMatchingRules(params: {
  storePath?: string;
  accountId: string;
  targetId: string;
  content: MessageContent;
}): LearnedRuleRecord[] {
  if (!params.storePath) {
    return [];
  }
  const targetRules = listTargetLearnedRules({
    storePath: params.storePath,
    accountId: params.accountId,
    targetId: params.targetId,
  }).filter((rule) => rule.enabled && ruleMatchesContent(rule, params.content));
  const globalRules = listLearnedRules({
    storePath: params.storePath,
    accountId: params.accountId,
  }).filter((rule) => rule.enabled && ruleMatchesContent(rule, params.content));
  return [...targetRules, ...globalRules];
}

export function buildLearningContextBlock(params: {
  enabled: boolean;
  storePath?: string;
  accountId: string;
  targetId: string;
  content: MessageContent;
}): string {
  if (!params.enabled || !params.storePath) {
    return "";
  }
  const notes = listActiveSessionLearningNotes({
    storePath: params.storePath,
    accountId: params.accountId,
    targetId: params.targetId,
  }).slice(0, 3);
  const rules = listMatchingRules(params).slice(0, 3);

  const instructions = [
    ...notes.map((note) => note.instruction),
    ...rules.map((rule) => rule.instruction),
  ].filter(Boolean);
  if (instructions.length === 0) {
    return "";
  }

  const uniqueInstructions = [...new Set(instructions)];
  return [
    "[系统学习提示：仅供助手内部参考，不要原样复述给用户]",
    ...uniqueInstructions.map((instruction) => `- ${instruction}`),
  ].join("\n");
}

export function applyManualGlobalLearningRule(params: {
  storePath?: string;
  accountId: string;
  instruction: string;
}): { ruleId: string } | null {
  if (!params.storePath || !params.instruction.trim()) {
    return null;
  }
  const ruleId = `manual_${Date.now()}`;
  const exactReplyMatch = params.instruction.trim().match(/^当用户问[“\"](.+?)[”\"]时，必须回答[“\"](.+?)[”\"][。.!！]?$/);
  upsertLearnedRule({
    storePath: params.storePath,
    accountId: params.accountId,
    rule: {
      ruleId,
      category: "generic_negative",
      instruction: params.instruction.trim(),
      negativeCount: 1,
      positiveCount: 0,
      updatedAt: Date.now(),
      enabled: true,
      manual: true,
      triggerText: exactReplyMatch?.[1]?.trim(),
      forcedReply: exactReplyMatch?.[2]?.trim(),
    },
  });
  return { ruleId };
}

function inferConversationType(targetId: string): "dm" | "group" | "unknown" {
  if (!targetId.trim()) {
    return "unknown";
  }
  return targetId.startsWith("cid") ? "group" : "dm";
}

function normalizeManualTriggerText(value: string): string {
  return value
    .trim()
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200d\ufeff]/g, "")
    .toLowerCase()
    .replace(/[。！？!?.,，、；;：:]+$/g, "")
    .replace(/\s+/g, " ");
}

export function applyManualTargetLearningRule(params: {
  storePath?: string;
  accountId: string;
  targetId: string;
  instruction: string;
  conversationType?: "dm" | "group" | "unknown";
}): { ruleId: string } | null {
  if (!params.storePath || !params.targetId.trim() || !params.instruction.trim()) {
    return null;
  }
  const ruleId = `manual_target_${Date.now()}`;
  const exactReplyMatch = params.instruction
    .trim()
    .match(/^当用户问[“\"](.+?)[”\"]时，必须回答[“\"](.+?)[”\"][。.!！]?$/);
  upsertTargetLearnedRule({
    storePath: params.storePath,
    accountId: params.accountId,
    targetId: params.targetId.trim(),
    conversationType: params.conversationType || inferConversationType(params.targetId),
    rule: {
      ruleId,
      category: "generic_negative",
      instruction: params.instruction.trim(),
      negativeCount: 1,
      positiveCount: 0,
      updatedAt: Date.now(),
      enabled: true,
      manual: true,
      triggerText: exactReplyMatch?.[1]?.trim(),
      forcedReply: exactReplyMatch?.[2]?.trim(),
    },
  });
  return { ruleId };
}

export function resolveManualForcedReply(params: {
  storePath?: string;
  accountId: string;
  targetId: string;
  content: MessageContent;
}): string | null {
  if (!params.storePath) {
    return null;
  }
  const text = normalizeManualTriggerText(params.content.text);
  if (!text) {
    return null;
  }
  const matched = listLearnedRules({ storePath: params.storePath, accountId: params.accountId })
    .filter((rule) => rule.enabled && rule.manual && rule.triggerText && rule.forcedReply)
    .find((rule) => normalizeManualTriggerText(rule.triggerText || "") === text);
  const targetMatched = listTargetLearnedRules({
    storePath: params.storePath,
    accountId: params.accountId,
    targetId: params.targetId,
  })
    .filter((rule) => rule.enabled && rule.manual && rule.triggerText && rule.forcedReply)
    .find((rule) => normalizeManualTriggerText(rule.triggerText || "") === text);
  return targetMatched?.forcedReply || matched?.forcedReply || null;
}

export function listScopedLearnedRules(params: {
  storePath?: string;
  accountId: string;
  targetId: string;
}): { targetRules: LearnedRuleRecord[]; globalRules: LearnedRuleRecord[] } {
  return {
    targetRules: listTargetLearnedRules({
      storePath: params.storePath,
      accountId: params.accountId,
      targetId: params.targetId,
    }),
    globalRules: listLearnedRules({
      storePath: params.storePath,
      accountId: params.accountId,
    }),
  };
}

export function applyManualSessionLearningNote(params: {
  storePath?: string;
  accountId: string;
  targetId: string;
  instruction: string;
  noteTtlMs?: number;
}): boolean {
  if (!params.storePath || !params.instruction.trim()) {
    return false;
  }
  appendSessionLearningNote({
    storePath: params.storePath,
    accountId: params.accountId,
    targetId: params.targetId,
    ttlMs: params.noteTtlMs,
    note: {
      id: randomUUID(),
      targetId: params.targetId,
      instruction: params.instruction.trim(),
      source: "implicit_negative",
      category: "generic_negative",
      createdAt: Date.now(),
    },
  });
  return true;
}
