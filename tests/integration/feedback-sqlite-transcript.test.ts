import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { collectReportContent } from "../../src/command/feedback-reporting-content";
import { reportingFixture } from "../unit/fixtures/feedback-reporting";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const f = await reportingFixture();
  directories.push(f.dir);
  f.job.transcriptStorePath = path.join(f.dir, "agents/main/sessions/sessions.json");
  await mkdir(path.dirname(f.job.transcriptStorePath), { recursive: true });
  const link = f.job.record.transcript;
  if (link?.status !== "linked") throw new Error("expected exact fixture link");
  const target = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: link.sessionId,
    storePath: f.job.transcriptStorePath,
    env: { OPENCLAW_STATE_DIR: f.dir },
  };
  const entryPoint = "openclaw/plugin-sdk/session-transcript-runtime";
  const sdk = await import(entryPoint);
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  await sdk.appendSessionTranscriptMessageByIdentity({
    ...target,
    eventId: "q1",
    message: { role: "user", content: "Question", senderId: "alice", sourceChannel: "dingtalk" },
    updateMode: "none",
  });
  await sdk.appendSessionTranscriptMessageByIdentity({
    ...target,
    eventId: "a1",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Answer" },
        { type: "thinking", thinking: "Private reasoning" },
      ],
    },
    updateMode: "none",
  });
  return { ...f, target, sdk, link };
}
describe("OpenClaw 2026.8.1 actual SQLite transcript adapter", () => {
  it("reads the exact visible pair from a real host-created SQLite transcript", async () => {
    const f = await fixture();
    expect(await collectReportContent(f.job)).toMatchObject({
      status: "available",
      question: "Question",
      answer: "Answer",
      answerHash: f.job.record.answerHash,
    });
  });
  it("does not replace an older pair when a later answer has identical text", async () => {
    const f = await fixture();
    await f.sdk.appendSessionTranscriptMessageByIdentity({
      ...f.target,
      eventId: "q2",
      message: {
        role: "user",
        content: "Different question",
        senderId: "alice",
        sourceChannel: "dingtalk",
      },
      updateMode: "none",
    });
    await f.sdk.appendSessionTranscriptMessageByIdentity({
      ...f.target,
      eventId: "a2",
      message: { role: "assistant", content: "Answer" },
      updateMode: "none",
    });
    expect(await collectReportContent(f.job)).toMatchObject({
      status: "available",
      question: "Question",
    });
  });
  it("keeps using the saved SQLite session identity after the route is reset", async () => {
    const f = await fixture();
    await upsertSessionEntry({
      ...f.target,
      entry: {
        sessionId: "22222222-2222-4222-8222-222222222222",
        updatedAt: Date.now(),
      },
    });
    expect(await collectReportContent(f.job)).toMatchObject({
      status: "available",
      question: "Question",
    });
  });
  it("reports a missing SQLite session without consulting a more recent one", async () => {
    const f = await fixture();
    f.link.sessionId = "33333333-3333-4333-8333-333333333333";
    expect(await collectReportContent(f.job)).toMatchObject({
      status: "missing",
      reason: "transcript_not_found",
    });
  });
});
