import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { FeedbackTranscriptLink } from "../card/feedback-transcript";
import { resolveNamespacePath } from "../shared/persistence-store";
import { notifyFeedbackReportPending } from "./feedback-reporting-events";

export type FeedbackVote = "none" | "like" | "dislike";
export interface FeedbackRecord {
  version: 1;
  accountId: string;
  outTrackId: string;
  ownerUserId: string;
  conversationId: string;
  sessionKey: string;
  agentId: string;
  sourceMsgId?: string;
  createdAt: number;
  expiresAt: number;
  completedAt?: number;
  answerHash?: string;
  transcript?: FeedbackTranscriptLink;
  reporting?: { revision: number; destinationKey: string; retainUntil: number };
  vote: FeedbackVote;
  reasons: string[];
  reasonsSubmitted?: boolean;
  lastEventAt: number;
  seen: string[];
  history: Array<{ eventId: string; at: number; vote: FeedbackVote; reasons: string[] }>;
}
export interface FeedbackScope {
  storePath: string;
  accountId: string;
}
export interface FeedbackChange {
  outTrackId: string;
  userId: string;
  eventId: string;
  eventAt: number;
  vote?: FeedbackVote;
  reasons?: string[];
}
export type FeedbackResult =
  | { status: "saved" | "duplicate" | "stale"; record: FeedbackRecord }
  | { status: "unknown" | "forbidden" | "expired" | "unfinished" | "invalid" };

const NAMESPACE = "feedback.ratings";
const queues = new Map<string, Promise<unknown>>();
const lastCleanup = new Map<string, number>();
export function feedbackRecordPath(scope: FeedbackScope, outTrackId: string): string {
  // Hash the external key so a platform identifier cannot create an oversized filename.
  return resolveNamespacePath(NAMESPACE, {
    storePath: scope.storePath,
    scope: {
      accountId: scope.accountId,
      targetId: createHash("sha256").update(outTrackId).digest("hex"),
    },
  });
}
async function locked<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(file, current);
  try {
    return await current;
  } finally {
    if (queues.get(file) === current) {
      queues.delete(file);
    }
  }
}
async function readRecord(file: string): Promise<FeedbackRecord | undefined> {
  try {
    const value: FeedbackRecord = JSON.parse(await readFile(file, "utf8"));
    if (
      value.version !== 1 ||
      !value.ownerUserId ||
      !value.outTrackId ||
      !Array.isArray(value.seen) ||
      !Array.isArray(value.history) ||
      !Array.isArray(value.reasons) ||
      !["none", "like", "dislike"].includes(value.vote) ||
      !Number.isFinite(value.expiresAt)
    ) {
      throw new Error("Invalid feedback record");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error; // Never overwrite unreadable data or pretend persistence succeeded.
  }
}
async function writeRecord(file: string, record: FeedbackRecord): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
export async function registerFeedbackCard(
  scope: FeedbackScope,
  binding: Pick<
    FeedbackRecord,
    "outTrackId" | "ownerUserId" | "conversationId" | "sessionKey" | "agentId" | "sourceMsgId"
  >,
  retentionDays = 90,
  now = Date.now(),
): Promise<void> {
  if (!binding.outTrackId || !binding.ownerUserId) {
    return;
  }
  const file = feedbackRecordPath(scope, binding.outTrackId);
  await locked(file, async () => {
    const existing = await readRecord(file);
    if (existing) {
      if (
        existing.ownerUserId !== binding.ownerUserId ||
        existing.accountId !== scope.accountId ||
        existing.sessionKey !== binding.sessionKey
      ) {
        throw new Error("Feedback ownership conflict");
      }
      return;
    }
    await writeRecord(file, {
      version: 1,
      ...binding,
      accountId: scope.accountId,
      createdAt: now,
      expiresAt: now + Math.min(365, Math.max(1, retentionDays)) * 86400000,
      vote: "none",
      reasons: [],
      reasonsSubmitted: false,
      lastEventAt: 0,
      seen: [],
      history: [],
    });
  });
  scheduleCleanup(scope, now);
}
/** Opportunistic retention maintenance; no background process or per-vote directory scan. */
export async function cleanupFeedbackRecords(
  scope: FeedbackScope,
  now = Date.now(),
): Promise<void> {
  const base = resolveNamespacePath(NAMESPACE, {
    storePath: scope.storePath,
    scope: { accountId: scope.accountId },
  });
  const directory = path.dirname(base);
  const prefix = `${path.basename(base, ".json")}.target-`;
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  for (const name of files) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) {
      continue;
    }
    const file = path.join(directory, name);
    await locked(file, async () => {
      const record = await readRecord(file);
      if (
        record?.accountId === scope.accountId &&
        record.expiresAt <= now &&
        (record.reporting?.retainUntil ?? 0) <= now
      ) {
        await unlink(file);
      }
    });
  }
}
function scheduleCleanup(scope: FeedbackScope, now: number): void {
  const key = `${scope.storePath}:${scope.accountId}`;
  if (now - (lastCleanup.get(key) ?? 0) < 86400000) {
    return;
  }
  lastCleanup.set(key, now);
  if (lastCleanup.size > 256) {
    lastCleanup.delete(lastCleanup.keys().next().value!);
  }
  void cleanupFeedbackRecords(scope, now).catch(() => undefined);
}

export async function completeFeedbackCard(
  scope: FeedbackScope,
  outTrackId: string,
  answer: string,
  now = Date.now(),
  transcript?: FeedbackTranscriptLink,
): Promise<void> {
  const file = feedbackRecordPath(scope, outTrackId);
  await locked(file, async () => {
    const record = await readRecord(file);
    if (!record || record.completedAt || !answer.trim()) {
      return;
    }
    record.completedAt = now;
    if (transcript) {
      record.transcript = transcript;
    }
    record.answerHash = createHash("sha256").update(answer).digest("hex");
    await writeRecord(file, record);
  });
}
export async function applyFeedback(
  scope: FeedbackScope,
  change: FeedbackChange,
  now = Date.now(),
  reporting?: { destinationKey: string },
): Promise<FeedbackResult> {
  const file = feedbackRecordPath(scope, change.outTrackId);
  return locked(file, async () => {
    const record = await readRecord(file);
    if (
      !record ||
      record.accountId !== scope.accountId ||
      record.outTrackId !== change.outTrackId
    ) {
      return { status: "unknown" };
    }
    if (!change.userId || record.ownerUserId !== change.userId) {
      return { status: "forbidden" };
    }
    if (record.expiresAt <= now) {
      return { status: "expired" };
    }
    if (!record.completedAt) {
      return { status: "unfinished" };
    }
    if (
      !change.eventId ||
      !Number.isFinite(change.eventAt) ||
      change.eventAt <= 0 ||
      (change.vote !== undefined && !["none", "like", "dislike"].includes(change.vote))
    ) {
      return { status: "invalid" };
    }
    if (record.seen.includes(change.eventId)) {
      return { status: "duplicate", record };
    }
    if (change.eventAt < record.lastEventAt) {
      return { status: "stale", record };
    }
    if (change.reasons && record.vote !== "dislike") {
      return { status: "stale", record };
    }
    const hadRating = record.vote !== "none" || record.history.some((item) => item.vote !== "none");
    if (change.vote) {
      if (change.vote !== record.vote) {
        record.reasons = [];
        record.reasonsSubmitted = false;
      }
      record.vote = change.vote;
    }
    if (change.reasons) {
      record.reasons = [...new Set(change.reasons)];
      record.reasonsSubmitted = true;
    }
    // Only small metadata joins the existing atomic vote write. The reporting
    // worker owns separate outbox files and never holds this vote lock.
    if (record.reporting || (reporting && (record.vote !== "none" || hadRating))) {
      record.reporting = {
        revision: (record.reporting?.revision ?? 0) + 1,
        destinationKey: reporting?.destinationKey ?? record.reporting!.destinationKey,
        retainUntil: now + 7 * 86400000,
      };
    }
    record.lastEventAt = change.eventAt;
    record.seen = [...record.seen, change.eventId].slice(-256);
    const last = record.history.at(-1);
    if (
      !last ||
      last.vote !== record.vote ||
      JSON.stringify(last.reasons) !== JSON.stringify(record.reasons)
    ) {
      record.history = [
        ...record.history,
        {
          eventId: change.eventId,
          at: change.eventAt,
          vote: record.vote,
          reasons: [...record.reasons],
        },
      ].slice(-100);
    }
    await writeRecord(file, record);
    if (record.reporting) {
      notifyFeedbackReportPending(scope, record.outTrackId);
    }
    return { status: "saved", record };
  });
}
export async function feedbackStats(
  scope: FeedbackScope,
  userId: string,
  days: number,
  now = Date.now(),
) {
  const base = resolveNamespacePath(NAMESPACE, {
    storePath: scope.storePath,
    scope: { accountId: scope.accountId },
  });
  const directory = path.dirname(base);
  const prefix = `${path.basename(base, ".json")}.target-`;
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      files = [];
    } else {
      throw error;
    }
  }
  const result = { total: 0, like: 0, dislike: 0, reasons: {} as Record<string, number> };
  for (const name of files) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) {
      continue;
    }
    const file = path.join(directory, name);
    const record = await readRecord(file);
    if (!record || record.accountId !== scope.accountId) {
      continue;
    }
    if (record.expiresAt <= now) {
      if ((record.reporting?.retainUntil ?? 0) <= now) {
        await unlink(file).catch(() => undefined);
      }
      continue;
    }
    if (
      record.ownerUserId !== userId ||
      !record.completedAt ||
      record.createdAt < now - days * 86400000
    ) {
      continue;
    }
    result.total++;
    if (record.vote === "like") {
      result.like++;
    }
    if (record.vote === "dislike") {
      result.dislike++;
      for (const reason of record.reasons) {
        result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
      }
    }
  }
  return result;
}

/** Exact lookup for an explicit detail request; never scans another card or transcript. */
export async function readFeedbackRecord(
  scope: FeedbackScope,
  outTrackId: string,
): Promise<FeedbackRecord | undefined> {
  const record = await readRecord(feedbackRecordPath(scope, outTrackId));
  return record?.accountId === scope.accountId && record.outTrackId === outTrackId
    ? record
    : undefined;
}
