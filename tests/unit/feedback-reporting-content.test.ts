import { rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectLegacyTranscript,
  collectReportContent,
} from "../../src/command/feedback-reporting-content";
import { reportingFixture } from "./fixtures/feedback-reporting";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const f = await reportingFixture();
  dirs.push(f.dir);
  return f;
}
describe("bounded exact transcript collection", () => {
  it("uses a trusted local hint without needing the session index", async () => {
    const f = await setup();
    if (f.job.record.transcript?.status === "linked")
      f.job.record.transcript.localFile = f.sessionFile;
    await rm(f.job.transcriptStorePath);
    expect(await collectReportContent(f.job)).toMatchObject({
      status: "available",
      answer: "Answer",
    });
  });

  it("reads only the exact visible pair through a read-only legacy adapter", async () => {
    const f = await setup();
    const result = await collectReportContent(f.job);
    expect(result).toMatchObject({ status: "available", question: "Question", answer: "Answer" });
    expect(JSON.stringify(result)).not.toContain("Never report this");
  });
  it("marks a removed transcript missing", async () => {
    const f = await setup();
    await rm(f.sessionFile);
    expect(await collectReportContent(f.job)).toMatchObject({
      status: "missing",
      reason: "transcript_not_found",
    });
  });
  it("defers oversized transcripts instead of reading them into the gateway", async () => {
    const f = await setup();
    await writeFile(f.sessionFile, "x".repeat(65537));
    f.job.config.maxTranscriptBytes = 65536;
    expect(await collectLegacyTranscript(f.job, f.sessionFile)).toMatchObject({
      status: "pending",
      reason: "resource_budget",
    });
  });
  it("does not mistake a different session or changed answer for the original", async () => {
    const f = await setup();
    f.events[0].id = "other-session";
    await writeFile(f.sessionFile, f.events.map((x) => JSON.stringify(x)).join("\n"));
    expect(await collectLegacyTranscript(f.job, f.sessionFile)).toMatchObject({
      status: "unverified",
    });
  });
  it("does not report a question belonging to another sender", async () => {
    const f = await setup();
    f.events[1].message!.senderId = "bob";
    await writeFile(f.sessionFile, f.events.map((x) => JSON.stringify(x)).join("\n"));
    expect(await collectLegacyTranscript(f.job, f.sessionFile)).toMatchObject({
      status: "unverified",
    });
  });
  it("reports missing exact messages without replacing them with the latest", async () => {
    const f = await setup();
    f.events[2].id = "new-answer";
    await writeFile(f.sessionFile, f.events.map((x) => JSON.stringify(x)).join("\n"));
    expect(await collectLegacyTranscript(f.job, f.sessionFile)).toMatchObject({
      status: "missing",
      reason: "message_not_found",
    });
  });
  it("uses the saved main-session ID after reset without mutating host metadata", async () => {
    const f = await setup();
    await writeFile(
      f.job.transcriptStorePath,
      JSON.stringify({ "agent:main:main": { sessionId: "different", sessionFile: f.sessionFile } }),
    );
    expect(await collectReportContent(f.job)).toMatchObject({
      status: "available",
      question: "Question",
    });
  });
  it("does not silently truncate oversized question/answer pairs", async () => {
    const f = await setup();
    f.job.config.maxContentBytes = 8;
    expect(await collectLegacyTranscript(f.job, f.sessionFile)).toMatchObject({
      status: "pending",
      reason: "content_budget",
    });
  });
  it("does not guess content for older unlinked feedback", async () => {
    const f = await setup();
    delete f.job.record.transcript;
    expect(await collectReportContent(f.job)).toMatchObject({
      status: "missing",
      reason: "reference_not_recorded",
    });
  });
  it("supports metadata-only recovery after a bounded worker failure", async () => {
    const f = await setup();
    f.job.metadataOnly = true;
    expect(await collectReportContent(f.job)).toMatchObject({
      status: "pending",
      reason: "resource_budget",
    });
  });
});
