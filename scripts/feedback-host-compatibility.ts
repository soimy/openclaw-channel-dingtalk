/** Developer acceptance probe. Run with an isolated OPENCLAW_STATE_DIR and host SDK. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readFeedbackDetailContent } from "../src/command/feedback-detail-reader";
import { resolveFeedbackReporting } from "../src/command/feedback-reporting-config";
import { collectReportContent } from "../src/command/feedback-reporting-content";
import type { ReportJob, ReportResult } from "../src/command/feedback-reporting-protocol";
import {
  completeFeedbackCard,
  registerFeedbackCard,
  applyFeedback,
  readFeedbackRecord,
} from "../src/command/feedback-store";
import { feedbackHttpReceiver } from "../tests/integration/fixtures/feedback-http-receiver";
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    version: { type: "string" },
    worker: { type: "string" },
    "detail-worker": { type: "string" },
    "large-detail": { type: "boolean", default: false },
    output: { type: "string" },
  },
});
assert(values.root && values.version && values.worker, "Provide --root, --version and --worker");
await mkdir(values.root, { recursive: true });
const directory = await mkdtemp(path.join(path.resolve(values.root), "probe-"));
const receiver = await feedbackHttpReceiver(directory);
const sessionId = "11111111-1111-4111-8111-111111111111";
const target = {
  agentId: "main",
  sessionKey: "agent:main:main",
  sessionId,
  storePath: path.join(directory, "agents/main/sessions/sessions.json"),
  env: { OPENCLAW_STATE_DIR: directory },
};
const scope = { accountId: "default", storePath: path.join(directory, "ratings/sessions.json") };
const config = resolveFeedbackReporting({
  enabled: true,
  endpoint: receiver.endpoint,
  tenantId: "test-org",
  instanceId: "test-instance",
  token: "test-only-token",
  idleMs: 1000,
})!;
const { token, ...publicConfig } = config;
const sdkEntry = "openclaw/plugin-sdk/session-transcript-runtime";
const sdk = await import(sdkEntry);
const answer = "Same fixed answer";
const checks: Record<string, boolean> = {};
let detailProbe: unknown;
const detailOptions = {
  storePath: target.storePath,
  workerUrl: pathToFileURL(
    path.resolve(
      values["detail-worker"] ??
        path.join(path.dirname(values.worker!), "feedback-detail-worker.js"),
    ),
  ),
};
async function worker(job: ReportJob) {
  const process = new Worker(path.resolve(values.worker!), {
    workerData: { kind: "dingtalk-feedback-report" },
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  try {
    return await new Promise<ReportResult>((resolve, reject) => {
      process.once("message", resolve);
      process.once("error", reject);
      process.once("exit", (code) => reject(new Error(`worker exited ${code}`)));
      process.postMessage({ kind: "job", job });
    });
  } finally {
    await process.terminate();
  }
}
try {
  await mkdir(path.dirname(target.storePath), { recursive: true });
  await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: Date.now() } });
  const append = (eventId: string, role: string, content: unknown) =>
    sdk.appendSessionTranscriptMessageByIdentity({
      ...target,
      eventId,
      message: {
        role,
        content,
        ...(role === "user" ? { senderId: "alice", sourceChannel: "dingtalk" } : {}),
      },
      updateMode: "none",
    });
  await append("q1", "user", "First question");
  await append("a1", "assistant", [
    { type: "thinking", thinking: "Never report this" },
    { type: "text", text: answer },
  ]);
  await append("q2", "user", "Different second question");
  await append("a2", "assistant", answer);
  await registerFeedbackCard(scope, {
    outTrackId: "host-card",
    ownerUserId: "alice",
    conversationId: "synthetic-test-group",
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    sourceMsgId: "platform-question-1",
  });
  await completeFeedbackCard(scope, "host-card", answer, undefined, {
    status: "linked",
    source: "runtime-events",
    sessionId,
    userMessageId: "q1",
    assistantMessageId: "a1",
  });
  await applyFeedback(
    scope,
    {
      outTrackId: "host-card",
      userId: "alice",
      eventId: "like-1",
      eventAt: Date.now(),
      vote: "like",
    },
    Date.now(),
    config,
  );
  const record = await readFeedbackRecord(scope, "host-card");
  assert(record);
  const job: ReportJob = {
    scope,
    record,
    config: publicConfig,
    token: String(token),
    transcriptStorePath: target.storePath,
  };
  const content = await collectReportContent(job);
  assert.equal(content.status, "available");
  assert.equal(content.question, "First question");
  assert.equal(content.answer, answer);
  assert(!JSON.stringify(content).includes("Never report this"));
  checks.sqliteExactPairAndSameTextIsolation = true;
  const detail = await readFeedbackDetailContent(record, undefined, detailOptions);
  assert.equal(detail.status, "available");
  assert.equal(detail.question, "First question");
  checks.foregroundDetailWorker = true;
  assert.equal(record.answerHash, createHash("sha256").update(answer).digest("hex"));
  receiver.control.loseAck = true;
  const uncertain = await worker(job);
  assert(uncertain.kind === "done" && !uncertain.receipt.terminal);
  receiver.control.loseAck = false;
  const recovered = await worker(job);
  assert(recovered.kind === "done" && recovered.receipt.terminal);
  assert.deepEqual(receiver.requests[0], receiver.requests[1]);
  checks.sqliteWorkerHttpLostAckRestart = true;
  const withdrawal = await applyFeedback(
    scope,
    {
      outTrackId: "host-card",
      userId: "alice",
      eventId: "withdraw-2",
      eventAt: Date.now(),
      vote: "none",
    },
    Date.now(),
    config,
  );
  assert("record" in withdrawal);
  job.record = withdrawal.record;
  const withdrawn = await worker(job);
  assert(withdrawn.kind === "done" && withdrawn.receipt.terminal);
  const row = receiver.read(receiver.requests[0].recordId)!;
  assert.equal(JSON.parse(row.snapshot).feedback.vote, "none");
  assert.equal(JSON.parse(row.content).question, "First question");
  checks.withdrawalPreservesCommittedBody = true;
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: "22222222-2222-4222-8222-222222222222", updatedAt: Date.now() },
  });
  assert.equal((await collectReportContent(job)).status, "available");
  checks.resetKeepsExactOldSession = true;
  assert.equal(
    (await readFeedbackDetailContent(record, undefined, detailOptions)).question,
    "First question",
  );
  checks.foregroundDetailAfterReset = true;
  const missingJob = structuredClone(job);
  assert(missingJob.record.transcript?.status === "linked");
  missingJob.record.transcript.sessionId = "33333333-3333-4333-8333-333333333333";
  assert.equal((await collectReportContent(missingJob)).status, "missing");
  checks.missingSession = true;
  const mismatch = structuredClone(job);
  mismatch.record.answerHash = "0".repeat(64);
  assert.equal((await collectReportContent(mismatch)).status, "unverified");
  checks.hashMismatch = true;
  if (values["large-detail"]) {
    // Seed a separate large transcript through the actual host API. No employee data.
    const largeTarget = {
      ...target,
      sessionKey: "agent:main:large-detail",
      sessionId: "44444444-4444-4444-8444-444444444444",
    };
    await upsertSessionEntry({
      ...largeTarget,
      entry: { sessionId: largeTarget.sessionId, updatedAt: Date.now() },
    });
    for (let offset = 0; offset < 4096; offset += 256) {
      await sdk.appendSessionTranscriptMessagesByIdentity({
        ...largeTarget,
        messages: Array.from({ length: 256 }, (_, index) => ({
          eventId: `large-${offset + index}`,
          message: { role: "assistant", content: [{ type: "text", text: "x".repeat(8192) }] },
        })),
      });
    }
    const largeRecord = structuredClone(record);
    assert(largeRecord.transcript?.status === "linked");
    largeRecord.sessionKey = largeTarget.sessionKey;
    largeRecord.transcript.sessionId = largeTarget.sessionId;
    let ticks = 0,
      last = performance.now(),
      maxLagMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxLagMs = Math.max(maxLagMs, now - last - 10);
      last = now;
      ticks++;
    }, 10);
    const started = performance.now(),
      heap = process.memoryUsage().heapUsed;
    let result;
    try {
      result = await readFeedbackDetailContent(largeRecord, undefined, detailOptions);
    } finally {
      clearInterval(timer);
    }
    detailProbe = {
      storage: "host-sqlite",
      rows: 4096,
      textMiB: 32,
      status: result.status,
      reason: result.reason,
      elapsedMs: performance.now() - started,
      callerTimerTicks: ticks,
      callerMaxLagMs: maxLagMs,
      callerHeapDeltaMiB: (process.memoryUsage().heapUsed - heap) / 1048576,
    };
    assert.equal(result.status, "pending");
    assert.equal(result.reason, "resource_budget");
    assert(ticks > 0, "caller event loop must keep running during detail reads");
    checks.boundedLargeDetailWorker = true;
  }
  const report =
    JSON.stringify(
      {
        version: values.version,
        checks,
        detailProbe,
        receiverPort: Number(new URL(receiver.endpoint).port),
        pid: process.pid,
        runtime: process.version,
        sdk: "public session-store-runtime + session-transcript-runtime",
        result: "passed",
      },
      null,
      2,
    ) + "\n";
  if (values.output) await writeFile(values.output, report);
  else process.stdout.write(report);
} finally {
  await receiver.close();
  await rm(directory, { recursive: true, force: true });
}
