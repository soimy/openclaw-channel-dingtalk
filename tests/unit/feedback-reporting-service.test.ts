import { rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFeedbackForegroundActivity } from "../../src/command/feedback-reporting-events";
import * as reportingIO from "../../src/command/feedback-reporting-io";
import { FeedbackReportingService } from "../../src/command/feedback-reporting-service";
import {
  registerFeedbackCard,
  completeFeedbackCard,
  applyFeedback,
} from "../../src/command/feedback-store";
import { reportingFixture } from "./fixtures/feedback-reporting";
const services: FeedbackReportingService[] = [];
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.stop()));
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 12000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw Error("condition timeout");
    await sleep(25);
  }
}
async function setup(slow = false) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let t = "";
    req.on("data", (c) => (t += c));
    req.on("end", () => {
      const b = JSON.parse(t);
      bodies.push(b);
      if (!slow)
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            recordId: b.recordId,
            acceptedRevision: b.revision,
            status: "applied",
          }),
        );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const f = await reportingFixture(`http://127.0.0.1:${(server.address() as any).port}/report`);
  dirs.push(f.dir);
  const raw = {
    enabled: true,
    endpoint: f.config.endpoint,
    tenantId: f.config.tenantId,
    instanceId: f.config.instanceId,
    token: "test-only-token",
    idleMs: 1000,
    requestTimeoutMs: 5000,
  };
  const api: any = {
    config: {
      channels: {
        dingtalk: {
          clientId: "app",
          clientSecret: "test",
          feedbackEnabled: true,
          feedbackReporting: raw,
        },
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      channel: {
        session: {
          resolveStorePath: (_s: any, o: any) =>
            o.agentId === "default" ? f.job.scope.storePath : f.job.transcriptStorePath,
        },
      },
      events: { onAgentEvent: () => () => {} },
    },
  };
  const binding = {
    outTrackId: "card-1",
    ownerUserId: "alice",
    agentId: "main",
    sessionKey: "agent:main:main",
    conversationId: "cid-1",
  };
  await registerFeedbackCard(f.job.scope, binding);
  await completeFeedbackCard(f.job.scope, "card-1", "Answer", undefined, f.job.record.transcript);
  const make = () => {
    const s = new FeedbackReportingService(api, {
      startupDelayMs: 0,
      tickMs: 20,
      scanPauseMs: 1,
      workerUrl: pathToFileURL(path.resolve(".local/test-runtime/feedback-reporting-worker.js")),
    });
    services.push(s);
    return s;
  };
  const vote = async (v: "like" | "none", n: number) => {
    await applyFeedback(
      f.job.scope,
      { outTrackId: "card-1", userId: "alice", eventId: `e-${n}`, eventAt: Date.now(), vote: v },
      Date.now(),
      f.config,
    );
  };
  return { ...f, api, bodies, make, vote };
}
describe("isolated reporting scheduler", () => {
  it("preserves a new hint even when the final metadata read returns a pre-rename snapshot", async () => {
    const f = await setup();
    const original = reportingIO.readSmallJson;
    let injected = false;
    const spy = vi.spyOn(reportingIO, "readSmallJson").mockImplementation(async (file, limit) => {
      const row = await original(file, limit);
      if (!injected && f.bodies.length === 1 && file.includes("feedback.ratings.")) {
        injected = true;
        await f.vote("none", 2);
      }
      return row;
    });
    try {
      const s = f.make();
      s.start();
      await f.vote("like", 1);
      await until(() => f.bodies.length >= 2);
      expect(f.bodies.at(-1).feedback.vote).toBe("none");
    } finally {
      spy.mockRestore();
    }
  }, 15000);
  it("defers reporting for non-Agent inbound operations too", async () => {
    const f = await setup();
    const s = f.make();
    s.start();
    await withFeedbackForegroundActivity(async () => {
      await f.vote("like", 1);
      await sleep(1300);
      expect(s.status().workersStarted).toBe(0);
      expect(s.status().timerScheduled).toBe(false);
    });
    await until(() => f.bodies.length === 1);
  }, 15000);

  it("reuses a bounded worker for a burst and releases it for foreground work", async () => {
    const f = await setup();
    const s = f.make();
    s.start();
    await f.vote("like", 1);
    await until(() => s.status().delivered === 1);
    await f.vote("none", 2);
    await until(() => s.status().delivered === 2);
    expect(s.status().workersStarted).toBe(1);
    s.setForeground("foreground", true);
    await until(() => !s.status().workerResident);
  }, 15000);

  it("does not block startup and recovers a durable vote without an in-memory hint", async () => {
    const f = await setup();
    await f.vote("like", 1);
    const s = f.make();
    const t = performance.now();
    s.start();
    expect(performance.now() - t).toBeLessThan(20);
    await until(() => f.bodies.length === 1);
    expect(f.bodies[0].content).toMatchObject({
      status: "available",
      question: "Question",
      answer: "Answer",
    });
    await until(() => s.status().delivered === 1);
    expect(s.status().workerActive).toBe(false);
  }, 15000);
  it("does no work while a foreground run is active, then resumes", async () => {
    const f = await setup();
    const s = f.make();
    s.start();
    s.setForeground("foreground", true);
    await f.vote("like", 1);
    await sleep(1300);
    expect(s.status().workersStarted).toBe(0);
    s.setForeground("foreground", false);
    await until(() => f.bodies.length === 1);
  }, 15000);
  it("interrupts a slow worker when foreground work starts and retains the task", async () => {
    const f = await setup(true);
    const s = f.make();
    s.start();
    await f.vote("like", 1);
    await until(() => f.bodies.length === 1);
    const t = performance.now();
    s.setForeground("foreground", true);
    expect(performance.now() - t).toBeLessThan(20);
    await until(() => !s.status().workerActive);
    expect(s.status().queued).toBe(1);
  }, 15000);
  it("coalesces superseded votes while busy and reports only the latest state", async () => {
    const f = await setup();
    const s = f.make();
    s.start();
    s.setForeground("foreground", true);
    await f.vote("like", 1);
    await f.vote("none", 2);
    s.setForeground("foreground", false);
    await until(() => f.bodies.length === 1);
    expect(f.bodies[0].feedback.vote).toBe("none");
  }, 15000);
  it("reports a budget-deferred body without blocking on a large transcript", async () => {
    const f = await setup();
    await writeFile(f.sessionFile, "x".repeat(9 * 1024 * 1024));
    const s = f.make();
    s.start();
    await f.vote("like", 1);
    await until(() => f.bodies.length === 1);
    expect(f.bodies[0].content).toMatchObject({ status: "pending", reason: "resource_budget" });
  }, 15000);
  it("waits for every foreground operation even above 1024 concurrent starts", async () => {
    const f = await setup();
    const service = f.make();
    service.start();
    for (let i = 0; i < 1100; i++) service.setForeground(`busy-${i}`, true);
    await f.vote("like", 1);
    for (let i = 0; i < 1024; i++) service.setForeground(`busy-${i}`, false);
    await sleep(1300);
    expect(service.status()).toMatchObject({
      foregroundRuns: 76,
      workersStarted: 0,
      timerScheduled: false,
    });
    for (let i = 1024; i < 1100; i++) service.setForeground(`busy-${i}`, false);
    await until(() => f.bodies.length === 1);
  }, 15000);
  it("reports from a large host process when sufficient memory remains available", async () => {
    const f = await setup();
    const actualMemory = process.memoryUsage();
    vi.spyOn(process, "memoryUsage").mockReturnValue({ ...actualMemory, rss: 1500 * 1048576 });
    vi.spyOn(process, "availableMemory").mockReturnValue(4 * 1024 * 1048576);
    const service = f.make();
    service.start();
    await f.vote("like", 1);
    await until(() => f.bodies.length === 1);
    expect(f.bodies[0].content.status).toBe("available");
  }, 15000);
  it("defers for insufficient memory headroom and recovers after memory becomes available", async () => {
    const f = await setup();
    const memory = vi.spyOn(process, "availableMemory").mockReturnValue(128 * 1048576);
    const service = f.make();
    service.start();
    await f.vote("like", 1);
    await sleep(1300);
    expect(service.status().workersStarted).toBe(0);
    expect(f.bodies).toHaveLength(0);
    memory.mockReturnValue(4 * 1024 * 1048576);
    await until(() => f.bodies.length === 1);
    expect(f.api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("resuming after resource pressure"),
    );
  }, 15000);
});
