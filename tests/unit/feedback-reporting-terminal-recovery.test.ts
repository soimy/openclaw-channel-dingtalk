import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { collectReportContent } from "../../src/command/feedback-reporting-content";
import {
  reportPaths,
  readSmallJson,
  writeReportJson,
} from "../../src/command/feedback-reporting-io";
import {
  createReportEnvelope,
  type ReportState,
} from "../../src/command/feedback-reporting-protocol";
import { executeReportJob } from "../../src/command/feedback-reporting-worker";
import { reportingFixture } from "./fixtures/feedback-reporting";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup(stale = false) {
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    response.end(
      JSON.stringify({
        schemaVersion: 1,
        recordId: body.recordId,
        acceptedRevision: stale && bodies.length === 1 ? body.revision + 10 : body.revision,
        status: stale && bodies.length === 1 ? "stale" : "applied",
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const f = await reportingFixture(`http://127.0.0.1:${(server.address() as any).port}/report`);
  dirs.push(f.dir);
  if (f.job.record.transcript?.status === "linked")
    f.job.record.transcript.localFile = f.sessionFile;
  const paths = reportPaths(f.job.scope, f.job.record.outTrackId, f.config.destinationKey);
  return { ...f, paths, bodies };
}
function oldState(
  f: Awaited<ReturnType<typeof setup>>,
  content: ReportState["envelope"]["content"],
  superseded = false,
): ReportState {
  return {
    sourceRevision: 1,
    wireRevision: superseded ? 10 : 1,
    terminal: true,
    nextAttemptAt: 0,
    expiresAt: Date.now() + 86400000,
    attempts: 0,
    destinationKey: f.config.destinationKey,
    delivered: !superseded,
    superseded,
    envelope: createReportEnvelope(f.job, 1, content),
  };
}
describe("feedback terminal state recovery", () => {
  it("treats an oversized buffered JSONL row as a retryable resource budget", async () => {
    const f = await setup();
    const long = {
      type: "message",
      id: "tool",
      message: { role: "toolResult", content: "x".repeat(Math.ceil(1.2 * 1048576)) },
    };
    await writeFile(
      f.sessionFile,
      [f.events[0], f.events[1], long, f.events[2]].map((x) => JSON.stringify(x)).join("\n") + "\n",
    );
    expect((await readFile(f.sessionFile)).length).toBeLessThan(f.job.config.maxTranscriptBytes);
    expect(await collectReportContent(f.job)).toMatchObject({
      status: "pending",
      reason: "resource_budget",
    });
    expect(await executeReportJob(f.job)).toMatchObject({
      kind: "done",
      receipt: { terminal: false },
    });
    await writeFile(f.sessionFile, f.events.map((x) => JSON.stringify(x)).join("\n") + "\n");
    await executeReportJob(f.job);
    expect(f.bodies.at(-1).content).toMatchObject({
      status: "available",
      question: "Question",
      answer: "Answer",
    });
    expect(f.bodies.at(-1).revision).toBeGreaterThan(f.bodies[0].revision);
  });

  it("rechecks legacy invalid_transcript terminal records once using the current reader", async () => {
    const f = await setup();
    await writeReportJson(
      f.paths.state,
      oldState(f, { mode: "preserve", status: "unverified", reason: "invalid_transcript" }),
    );
    await executeReportJob(f.job);
    expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0]).toMatchObject({
      revision: 2,
      content: { status: "available", question: "Question" },
    });
    await executeReportJob(f.job);
    expect(f.bodies).toHaveLength(1);
  });

  it("does not repeatedly recheck a legacy record that remains genuinely invalid", async () => {
    const f = await setup();
    await writeFile(f.sessionFile, "broken-json\n");
    await writeReportJson(
      f.paths.state,
      oldState(f, { mode: "preserve", status: "unverified", reason: "invalid_transcript" }),
    );
    await executeReportJob(f.job);
    await executeReportJob(f.job);
    expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0].content.status).toBe("unverified");
  });

  it("replays an uncertain legacy envelope before rechecking its body", async () => {
    const f = await setup();
    const state = oldState(f, {
      mode: "replace",
      status: "unverified",
      reason: "invalid_transcript",
    });
    state.delivered = false;
    await writeReportJson(f.paths.state, state);
    const first = await executeReportJob(f.job);
    expect(f.bodies[0]).toEqual(state.envelope);
    expect(first).toMatchObject({ kind: "done", receipt: { terminal: false } });
    await executeReportJob(f.job);
    expect(f.bodies[1]).toMatchObject({ revision: 2, content: { status: "available" } });
  });

  it("releases superseded body text and rereads for a genuine newer vote", async () => {
    const f = await setup(true);
    await executeReportJob(f.job);
    const state = await readSmallJson<ReportState>(f.paths.state);
    expect(state?.envelope.content.question).toBeUndefined();
    expect(state?.envelope.content.answer).toBeUndefined();
    await executeReportJob(f.job);
    expect(f.bodies).toHaveLength(1);
    f.job.record.reporting!.revision++;
    f.job.record.vote = "none";
    await executeReportJob(f.job);
    expect(f.bodies[1]).toMatchObject({
      feedback: { vote: "none" },
      content: { mode: "replace", status: "available", question: "Question", answer: "Answer" },
    });
    expect(f.bodies[1].revision).toBeGreaterThan(11);
  });

  it("does not infer remote body availability from stale when the original transcript is gone", async () => {
    const f = await setup(true);
    await executeReportJob(f.job);
    await rm(f.sessionFile);
    f.job.record.reporting!.revision++;
    f.job.record.vote = "none";
    await executeReportJob(f.job);
    expect(f.bodies[1].content).toMatchObject({ mode: "replace", status: "missing" });
    expect(f.bodies[1].content.answer).toBeUndefined();
  });

  it("cleans pre-existing stale terminal outboxes during recovery without sending them", async () => {
    const f = await setup();
    await writeReportJson(
      f.paths.state,
      oldState(
        f,
        { mode: "replace", status: "available", question: "Question", answer: "Answer" },
        true,
      ),
    );
    await executeReportJob(f.job);
    await executeReportJob(f.job);
    expect(f.bodies).toHaveLength(0);
    const state = await readSmallJson<ReportState>(f.paths.state);
    expect(state?.envelope.content.question).toBeUndefined();
    expect(state?.envelope.content.answer).toBeUndefined();
  });
});
