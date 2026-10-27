import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { readSmallJson, reportPaths } from "../../src/command/feedback-reporting-io";
import {
  REPORT_MAINTENANCE_VERSION,
  type ReportReceipt,
} from "../../src/command/feedback-reporting-protocol";
import { FEEDBACK_RETRY_INDEX_LIMIT } from "../../src/command/feedback-reporting-retry-index";
import { FeedbackReportingService } from "../../src/command/feedback-reporting-service";
import { feedbackRecordPath } from "../../src/command/feedback-store";
import { reportingFixture } from "../unit/fixtures/feedback-reporting";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw Error("condition timed out");
    await sleep(10);
  }
}

it("keeps the 1025th delayed task durable through index overflow and recovers without resending terminal records", async () => {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    res.end(
      JSON.stringify({
        schemaVersion: 1,
        recordId: body.recordId,
        acceptedRevision: body.revision,
        status: "applied",
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const f = await reportingFixture(
    `http://127.0.0.1:${(server.address() as { port: number }).port}/report`,
  );
  const count = FEEDBACK_RETRY_INDEX_LIMIT + 1,
    base = Date.now();
  let offset = 0;
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
          resolveStorePath: (_: unknown, p: { agentId: string }) =>
            p.agentId === "default" ? f.job.scope.storePath : f.job.transcriptStorePath,
        },
      },
      events: { onAgentEvent: () => () => {} },
    },
  };
  const make = () =>
    new FeedbackReportingService(host, {
      startupDelayMs: 0,
      tickMs: 2,
      scanPauseMs: 0,
      now: () => Date.now() + offset,
      workerUrl: pathToFileURL(path.resolve(".local/test-runtime/feedback-reporting-worker.js")),
    });
  const service = make();
  let restarted: FeedbackReportingService | undefined;
  const paths = Array.from({ length: count }, (_, i) =>
    reportPaths(f.job.scope, `retry-${i}`, f.config.destinationKey),
  );
  const receipt = (i: number, terminal = false): ReportReceipt => ({
    sourceRevision: 1,
    wireRevision: 1,
    terminal,
    nextAttemptAt: base + 300000 + i,
    expiresAt: f.job.record.expiresAt,
    attempts: 1,
    maintenanceVersion: REPORT_MAINTENANCE_VERSION,
  });
  try {
    await mkdir(path.dirname(paths[0].receipt), { recursive: true });
    for (let first = 0; first < count; first += 32)
      await Promise.all(
        Array.from({ length: Math.min(32, count - first) }, async (_, n) => {
          const i = first + n;
          await writeFile(
            feedbackRecordPath(f.job.scope, `retry-${i}`),
            JSON.stringify({ ...f.job.record, outTrackId: `retry-${i}` }),
          );
          await writeFile(paths[i].receipt, JSON.stringify(receipt(i)));
        }),
      );
    service.start();
    await until(
      () => !service.status().scanning && service.status().delayed === FEEDBACK_RETRY_INDEX_LIMIT,
    );
    expect(service.status().queued).toBe(0);
    expect(service.status().nextRecoveryAt).toBe(base + 300000 + count - 1);
    expect((await readSmallJson<ReportReceipt>(paths.at(-1)!.receipt))?.terminal).toBe(false);
    expect(bodies).toHaveLength(0);
    // Simulate durable completion of the indexed records; stale hints must be revalidated.
    for (let first = 0; first < count - 1; first += 32)
      await Promise.all(
        Array.from({ length: Math.min(32, count - 1 - first) }, (_, n) =>
          writeFile(paths[first + n].receipt, JSON.stringify(receipt(first + n, true))),
        ),
      );
    await service.setForeground("advance-test-clock", true);
    offset = 310000;
    service.setForeground("advance-test-clock", false);
    await until(
      () =>
        service.status().delivered === 1 &&
        service.status().delayed === 0 &&
        !service.status().scanning,
    );
    expect(bodies.map((b) => b.cardId)).toEqual([`retry-${count - 1}`]);
    expect(service.status().queued).toBe(0);
    await service.stop();
    expect(service.status().delayed).toBe(0);
    restarted = make();
    restarted.start();
    await until(() => restarted!.status().scansStarted === 1 && !restarted!.status().scanning);
    expect(restarted.status()).toMatchObject({ delayed: 0, queued: 0, workersStarted: 0 });
    expect(bodies).toHaveLength(1);
  } finally {
    await service.stop();
    await restarted?.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.dir, { recursive: true, force: true });
  }
}, 40000);
