import { createHash } from "node:crypto";
import type { ResolvedFeedbackReporting } from "./feedback-reporting-config";
import type { FeedbackRecord, FeedbackScope } from "./feedback-store";

export type ReportContent = {
  mode: "replace" | "preserve";
  status: "available" | "missing" | "unverified" | "pending";
  reason?: string;
  question?: string;
  answer?: string;
  answerHash?: string;
};
export type ReportRecord = Omit<FeedbackRecord, "history" | "seen">;
export type ReportJob = {
  scope: FeedbackScope;
  record: ReportRecord;
  transcriptStorePath: string;
  config: Omit<ResolvedFeedbackReporting, "token">;
  token: string;
  metadataOnly?: boolean;
};
export type FeedbackReportEnvelope = {
  schemaVersion: 1;
  type: "dingtalk.feedback.snapshot";
  recordId: string;
  revision: number;
  source: { tenantId: string; instanceId: string; accountId: string; channel: "dingtalk" };
  cardId: string;
  questionerUserId: string;
  feedback: { vote: "none" | "like" | "dislike"; reasons: string[]; updatedAt: number };
  conversation: {
    agentId: string;
    sessionKey: string;
    conversationId: string;
    sourceMsgId?: string;
    transcript: FeedbackRecord["transcript"];
  };
  answerHash?: string;
  createdAt: number;
  completedAt?: number;
  content: ReportContent;
};
export type ReportReceipt = {
  /** Internal maintenance marker; not part of the HTTP protocol. */
  maintenanceVersion?: number;
  /** Scheduler failures are separate from uncertain HTTP delivery attempts. */
  workerFailures?: number;
  superseded?: boolean;
  sourceRevision: number;
  wireRevision: number;
  terminal: boolean;
  nextAttemptAt: number;
  expiresAt: number;
  attempts: number;
  error?: string;
};
export const REPORT_MAINTENANCE_VERSION = 1;
export type ReportState = ReportReceipt & {
  destinationKey: string;
  delivered: boolean;
  envelope: FeedbackReportEnvelope;
};
export type ReportResult =
  | { kind: "done"; receipt: ReportReceipt }
  | { kind: "error"; code: string };

export function reportRecordId(job: Pick<ReportJob, "config" | "record" | "scope">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        job.config.tenantId,
        job.config.instanceId,
        job.scope.accountId,
        job.record.outTrackId,
      ]),
    )
    .digest("hex");
}
export function createReportEnvelope(
  job: ReportJob,
  revision: number,
  content: ReportContent,
): FeedbackReportEnvelope {
  const r = job.record;
  const transcript =
    r.transcript?.status === "linked"
      ? {
          status: r.transcript.status,
          source: r.transcript.source,
          sessionId: r.transcript.sessionId,
          userMessageId: r.transcript.userMessageId,
          assistantMessageId: r.transcript.assistantMessageId,
        }
      : r.transcript;
  return {
    schemaVersion: 1,
    type: "dingtalk.feedback.snapshot",
    recordId: reportRecordId(job),
    revision,
    source: {
      tenantId: job.config.tenantId,
      instanceId: job.config.instanceId,
      accountId: job.scope.accountId,
      channel: "dingtalk",
    },
    cardId: r.outTrackId,
    questionerUserId: r.ownerUserId,
    feedback: { vote: r.vote, reasons: r.reasons, updatedAt: r.lastEventAt },
    conversation: {
      agentId: r.agentId,
      sessionKey: r.sessionKey,
      conversationId: r.conversationId,
      sourceMsgId: r.sourceMsgId,
      transcript,
    },
    answerHash: r.answerHash,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    content,
  };
}
export function retryDelay(attempt: number, random = Math.random): number {
  return Math.round(
    Math.min(300_000, 5000 * 2 ** Math.min(6, Math.max(0, attempt - 1))) * (0.8 + random() * 0.4),
  );
}
export function validateReportAck(
  value: unknown,
  sent: FeedbackReportEnvelope,
): { status: "applied" | "duplicate" | "stale"; acceptedRevision: number } {
  const v = value as Record<string, unknown> | null;
  if (
    !v ||
    v.schemaVersion !== 1 ||
    v.recordId !== sent.recordId ||
    !Number.isSafeInteger(v.acceptedRevision) ||
    Number(v.acceptedRevision) < 1 ||
    Number(v.acceptedRevision) >= Number.MAX_SAFE_INTEGER ||
    !["applied", "duplicate", "stale"].includes(String(v.status))
  ) {
    throw new Error("invalid_ack");
  }
  const revision = v.acceptedRevision as number;
  if (
    (v.status === "stale" && revision <= sent.revision) ||
    (v.status !== "stale" && revision !== sent.revision)
  ) {
    throw new Error("invalid_ack_revision");
  }
  return { status: v.status as "applied" | "duplicate" | "stale", acceptedRevision: revision };
}
