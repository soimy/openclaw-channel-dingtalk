import { rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFeedbackReporting } from "../../src/command/feedback-reporting-config";
import {
  reportPaths,
  writeReportJson,
  readSmallJson,
} from "../../src/command/feedback-reporting-io";
import {
  createReportEnvelope,
  type ReportState,
} from "../../src/command/feedback-reporting-protocol";
import { FeedbackReportingService } from "../../src/command/feedback-reporting-service";
import {
  registerFeedbackCard,
  completeFeedbackCard,
  applyFeedback,
  readFeedbackRecord,
} from "../../src/command/feedback-store";
import { reportingFixture } from "../unit/fixtures/feedback-reporting";
const services: FeedbackReportingService[] = [],
  servers: Server[] = [],
  dirs: string[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw Error("condition timed out");
    await sleep(20);
  }
}
async function setup(budgets?: [number, number]) {
  const bodies: any[] = [];
  const control = { status: 200 };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    bodies.push(b);
    if (control.status !== 200) {
      res.writeHead(control.status);
      res.end("{}");
      return;
    }
    res.end(
      JSON.stringify({
        schemaVersion: 1,
        recordId: b.recordId,
        acceptedRevision: b.revision,
        status: "applied",
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((r, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", r);
  });
  const f = await reportingFixture(`http://127.0.0.1:${(server.address() as any).port}/report`);
  dirs.push(f.dir);
  const raw = {
    enabled: true,
    endpoint: f.config.endpoint,
    tenantId: "test-org",
    instanceId: "test-instance",
    token: "test-only-token",
    idleMs: 1000,
    maxTranscriptBytes: 65536,
  };
  const accounts = budgets
    ? Object.fromEntries(
        ["a", "b"].map((id, i) => [
          id,
          {
            clientId: "synthetic-" + id,
            clientSecret: "synthetic",
            feedbackEnabled: true,
            feedbackReporting: { ...raw, workerMemoryMb: budgets[i] },
          },
        ]),
      )
    : undefined;
  const host: any = {
    config: {
      channels: {
        dingtalk: accounts
          ? { accounts }
          : {
              clientId: "synthetic",
              clientSecret: "synthetic",
              feedbackEnabled: true,
              feedbackReporting: raw,
            },
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      channel: {
        session: {
          resolveStorePath: (_s: unknown, p: { agentId: string }) =>
            p.agentId === "main"
              ? f.job.transcriptStorePath
              : accounts
                ? path.join(f.dir, p.agentId, "sessions.json")
                : f.job.scope.storePath,
        },
      },
      events: { onAgentEvent: () => () => {} },
    },
  };
  const make = () => {
    const s = new FeedbackReportingService(host, {
      startupDelayMs: 0,
      tickMs: 5,
      scanPauseMs: 0,
      workerUrl: pathToFileURL(path.resolve(".local/test-runtime/feedback-reporting-worker.js")),
    });
    services.push(s);
    return s;
  };
  const configFor = (id = "default") =>
    resolveFeedbackReporting(accounts ? accounts[id].feedbackReporting : raw)!;
  const scopeFor = (id = "default") => ({
    accountId: id,
    storePath: host.runtime.channel.session.resolveStorePath(null, { agentId: id }),
  });
  const vote = (cardId: string, value: "like" | "none", id = "default") =>
    applyFeedback(
      scopeFor(id),
      {
        outTrackId: cardId,
        userId: "alice",
        eventId: `${cardId}-${value}-${Date.now()}`,
        eventAt: Date.now(),
        vote: value,
      },
      Date.now(),
      configFor(id),
    );
  const seed = async (cardId: string, file = f.sessionFile, id = "default") => {
    const scope = scopeFor(id);
    await registerFeedbackCard(scope, {
      outTrackId: cardId,
      ownerUserId: "alice",
      conversationId: "synthetic-group",
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    await completeFeedbackCard(scope, cardId, "Answer", undefined, {
      ...f.job.record.transcript!,
      localFile: file,
    } as any);
    await vote(cardId, "like", id);
  };
  return { ...f, bodies, control, make, seed, vote, configFor, scopeFor };
}
describe("fair durable feedback scheduling", () => {
  it("lets a new rating through 128 acknowledged-but-pending bodies and preserves delayed retries across restart", async () => {
    const f = await setup();
    const large = path.join(f.dir, "oversized.jsonl");
    await writeFile(
      large,
      f.events.map((e) => JSON.stringify(e)).join("\n") +
        "\n" +
        JSON.stringify({
          type: "message",
          id: "tool",
          message: { role: "toolResult", content: "x".repeat(65536) },
        }) +
        "\n",
    );
    const s = f.make();
    s.start();
    s.setForeground("setup", true);
    for (let offset = 0; offset < 128; offset += 8)
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => f.seed(`pending-${offset + i}`, large)),
      );
    await f.seed("new-rating");
    s.setForeground("setup", false);
    await until(() => f.bodies.some((b) => b.cardId === "new-rating"));
    await until(() => f.bodies.length === 129 && s.status().queued === 0 && !s.status().scanning);
    expect(f.bodies.filter((b) => b.content.status === "pending")).toHaveLength(128);
    expect(s.status().delayed).toBe(128);
    expect(s.status().timerScheduled).toBe(true);
    await s.stop();
    expect(s.status().delayed).toBe(0);
    const resumed = f.make();
    resumed.start();
    await sleep(1500);
    expect(f.bodies).toHaveLength(129);
    await f.vote("pending-0", "none");
    await until(() => f.bodies.some((b) => b.cardId === "pending-0" && b.feedback.vote === "none"));
    expect(f.bodies.at(-1).feedback.vote).toBe("none");
  }, 25000);

  it.each([
    [128, 64],
    [64, 128],
  ] as [number, number][])(
    "switches %i to %i MiB across accounts without recording a failed delivery",
    async (a, b) => {
      const f = await setup([a, b]);
      const s = f.make();
      s.start();
      s.setForeground("setup", true);
      await f.seed("first", f.sessionFile, "a");
      await f.seed("second", f.sessionFile, "b");
      s.setForeground("setup", false);
      await until(() => s.status().delivered === 2, 6000);
      expect(f.bodies.map((x) => x.source.accountId)).toEqual(["a", "b"]);
      expect(s.status()).toMatchObject({ failures: 0, workersStarted: 2 });
    },
    10000,
  );

  it("keeps foreground priority when activity starts during an account budget switch", async () => {
    const f = await setup([128, 64]);
    const s = f.make();
    s.start();
    await f.seed("first", f.sessionFile, "a");
    await until(() => s.status().delivered === 1);
    const terminate = Worker.prototype.terminate;
    let injected = false;
    const spy = vi.spyOn(Worker.prototype, "terminate").mockImplementation(async function () {
      const result = await terminate.call(this);
      if (!injected) {
        injected = true;
        s.setForeground("detail-query", true);
      }
      return result;
    });
    try {
      await f.seed("second", f.sessionFile, "b");
      await until(() => injected && !s.status().workerActive);
      await sleep(100);
      expect(f.bodies).toHaveLength(1);
      expect(s.status()).toMatchObject({ failures: 0, workersStarted: 1, foregroundRuns: 1 });
      s.setForeground("detail-query", false);
      await until(() => s.status().delivered === 2);
      expect(s.status()).toMatchObject({ failures: 0, workersStarted: 2 });
    } finally {
      spy.mockRestore();
    }
  }, 10000);

  it("runs one-time maintenance for legacy terminal receipts that normal recovery would skip", async () => {
    const f = await setup();
    await f.seed("legacy");
    const scope = f.scopeFor(),
      record = await readFeedbackRecord(scope, "legacy");
    const job = { ...f.job, scope, record: record!, config: { ...f.job.config, ...f.configFor() } };
    const paths = reportPaths(scope, "legacy", f.configFor().destinationKey);
    const state: ReportState = {
      sourceRevision: 1,
      wireRevision: 10,
      terminal: true,
      superseded: true,
      delivered: false,
      nextAttemptAt: 0,
      expiresAt: Date.now() + 86400000,
      attempts: 0,
      destinationKey: f.configFor().destinationKey,
      envelope: createReportEnvelope(job, 1, {
        mode: "replace",
        status: "available",
        question: "Question",
        answer: "Answer",
      }),
    };
    await writeReportJson(paths.state, state);
    await writeReportJson(paths.receipt, {
      sourceRevision: 1,
      wireRevision: 10,
      terminal: true,
      superseded: true,
      nextAttemptAt: 0,
      expiresAt: state.expiresAt,
      attempts: 0,
    });
    const s = f.make();
    s.start();
    await until(() => s.status().superseded === 1);
    expect(f.bodies).toHaveLength(0);
    expect(
      (await readSmallJson<ReportState>(paths.state))?.envelope.content.answer,
    ).toBeUndefined();
    await s.stop();
    const next = f.make();
    next.start();
    await sleep(1500);
    expect(next.status().workersStarted).toBe(0);
  }, 10000);
  it("keeps HTTP retry backoff durable without reserving a ready slot", async () => {
    const f = await setup();
    f.control.status = 503;
    const first = f.make();
    first.start();
    await f.seed("retry");
    await until(() => f.bodies.length === 1 && first.status().queued === 0);
    const paths = reportPaths(f.scopeFor(), "retry", f.configFor().destinationKey);
    const receipt = await readSmallJson<{ nextAttemptAt: number; error: string }>(paths.receipt);
    expect(receipt?.error).toBe("http_503");
    expect(receipt!.nextAttemptAt).toBeGreaterThan(Date.now());
    await first.stop();
    f.control.status = 200;
    const next = f.make();
    next.start();
    await sleep(1500);
    expect(f.bodies).toHaveLength(1);
    await until(() => next.status().delivered === 1);
    expect(f.bodies[1]).toEqual(f.bodies[0]);
    expect(next.status().queued).toBe(0);
  }, 15000);
});
