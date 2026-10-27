import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { onFeedbackReportPending } from "../../src/command/feedback-reporting-events";
import {
  registerFeedbackCard,
  completeFeedbackCard,
  applyFeedback,
  readFeedbackRecord,
  cleanupFeedbackRecords,
  feedbackStats,
} from "../../src/command/feedback-store";
import { reportingFixture } from "./fixtures/feedback-reporting";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const f = await reportingFixture();
  dirs.push(f.dir);
  await registerFeedbackCard(f.job.scope, {
    outTrackId: f.job.record.outTrackId,
    ownerUserId: f.job.record.ownerUserId,
    conversationId: f.job.record.conversationId,
    agentId: f.job.record.agentId,
    sessionKey: f.job.record.sessionKey,
    sourceMsgId: f.job.record.sourceMsgId,
  });
  await completeFeedbackCard(f.job.scope, "card-1", "Answer", undefined, f.job.record.transcript);
  return f;
}
const change = (at: number, id: string, vote: "like" | "dislike" | "none") => ({
  outTrackId: "card-1",
  userId: "alice",
  eventId: id,
  eventAt: at,
  vote,
});
describe("atomic reporting intent", () => {
  it("does no reporting work while disabled", async () => {
    const f = await setup();
    await applyFeedback(f.job.scope, change(Date.now(), "a", "like"));
    expect((await readFeedbackRecord(f.job.scope, "card-1"))?.reporting).toBeUndefined();
  });
  it("persists a reporting revision before publishing a lightweight hint", async () => {
    const f = await setup();
    let calls = 0;
    const stop = onFeedbackReportPending(() => {
      calls++;
    });
    try {
      await applyFeedback(f.job.scope, change(Date.now(), "a", "like"), Date.now(), f.config);
      expect(calls).toBe(1);
      expect((await readFeedbackRecord(f.job.scope, "card-1"))?.reporting).toMatchObject({
        revision: 1,
        destinationKey: f.config.destinationKey,
      });
    } finally {
      stop();
    }
  });
  it("does not publish a never-rated initial cancellation", async () => {
    const f = await setup();
    await applyFeedback(f.job.scope, change(Date.now(), "a", "none"), Date.now(), f.config);
    expect((await readFeedbackRecord(f.job.scope, "card-1"))?.reporting).toBeUndefined();
  });
  it("increments on withdrawal and does not increment duplicate or foreign votes", async () => {
    const f = await setup();
    const t = Date.now();
    await applyFeedback(f.job.scope, change(t, "a", "like"), t, f.config);
    await applyFeedback(f.job.scope, change(t + 1, "b", "none"), t + 1, f.config);
    await applyFeedback(f.job.scope, change(t + 1, "b", "none"), t + 2, f.config);
    await applyFeedback(
      f.job.scope,
      { ...change(t + 3, "c", "like"), userId: "bob" },
      t + 3,
      f.config,
    );
    expect((await readFeedbackRecord(f.job.scope, "card-1"))?.reporting?.revision).toBe(2);
  });
  it("keeps later local changes recoverable while reporting is temporarily disabled", async () => {
    const f = await setup();
    const t = Date.now();
    await applyFeedback(f.job.scope, change(t, "a", "like"), t, f.config);
    await applyFeedback(f.job.scope, change(t + 1, "b", "none"), t + 1);
    expect((await readFeedbackRecord(f.job.scope, "card-1"))?.reporting?.revision).toBe(2);
  });
  it("retains expired pending intent without counting it in visible stats", async () => {
    const f = await setup();
    const t = Date.now();
    await registerFeedbackCard(f.job.scope, { ...f.job.record, outTrackId: "short" }, 1, t);
    await completeFeedbackCard(f.job.scope, "short", "Answer", t);
    await applyFeedback(
      f.job.scope,
      { ...change(t + 1, "a", "like"), outTrackId: "short" },
      t + 1,
      f.config,
    );
    await cleanupFeedbackRecords(f.job.scope, t + 2 * 86400000);
    expect(await readFeedbackRecord(f.job.scope, "short")).toBeDefined();
    expect((await feedbackStats(f.job.scope, "alice", 30, t + 2 * 86400000)).total).toBe(1);
    await cleanupFeedbackRecords(f.job.scope, t + 8 * 86400000);
    expect(await readFeedbackRecord(f.job.scope, "short")).toBeUndefined();
  });
});
