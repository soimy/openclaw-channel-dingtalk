import { mkdir, opendir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSmallJson, reportPaths } from "../../src/command/feedback-reporting-io";
import {
  REPORT_MAINTENANCE_VERSION,
  type ReportReceipt,
} from "../../src/command/feedback-reporting-protocol";
import { FeedbackReportingService } from "../../src/command/feedback-reporting-service";
import {
  registerFeedbackCard,
  completeFeedbackCard,
  applyFeedback,
  feedbackRecordPath,
} from "../../src/command/feedback-store";
import { reportingFixture } from "../unit/fixtures/feedback-reporting";

const services: FeedbackReportingService[] = [],
  servers: Server[] = [],
  dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw Error("condition timed out");
    await sleep(10);
  }
}

async function setup(startupScan: boolean, history = 3000) {
  const requests: { at: number; raw: string }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ at: Date.now(), raw });
    if (requests.length === 1) {
      res.writeHead(503);
      res.end("{}");
    } else
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          recordId: body.recordId,
          acceptedRevision: body.revision,
          status: "applied",
        }),
      );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const f = await reportingFixture(
    `http://127.0.0.1:${(server.address() as { port: number }).port}/report`,
  );
  dirs.push(f.dir);
  const file = feedbackRecordPath(f.job.scope, "card-1"),
    directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  // Mix unrelated entries, unrated cards, and completed/ACKed cards in the real directory.
  for (let offset = 0; offset < history; offset += 32) {
    await Promise.all(
      Array.from({ length: Math.min(32, history - offset) }, async (_, n) => {
        const i = offset + n,
          id = `historical-${i}`;
        if (i % 3 === 0) return writeFile(path.join(directory, `noise-${i}.txt`), "synthetic");
        const record = {
          ...f.job.record,
          outTrackId: id,
          reporting: i % 3 === 1 ? undefined : f.job.record.reporting,
        };
        await writeFile(feedbackRecordPath(f.job.scope, id), JSON.stringify(record));
        if (record.reporting)
          await writeFile(
            reportPaths(f.job.scope, id, f.config.destinationKey).receipt,
            JSON.stringify({
              sourceRevision: 1,
              wireRevision: 1,
              terminal: true,
              nextAttemptAt: 0,
              expiresAt: record.expiresAt,
              attempts: 0,
              maintenanceVersion: REPORT_MAINTENANCE_VERSION,
            }),
          );
      }),
    );
  }
  await registerFeedbackCard(f.job.scope, {
    outTrackId: "card-1",
    ownerUserId: "alice",
    agentId: "main",
    sessionKey: "agent:main:main",
    conversationId: "synthetic-group",
  });
  await completeFeedbackCard(f.job.scope, "card-1", "Answer", undefined, {
    ...f.job.record.transcript!,
    localFile: f.sessionFile,
  } as any);
  const host: any = {
    config: {
      channels: {
        dingtalk: {
          clientId: "synthetic",
          clientSecret: "synthetic",
          feedbackEnabled: true,
          feedbackReporting: { ...f.config, enabled: true },
        },
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: {
      channel: {
        session: {
          resolveStorePath: (_: unknown, { agentId }: { agentId: string }) =>
            agentId === "default" ? f.job.scope.storePath : f.job.transcriptStorePath,
        },
      },
      events: { onAgentEvent: () => () => {} },
    },
  };
  const service = new FeedbackReportingService(host, {
    startupDelayMs: startupScan ? 0 : 3600000,
    tickMs: 10,
    // Deliberately omit scanPauseMs: regression must use the production 100 ms interval.
    workerUrl: pathToFileURL(path.resolve(".local/test-runtime/feedback-reporting-worker.js")),
  });
  services.push(service);
  const vote = (value: "like" | "none") =>
    applyFeedback(
      f.job.scope,
      {
        outTrackId: "card-1",
        userId: "alice",
        eventId: `event-${value}`,
        eventAt: Date.now(),
        vote: value,
      },
      Date.now(),
      f.config,
    );
  const receiptPath = reportPaths(f.job.scope, "card-1", f.config.destinationKey).receipt;
  service.start();
  await vote("like");
  await until(() => requests.length === 1 && service.status().queued === 0);
  const failed = (await readSmallJson<ReportReceipt>(receiptPath))!;
  expect(failed.error).toBe("http_503");
  return { ...f, service, requests, vote, failed, receiptPath, directory, file };
}

describe("retry latency with production scan pauses", () => {
  it.each([false, true])(
    "retries directly through 4000 historical directory entries (startup scan=%s)",
    async (startupScan) => {
      const f = await setup(startupScan);
      const entries: string[] = [];
      for await (const entry of await opendir(f.directory)) entries.push(entry.name);
      expect(entries.length).toBeGreaterThanOrEqual(4000);
      expect(f.service.status().delayed).toBe(1);
      expect(f.service.status().scanning).toBe(startupScan);
      const timeout = Math.max(0, f.failed.nextAttemptAt - Date.now()) + 2500;
      await until(() => f.service.status().delivered === 1, timeout);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1].raw).toBe(f.requests[0].raw);
      expect(f.requests[1].at).toBeGreaterThanOrEqual(f.failed.nextAttemptAt);
      expect(f.requests[1].at - f.failed.nextAttemptAt).toBeLessThan(2000);
      expect(f.service.status().delayed).toBe(0);
      expect(f.service.status().scansStarted).toBe(startupScan ? 1 : 0);
      expect((await readSmallJson<ReportReceipt>(f.receiptPath))?.terminal).toBe(true);
    },
    20000,
  );

  it("suspends indexed retries during foreground activity and resumes without a history scan", async () => {
    const f = await setup(false, 300);
    await f.service.setForeground("foreground", true);
    await sleep(Math.max(0, f.failed.nextAttemptAt - Date.now()) + 100);
    expect(f.requests).toHaveLength(1);
    expect(f.service.status()).toMatchObject({
      delayed: 1,
      queued: 0,
      scanning: false,
      timerScheduled: false,
      workerResident: false,
    });
    const released = Date.now();
    f.service.setForeground("foreground", false);
    await until(() => f.service.status().delivered === 1, 3000);
    expect(f.requests[1].at - released).toBeLessThan(2500);
    expect(f.requests[1].raw).toBe(f.requests[0].raw);
  }, 20000);

  it("lets a new withdrawal supersede an indexed failed vote before its old deadline", async () => {
    const f = await setup(false, 300);
    await f.vote("none");
    await until(() => f.service.status().delivered === 1, 3000);
    expect(JSON.parse(f.requests[1].raw).feedback.vote).toBe("none");
    expect(f.requests[1].at).toBeLessThan(f.failed.nextAttemptAt);
    expect(f.service.status()).toMatchObject({ delayed: 0, queued: 0, scanning: false });
  }, 15000);
});
