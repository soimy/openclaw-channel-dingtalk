import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { reportPaths } from "../../src/command/feedback-reporting-io";
import {
  createReportEnvelope,
  type ReportJob,
  type ReportResult,
} from "../../src/command/feedback-reporting-protocol";
import { postFeedbackReport } from "../../src/command/feedback-reporting-transport";
import { reportingFixture } from "../unit/fixtures/feedback-reporting";
import { feedbackHttpReceiver } from "./fixtures/feedback-http-receiver";

const directories: string[] = [];
const receivers: Awaited<ReturnType<typeof feedbackHttpReceiver>>[] = [];
afterEach(async () => {
  for (const receiver of receivers.splice(0)) await receiver.close();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "feedback-db-"));
  directories.push(dir);
  const receiver = await feedbackHttpReceiver(dir);
  receivers.push(receiver);
  const fixture = await reportingFixture(receiver.endpoint);
  directories.push(fixture.dir);
  if (fixture.job.record.transcript?.status === "linked") {
    fixture.job.record.transcript.localFile = fixture.sessionFile;
  }
  return { ...fixture, receiver };
}
async function runFreshWorker(job: ReportJob) {
  const worker = new Worker(path.resolve(".local/test-runtime/feedback-reporting-worker.js"), {
    workerData: { kind: "dingtalk-feedback-report" },
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 64 },
  });
  try {
    return await new Promise<ReportResult>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`worker exited ${code}`)));
      worker.postMessage({ kind: "job", job });
    });
  } finally {
    await worker.terminate();
  }
}

describe("real HTTP and SQL transaction acknowledgement", () => {
  it("commits exactly the rated pair before ACK and releases local body after ACK", async () => {
    const f = await setup();
    expect(await runFreshWorker(f.job)).toMatchObject({
      kind: "done",
      receipt: { terminal: true },
    });
    const body = f.receiver.requests[0];
    // An independent database connection sees the committed row after the ACK.
    const observer = new DatabaseSync(f.receiver.databasePath, { readOnly: true });
    try {
      const row = observer
        .prepare("SELECT content FROM feedback WHERE record_id = ?")
        .get(body.recordId)!;
      expect(JSON.parse(String(row.content))).toMatchObject({
        question: "Question",
        answer: "Answer",
      });
    } finally {
      observer.close();
    }
    expect(JSON.stringify(body)).not.toMatch(/Never report this|localFile|history|seen/);
    const outbox = JSON.parse(
      await readFile(reportPaths(f.job.scope, "card-1", f.config.destinationKey).state, "utf8"),
    );
    expect(outbox.envelope.content.mode).toBe("preserve");
    expect(outbox.envelope.content.answer).toBeUndefined();
  });

  it("replays byte-identical requests after commit followed by lost ACK and worker restart", async () => {
    const f = await setup();
    f.receiver.control.loseAck = true;
    expect(await runFreshWorker(f.job)).toMatchObject({
      kind: "done",
      receipt: { terminal: false },
    });
    f.receiver.control.loseAck = false;
    expect(await runFreshWorker(f.job)).toMatchObject({
      kind: "done",
      receipt: { terminal: true },
    });
    expect(f.receiver.requests).toHaveLength(2);
    expect(f.receiver.requests[1]).toEqual(f.receiver.requests[0]);
    expect(f.receiver.read(f.receiver.requests[0].recordId)?.revision).toBe(1);
  });

  it.each(["failCommit", "badAck"] as const)(
    "retains the outbox for %s and recovers",
    async (fault) => {
      const f = await setup();
      f.receiver.control[fault] = true;
      expect(await runFreshWorker(f.job)).toMatchObject({
        kind: "done",
        receipt: { terminal: false },
      });
      if (fault === "failCommit")
        expect(f.receiver.read(f.receiver.requests[0].recordId)).toBeUndefined();
      f.receiver.control[fault] = false;
      expect(await runFreshWorker(f.job)).toMatchObject({
        kind: "done",
        receipt: { terminal: true },
      });
    },
  );

  it("stores withdrawal as the latest state and retains the original pair", async () => {
    const f = await setup();
    await runFreshWorker(f.job);
    f.job.record.vote = "none";
    f.job.record.reasons = [];
    f.job.record.reporting!.revision = 2;
    await runFreshWorker(f.job);
    const first = f.receiver.requests[0];
    const row = f.receiver.read(first.recordId)!;
    expect(JSON.parse(row.snapshot).feedback).toMatchObject({ vote: "none", reasons: [] });
    expect(JSON.parse(row.content)).toMatchObject({ question: "Question", answer: "Answer" });
    expect(await postFeedbackReport(f.config.endpoint, f.job.token, first, 1000)).toEqual({
      status: "stale",
      acceptedRevision: 2,
    });
    expect(f.receiver.read(first.recordId)?.revision).toBe(2);
  });

  it("does not duplicate rows under concurrent identical deliveries and rejects revision conflicts", async () => {
    const f = await setup();
    const envelope = createReportEnvelope(f.job, 1, {
      mode: "replace",
      status: "available",
      question: "Question",
      answer: "Answer",
      answerHash: f.job.record.answerHash,
    });
    const acks = await Promise.all(
      Array.from({ length: 32 }, () =>
        postFeedbackReport(f.config.endpoint, f.job.token, envelope, 2000),
      ),
    );
    expect(acks.filter((ack) => ack.status === "applied")).toHaveLength(1);
    expect(acks.filter((ack) => ack.status === "duplicate")).toHaveLength(31);
    await expect(
      postFeedbackReport(
        f.config.endpoint,
        f.job.token,
        {
          ...envelope,
          feedback: { ...envelope.feedback, vote: "like" },
        },
        1000,
      ),
    ).rejects.toThrow("http_409");
    expect(JSON.parse(f.receiver.read(envelope.recordId)!.snapshot).feedback.vote).toBe("dislike");
  });
});
