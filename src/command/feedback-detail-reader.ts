import { freemem } from "node:os";
import { Worker } from "node:worker_threads";
import { getDingTalkRuntime } from "../platform/runtime";
import type { FeedbackContentRequest } from "./feedback-reporting-content";
import {
  beginFeedbackForegroundActivity,
  waitForFeedbackBackgroundIdle,
} from "./feedback-reporting-events";
import type { ReportContent } from "./feedback-reporting-protocol";
import type { FeedbackRecord } from "./feedback-store";

export const FEEDBACK_DETAIL_LIMITS = {
  maxTranscriptBytes: 8 * 1024 * 1024,
  maxContentBytes: 128 * 1024,
  workerMemoryMb: 128,
  timeoutMs: 10_000,
} as const;
type ActiveRead = { worker?: Worker; cancel?: () => void };
let activeRead: ActiveRead | undefined;
const pending = (reason: string): ReportContent => ({ mode: "replace", status: "pending", reason });

/** Caller authorizes the persisted record first. At most one foreground reader; no waiting queue. */
export async function readFeedbackDetailContent(
  record: FeedbackRecord,
  sessionStoreTemplate?: string,
  options: { workerUrl?: URL; timeoutMs?: number; storePath?: string } = {},
): Promise<ReportContent> {
  if (activeRead) {
    return pending("detail_busy");
  }
  const task: ActiveRead = {};
  activeRead = task;
  const endActivity = beginFeedbackForegroundActivity();
  try {
    const request: FeedbackContentRequest = {
      record: {
        agentId: record.agentId,
        sessionKey: record.sessionKey,
        ownerUserId: record.ownerUserId,
        answerHash: record.answerHash,
        transcript: record.transcript,
      },
      transcriptStorePath:
        options.storePath ??
        getDingTalkRuntime().channel.session.resolveStorePath(sessionStoreTemplate, {
          agentId: record.agentId,
        }),
      config: FEEDBACK_DETAIL_LIMITS,
    };
    return await new Promise<ReportContent>((resolve) => {
      let settled = false;
      const finish = (content: ReportContent) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadline);
        resolve(content);
      };
      const deadline = setTimeout(
        () => finish(pending("read_timeout")),
        options.timeoutMs ?? FEEDBACK_DETAIL_LIMITS.timeoutMs,
      );
      task.cancel = () => finish(pending("read_cancelled"));
      void (async () => {
        await waitForFeedbackBackgroundIdle();
        if (settled) {
          return;
        }
        const available =
          typeof process.availableMemory === "function" ? process.availableMemory() : freemem();
        if (available < FEEDBACK_DETAIL_LIMITS.workerMemoryMb * 2 * 1048576) {
          finish(pending("resource_budget"));
          return;
        }
        const worker = new Worker(
          options.workerUrl ?? new URL("./feedback-detail-worker.js", import.meta.url),
          {
            workerData: { kind: "dingtalk-feedback-detail", request },
            execArgv: [],
            resourceLimits: {
              maxOldGenerationSizeMb: FEEDBACK_DETAIL_LIMITS.workerMemoryMb,
              maxYoungGenerationSizeMb: 16,
              stackSizeMb: 4,
            },
          },
        );
        task.worker = worker;
        worker.once("error", () => finish(pending("read_failed")));
        worker.once("exit", () => finish(pending("read_failed")));
        worker.once("message", (result: { kind?: string; content?: ReportContent }) => {
          const content = result?.content;
          if (
            result?.kind !== "content" ||
            !content ||
            !["available", "pending", "missing", "unverified"].includes(content.status)
          ) {
            finish(pending("read_failed"));
            return;
          }
          if (
            content.status === "available" &&
            (typeof content.question !== "string" ||
              typeof content.answer !== "string" ||
              Buffer.byteLength(
                JSON.stringify({ question: content.question, answer: content.answer }),
              ) > FEEDBACK_DETAIL_LIMITS.maxContentBytes)
          ) {
            finish(pending("resource_budget"));
            return;
          }
          finish(content);
        });
        if (
          (worker.resourceLimits?.maxOldGenerationSizeMb ?? Infinity) >
          FEEDBACK_DETAIL_LIMITS.workerMemoryMb
        ) {
          finish(pending("resource_budget"));
        }
      })().catch(() => finish(pending("read_failed")));
    });
  } finally {
    try {
      await task.worker?.terminate();
    } finally {
      if (activeRead === task) {
        activeRead = undefined;
      }
      endActivity();
    }
  }
}

export async function stopFeedbackDetailReads(): Promise<void> {
  const task = activeRead;
  task?.cancel?.();
  await task?.worker?.terminate();
}
