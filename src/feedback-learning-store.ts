import { readNamespaceJson, writeNamespaceJsonAtomic } from "./persistence-store";

const MAX_EVENTS = 200;
const MAX_SNAPSHOTS = 100;
const MAX_REFLECTIONS = 200;
const MAX_SESSION_NOTES = 20;
const MAX_RULES = 50;
const DEFAULT_NOTE_TTL_MS = 6 * 60 * 60 * 1000;

const EVENTS_NAMESPACE = "feedback.events";
const SNAPSHOTS_NAMESPACE = "feedback.snapshots";
const REFLECTIONS_NAMESPACE = "feedback.reflections";
const SESSION_NOTES_NAMESPACE = "feedback.session-notes";
const LEARNED_RULES_NAMESPACE = "feedback.learned-rules";

export type FeedbackKind = "explicit_positive" | "explicit_negative" | "implicit_negative";
export type ReflectionCategory =
  | "missing_image_context"
  | "quoted_context_missing"
  | "misunderstood_intent"
  | "generic_negative"
  | "positive_direct_answer";

export interface FeedbackEventRecord {
  id: string;
  kind: FeedbackKind;
  targetId: string;
  sessionKey?: string;
  processQueryKey?: string;
  userId?: string;
  createdAt: number;
  signalText?: string;
  snapshotId?: string;
}

export interface OutboundReplySnapshot {
  id: string;
  targetId: string;
  sessionKey: string;
  question: string;
  answer: string;
  createdAt: number;
  processQueryKey?: string;
  mode?: "card" | "markdown";
}

export interface ReflectionRecord {
  id: string;
  targetId: string;
  sourceEventId: string;
  kind: FeedbackKind;
  category: ReflectionCategory;
  diagnosis: string;
  suggestedInstruction: string;
  question?: string;
  answer?: string;
  createdAt: number;
}

export interface SessionLearningNote {
  id: string;
  targetId: string;
  instruction: string;
  source: FeedbackKind;
  category: ReflectionCategory;
  createdAt: number;
  expiresAt: number;
}

export interface LearnedRuleRecord {
  ruleId: string;
  category: ReflectionCategory;
  instruction: string;
  negativeCount: number;
  positiveCount: number;
  updatedAt: number;
  enabled: boolean;
  manual?: boolean;
  triggerText?: string;
  forcedReply?: string;
}

interface ListBucket<T> {
  updatedAt: number;
  entries: T[];
}

interface LearnedRuleBucket {
  updatedAt: number;
  rules: Record<string, LearnedRuleRecord>;
}

function trimNewest<T extends { createdAt: number }>(entries: T[], limit: number): T[] {
  return [...entries].sort((left, right) => right.createdAt - left.createdAt).slice(0, limit);
}

function readListBucket<T>(
  namespace: string,
  params: { storePath?: string; accountId: string; targetId: string },
): ListBucket<T> {
  if (!params.storePath) {
    return { updatedAt: 0, entries: [] };
  }
  return readNamespaceJson<ListBucket<T>>(namespace, {
    storePath: params.storePath,
    scope: { accountId: params.accountId, targetId: params.targetId },
    format: "json",
    fallback: { updatedAt: 0, entries: [] },
  });
}

function writeListBucket<T>(
  namespace: string,
  params: { storePath?: string; accountId: string; targetId: string; entries: T[] },
): void {
  if (!params.storePath) {
    return;
  }
  writeNamespaceJsonAtomic(namespace, {
    storePath: params.storePath,
    scope: { accountId: params.accountId, targetId: params.targetId },
    format: "json",
    data: {
      updatedAt: Date.now(),
      entries: params.entries,
    } satisfies ListBucket<T>,
  });
}

export function appendFeedbackEvent(
  params: { storePath?: string; accountId: string; targetId: string; event: FeedbackEventRecord },
): void {
  const bucket = readListBucket<FeedbackEventRecord>(EVENTS_NAMESPACE, params);
  bucket.entries = trimNewest([...bucket.entries, params.event], MAX_EVENTS);
  writeListBucket(EVENTS_NAMESPACE, { ...params, entries: bucket.entries });
}

export function listFeedbackEvents(
  params: { storePath?: string; accountId: string; targetId: string },
): FeedbackEventRecord[] {
  return readListBucket<FeedbackEventRecord>(EVENTS_NAMESPACE, params).entries;
}

export function appendOutboundReplySnapshot(
  params: { storePath?: string; accountId: string; targetId: string; snapshot: OutboundReplySnapshot },
): void {
  const bucket = readListBucket<OutboundReplySnapshot>(SNAPSHOTS_NAMESPACE, params);
  bucket.entries = trimNewest([...bucket.entries, params.snapshot], MAX_SNAPSHOTS);
  writeListBucket(SNAPSHOTS_NAMESPACE, { ...params, entries: bucket.entries });
}

export function listOutboundReplySnapshots(
  params: { storePath?: string; accountId: string; targetId: string },
): OutboundReplySnapshot[] {
  return readListBucket<OutboundReplySnapshot>(SNAPSHOTS_NAMESPACE, params).entries;
}

export function appendReflectionRecord(
  params: { storePath?: string; accountId: string; targetId: string; reflection: ReflectionRecord },
): void {
  const bucket = readListBucket<ReflectionRecord>(REFLECTIONS_NAMESPACE, params);
  bucket.entries = trimNewest([...bucket.entries, params.reflection], MAX_REFLECTIONS);
  writeListBucket(REFLECTIONS_NAMESPACE, { ...params, entries: bucket.entries });
}

export function listReflectionRecords(
  params: { storePath?: string; accountId: string; targetId: string },
): ReflectionRecord[] {
  return readListBucket<ReflectionRecord>(REFLECTIONS_NAMESPACE, params).entries;
}

export function appendSessionLearningNote(
  params: {
    storePath?: string;
    accountId: string;
    targetId: string;
    note: Omit<SessionLearningNote, "expiresAt"> & { expiresAt?: number };
    ttlMs?: number;
  },
): void {
  const ttlMs = params.ttlMs && params.ttlMs > 0 ? params.ttlMs : DEFAULT_NOTE_TTL_MS;
  const nowMs = Date.now();
  const bucket = readListBucket<SessionLearningNote>(SESSION_NOTES_NAMESPACE, params);
  const retained = bucket.entries.filter((note) => note.expiresAt > nowMs);
  retained.unshift({
    ...params.note,
    expiresAt: params.note.expiresAt ?? nowMs + ttlMs,
  });
  writeListBucket(SESSION_NOTES_NAMESPACE, {
    ...params,
    entries: trimNewest(retained, MAX_SESSION_NOTES),
  });
}

export function listActiveSessionLearningNotes(
  params: { storePath?: string; accountId: string; targetId: string; nowMs?: number },
): SessionLearningNote[] {
  const nowMs = params.nowMs ?? Date.now();
  return readListBucket<SessionLearningNote>(SESSION_NOTES_NAMESPACE, params).entries.filter(
    (note) => note.expiresAt > nowMs,
  );
}

export function upsertLearnedRule(
  params: { storePath?: string; accountId: string; rule: LearnedRuleRecord },
): void {
  if (!params.storePath) {
    return;
  }
  const bucket = readNamespaceJson<LearnedRuleBucket>(LEARNED_RULES_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId },
    format: "json",
    fallback: { updatedAt: 0, rules: {} },
  });
  bucket.rules[params.rule.ruleId] = params.rule;
  const trimmedRules = Object.values(bucket.rules)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RULES);
  const rules: Record<string, LearnedRuleRecord> = {};
  for (const rule of trimmedRules) {
    rules[rule.ruleId] = rule;
  }
  writeNamespaceJsonAtomic(LEARNED_RULES_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId },
    format: "json",
    data: { updatedAt: Date.now(), rules } satisfies LearnedRuleBucket,
  });
}

export function listLearnedRules(
  params: { storePath?: string; accountId: string },
): LearnedRuleRecord[] {
  if (!params.storePath) {
    return [];
  }
  const bucket = readNamespaceJson<LearnedRuleBucket>(LEARNED_RULES_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId },
    format: "json",
    fallback: { updatedAt: 0, rules: {} },
  });
  return Object.values(bucket.rules).sort((left, right) => right.updatedAt - left.updatedAt);
}
