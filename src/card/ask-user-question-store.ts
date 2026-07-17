import type { Logger } from "../types";
import { readNamespaceJson, writeNamespaceJsonAtomic } from "../persistence-store";

const ASK_USER_LIFECYCLE_NAMESPACE = "cards.ask-user.lifecycle";
const ACTIVE_TTL_MS = 5 * 60 * 1_000;
const TOMBSTONE_TTL_MS = 30 * 60 * 1_000;

export type AskUserActiveState = "reserved" | "pending" | "dispatching";

export type AskUserTerminalReason =
  | "delivery_failed"
  | "superseded_by_question"
  | "superseded_by_message"
  | "expired"
  | "cancelled"
  | "empty"
  | "submitted"
  | "pause_failed"
  | "restart_invalidated"
  | "restart_during_dispatch"
  | "dispatch_failed";

export interface AskUserLifecycleRecord {
  questionId: string;
  accountId: string;
  questionScopeKey: string;
  outTrackId: string;
  title: string;
  state: AskUserActiveState | "terminal";
  terminalReason?: AskUserTerminalReason;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface AskUserLifecycleState {
  version: 1;
  updatedAt: number;
  records: AskUserLifecycleRecord[];
}

export interface AskUserStoreOptions {
  storePath: string;
  accountId: string;
  log?: Logger;
  now?: () => number;
}

export interface ReserveAskUserQuestionInput {
  questionId: string;
  questionScopeKey: string;
  outTrackId: string;
  title: string;
}

export interface AskUserQuestionIdentifier {
  questionId?: string;
  outTrackId?: string;
}

function now(options: AskUserStoreOptions): number {
  return options.now?.() ?? Date.now();
}

function emptyState(timestamp: number): AskUserLifecycleState {
  return { version: 1, updatedAt: timestamp, records: [] };
}

function isActiveState(state: AskUserLifecycleRecord["state"]): state is AskUserActiveState {
  return state === "reserved" || state === "pending" || state === "dispatching";
}

function loadState(options: AskUserStoreOptions): AskUserLifecycleState {
  const timestamp = now(options);
  const state = readNamespaceJson<AskUserLifecycleState>(ASK_USER_LIFECYCLE_NAMESPACE, {
    storePath: options.storePath,
    scope: { accountId: options.accountId },
    fallback: emptyState(timestamp),
    log: options.log,
  });
  if (state.version !== 1 || !Array.isArray(state.records)) {
    return emptyState(timestamp);
  }
  return state;
}

function persistState(options: AskUserStoreOptions, state: AskUserLifecycleState): void {
  state.updatedAt = now(options);
  writeNamespaceJsonAtomic(ASK_USER_LIFECYCLE_NAMESPACE, {
    storePath: options.storePath,
    scope: { accountId: options.accountId },
    data: state,
    log: options.log,
  });
}

function toTerminal(
  record: AskUserLifecycleRecord,
  reason: AskUserTerminalReason,
  timestamp: number,
): AskUserLifecycleRecord {
  record.state = "terminal";
  record.terminalReason = reason;
  record.updatedAt = timestamp;
  record.expiresAt = timestamp + TOMBSTONE_TTL_MS;
  return record;
}

function cleanupState(state: AskUserLifecycleState, timestamp: number): boolean {
  let changed = false;
  for (const record of state.records) {
    if (isActiveState(record.state) && record.expiresAt <= timestamp) {
      toTerminal(record, "expired", timestamp);
      changed = true;
    }
  }
  const retained = state.records.filter(
    (record) => record.state !== "terminal" || record.expiresAt > timestamp,
  );
  if (retained.length !== state.records.length) {
    state.records = retained;
    changed = true;
  }
  return changed;
}

function readCleanState(options: AskUserStoreOptions): AskUserLifecycleState {
  const state = loadState(options);
  if (cleanupState(state, now(options))) {
    persistState(options, state);
  }
  return state;
}

function findRecord(
  state: AskUserLifecycleState,
  identifier: AskUserQuestionIdentifier,
): AskUserLifecycleRecord | undefined {
  return state.records.find(
    (record) =>
      (identifier.questionId && record.questionId === identifier.questionId) ||
      (identifier.outTrackId && record.outTrackId === identifier.outTrackId),
  );
}

export function reserveAskUserQuestion(
  options: AskUserStoreOptions,
  input: ReserveAskUserQuestionInput,
): AskUserLifecycleRecord {
  const timestamp = now(options);
  const state = readCleanState(options);
  const record: AskUserLifecycleRecord = {
    questionId: input.questionId,
    accountId: options.accountId,
    questionScopeKey: input.questionScopeKey,
    outTrackId: input.outTrackId,
    title: input.title,
    state: "reserved",
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp + ACTIVE_TTL_MS,
  };
  state.records = state.records.filter(
    (item) => item.questionId !== input.questionId && item.outTrackId !== input.outTrackId,
  );
  state.records.push(record);
  persistState(options, state);
  return { ...record };
}

export function activateAskUserQuestion(
  options: AskUserStoreOptions,
  questionId: string,
): { record?: AskUserLifecycleRecord; superseded: AskUserLifecycleRecord[] } {
  const timestamp = now(options);
  const state = readCleanState(options);
  const record = findRecord(state, { questionId });
  if (!record || record.state !== "reserved") {
    return { record: record ? { ...record } : undefined, superseded: [] };
  }

  const superseded: AskUserLifecycleRecord[] = [];
  for (const candidate of state.records) {
    if (
      candidate !== record &&
      isActiveState(candidate.state) &&
      candidate.questionScopeKey === record.questionScopeKey
    ) {
      toTerminal(candidate, "superseded_by_question", timestamp);
      superseded.push({ ...candidate });
    }
  }
  record.state = "pending";
  record.updatedAt = timestamp;
  record.expiresAt = timestamp + ACTIVE_TTL_MS;
  persistState(options, state);
  return { record: { ...record }, superseded };
}

export function claimAskUserQuestion(
  options: AskUserStoreOptions,
  identifier: AskUserQuestionIdentifier,
): AskUserLifecycleRecord | undefined {
  const timestamp = now(options);
  const state = readCleanState(options);
  const record = findRecord(state, identifier);
  if (!record || record.state !== "pending") {
    return undefined;
  }
  record.state = "dispatching";
  record.updatedAt = timestamp;
  record.expiresAt = timestamp + ACTIVE_TTL_MS;
  persistState(options, state);
  return { ...record };
}

export function terminateAskUserQuestion(
  options: AskUserStoreOptions,
  questionId: string,
  reason: AskUserTerminalReason,
): AskUserLifecycleRecord | undefined {
  const timestamp = now(options);
  const state = readCleanState(options);
  const record = findRecord(state, { questionId });
  if (!record || !isActiveState(record.state)) {
    return undefined;
  }
  toTerminal(record, reason, timestamp);
  persistState(options, state);
  return { ...record };
}

export function invalidateAskUserQuestionsInScope(
  options: AskUserStoreOptions,
  questionScopeKey: string,
  reason: AskUserTerminalReason,
): AskUserLifecycleRecord[] {
  const timestamp = now(options);
  const state = readCleanState(options);
  const invalidated: AskUserLifecycleRecord[] = [];
  for (const record of state.records) {
    if (isActiveState(record.state) && record.questionScopeKey === questionScopeKey) {
      toTerminal(record, reason, timestamp);
      invalidated.push({ ...record });
    }
  }
  if (invalidated.length > 0) {
    persistState(options, state);
  }
  return invalidated;
}

export function resolveAskUserQuestion(
  options: AskUserStoreOptions,
  identifier: AskUserQuestionIdentifier,
): AskUserLifecycleRecord | undefined {
  const record = findRecord(readCleanState(options), identifier);
  return record ? { ...record } : undefined;
}

export function recoverAskUserQuestionsAfterRestart(
  options: AskUserStoreOptions,
): AskUserLifecycleRecord[] {
  const timestamp = now(options);
  const state = readCleanState(options);
  const recovered: AskUserLifecycleRecord[] = [];
  for (const record of state.records) {
    if (!isActiveState(record.state)) {
      continue;
    }
    const reason =
      record.state === "dispatching" ? "restart_during_dispatch" : "restart_invalidated";
    toTerminal(record, reason, timestamp);
    recovered.push({ ...record });
  }
  if (recovered.length > 0) {
    persistState(options, state);
  }
  return recovered;
}
