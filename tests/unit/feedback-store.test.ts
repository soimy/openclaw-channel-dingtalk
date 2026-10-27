import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyFeedback,
  completeFeedbackCard,
  feedbackStats,
  registerFeedbackCard,
} from "../../src/command/feedback-store";

describe("durable owner-only feedback", () => {
  let dir: string;
  let scope: { storePath: string; accountId: string };
  const now = 1_800_000_000_000;
  const binding = {
    outTrackId: "card-1",
    ownerUserId: "alice",
    conversationId: "cid-group",
    sessionKey: "agent:mail:group",
    agentId: "mail",
    sourceMsgId: "incoming-1",
  };
  const change = {
    outTrackId: "card-1",
    userId: "alice",
    eventId: "event-1",
    eventAt: now + 10,
    vote: "like" as const,
  };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dt-feedback-"));
    scope = { storePath: path.join(dir, "sessions.json"), accountId: "default" };
    await registerFeedbackCard(scope, binding, 90, now);
    await completeFeedbackCard(scope, binding.outTrackId, "An answer", now + 1);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("stores an exact card binding and answer hash without duplicating body", async () => {
    const result = await applyFeedback(scope, change, now + 100);
    expect(result.status).toBe("saved");
    if (!("record" in result)) throw new Error("missing record");
    expect(result.record).toMatchObject({
      ownerUserId: "alice",
      sourceMsgId: "incoming-1",
      agentId: "mail",
      vote: "like",
    });
    expect(result.record.answerHash).toHaveLength(64);
    expect(JSON.stringify(result.record)).not.toContain("An answer");
  });
  it("rejects a different group member", async () => {
    expect(await applyFeedback(scope, { ...change, userId: "bob" }, now + 100)).toEqual({
      status: "forbidden",
    });
    expect((await feedbackStats(scope, "alice", 7, now + 100)).like).toBe(0);
  });
  it("does not fall back from an unknown historical card to the latest answer", async () => {
    expect(await applyFeedback(scope, { ...change, outTrackId: "old-card" }, now + 100)).toEqual({
      status: "unknown",
    });
  });
  it("isolates accounts", async () => {
    expect(await applyFeedback({ ...scope, accountId: "other" }, change, now + 100)).toEqual({
      status: "unknown",
    });
  });
  it("rejects feedback before a real answer completes", async () => {
    await registerFeedbackCard(scope, { ...binding, outTrackId: "pending" }, 90, now);
    expect(await applyFeedback(scope, { ...change, outTrackId: "pending" }, now + 100)).toEqual({
      status: "unfinished",
    });
  });
  it("does not overwrite ownership when the same card is registered again", async () => {
    await expect(
      registerFeedbackCard(scope, { ...binding, ownerUserId: "bob" }, 90, now),
    ).rejects.toThrow("ownership conflict");
  });
  it("deduplicates retries using the transport message id", async () => {
    await applyFeedback(scope, change, now + 100);
    const retry = await applyFeedback(scope, change, now + 101);
    expect(retry.status).toBe("duplicate");
    if ("record" in retry) expect(retry.record.history).toHaveLength(1);
    expect((await feedbackStats(scope, "alice", 7, now + 102)).like).toBe(1);
  });
  it("withdraws both votes and excludes withdrawals from the totals", async () => {
    for (const [i, vote] of (["like", "none", "dislike", "none"] as const).entries()) {
      await applyFeedback(
        scope,
        { ...change, vote, eventId: String(i), eventAt: now + 10 + i },
        now + 100,
      );
    }
    expect(await feedbackStats(scope, "alice", 7, now + 100)).toMatchObject({
      total: 1,
      like: 0,
      dislike: 0,
    });
  });
  it("switches mutually exclusive votes and clears obsolete reasons", async () => {
    await applyFeedback(scope, { ...change, vote: "dislike" }, now + 100);
    await applyFeedback(
      scope,
      { ...change, vote: undefined, reasons: ["2", "3"], eventId: "reasons", eventAt: now + 11 },
      now + 100,
    );
    expect((await feedbackStats(scope, "alice", 7, now + 100)).reasons).toEqual({ "2": 1, "3": 1 });
    await applyFeedback(scope, { ...change, eventId: "switch", eventAt: now + 12 }, now + 100);
    expect(await feedbackStats(scope, "alice", 7, now + 100)).toMatchObject({
      like: 1,
      dislike: 0,
      reasons: {},
    });
  });
  it("rejects old events instead of resurrecting a cancelled vote", async () => {
    await applyFeedback(scope, { ...change, vote: "none", eventAt: now + 30 }, now + 100);
    expect((await applyFeedback(scope, { ...change, eventId: "late" }, now + 100)).status).toBe(
      "stale",
    );
  });
  it("does not accept a delayed reason submission after withdrawal", async () => {
    expect(
      (await applyFeedback(scope, { ...change, vote: undefined, reasons: ["2"] }, now + 100))
        .status,
    ).toBe("stale");
  });
  it("serializes simultaneous retries and changes without losing the latest state", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        applyFeedback(
          scope,
          { ...change, eventId: `e-${i}`, eventAt: now + i + 10, vote: i % 2 ? "dislike" : "like" },
          now + 100,
        ),
      ),
    );
    expect(results.every((r) => r.status === "saved")).toBe(true);
    expect(await feedbackStats(scope, "alice", 7, now + 100)).toMatchObject({
      like: 0,
      dislike: 1,
    });
  });
  it("reads persisted votes through a fresh scope object", async () => {
    await applyFeedback(scope, change, now + 100);
    expect((await feedbackStats({ ...scope }, "alice", 7, now + 100)).like).toBe(1);
    const files = await readdir(path.join(dir, "dingtalk-state"));
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  it("excludes other owners from self-service statistics", async () => {
    await applyFeedback(scope, change, now + 100);
    expect(await feedbackStats(scope, "bob", 7, now + 100)).toEqual({
      total: 0,
      like: 0,
      dislike: 0,
      reasons: {},
    });
  });
  it("expires old records and never registers an old card from click data", async () => {
    expect(await applyFeedback(scope, change, now + 91 * 86400000)).toEqual({ status: "expired" });
    expect((await feedbackStats(scope, "alice", 365, now + 91 * 86400000)).total).toBe(0);
  });
  it("surfaces corrupt persistence instead of reporting success or overwriting it", async () => {
    const directory = path.join(dir, "dingtalk-state");
    const file = path.join(directory, (await readdir(directory))[0]);
    await writeFile(file, "broken");
    await expect(applyFeedback(scope, change, now + 100)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("broken");
  });
});
