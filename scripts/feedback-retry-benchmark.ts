import { mkdir, opendir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readSmallJson, reportPaths } from "../src/command/feedback-reporting-io";
import type { ReportReceipt } from "../src/command/feedback-reporting-protocol";
import { FeedbackReportingService } from "../src/command/feedback-reporting-service";
import {
  registerFeedbackCard,
  completeFeedbackCard,
  applyFeedback,
  feedbackRecordPath,
} from "../src/command/feedback-store";
import { reportingFixture } from "../tests/unit/fixtures/feedback-reporting";

// Developer-only synthetic probe. Never reads employee state or starts a gateway.
const { values } = parseArgs({
  options: {
    "history-files": { type: "string", default: "10000" },
    "service-module": { type: "string" },
    worker: { type: "string" },
    "startup-scan": { type: "boolean", default: false },
    foreground: { type: "boolean", default: false },
    output: { type: "string" },
  },
});
const count = Number(values["history-files"]);
if (!Number.isInteger(count) || count < 0 || count > 50000)
  throw Error("history-files must be 0..50000");
const implementation = values["service-module"]
  ? await import(pathToFileURL(path.resolve(values["service-module"])).href)
  : { FeedbackReportingService, applyFeedback };
const Service: typeof FeedbackReportingService = implementation.FeedbackReportingService;
const applyVote: typeof applyFeedback = implementation.applyFeedback;
// Both must share one event bus, including when comparing a separately bundled revision.
if (typeof applyVote !== "function")
  throw Error("comparison bundle must export applyFeedback alongside FeedbackReportingService");
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
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = (server.address() as { port: number }).port;
const f = await reportingFixture(`http://127.0.0.1:${port}/report`);
const resourceEvents: { at: number; message: string }[] = [];
const service = new Service(
  {
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
    logger: {
      info(message: string) {
        if (message.includes("resource pressure")) resourceEvents.push({ at: Date.now(), message });
      },
      warn() {},
      error() {},
    },
    runtime: {
      channel: {
        session: {
          resolveStorePath: (_: unknown, { agentId }: { agentId: string }) =>
            agentId === "default" ? f.job.scope.storePath : f.job.transcriptStorePath,
        },
      },
      events: { onAgentEvent: () => () => {} },
    },
  } as any,
  {
    startupDelayMs: values["startup-scan"] ? 0 : 3600000,
    // Keep both production defaults: tickMs=1000 and scanPauseMs=100.
    workerUrl: values.worker
      ? pathToFileURL(path.resolve(values.worker))
      : new URL("./feedback-reporting-worker.js", import.meta.url),
  },
);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 40000;
  while (!(await check())) {
    if (Date.now() > end) throw Error(`retry probe timed out: ${JSON.stringify(service.status())}`);
    await sleep(20);
  }
}
let probe: NodeJS.Timeout | undefined;
try {
  const file = feedbackRecordPath(f.job.scope, "card-1"),
    directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  for (let offset = 0; offset < count; offset += 32)
    await Promise.all(
      Array.from({ length: Math.min(32, count - offset) }, (_, n) =>
        writeFile(path.join(directory, `history-${offset + n}.txt`), "synthetic"),
      ),
    );
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
  const delays: number[] = [];
  const cpu = process.cpuUsage(),
    initialRss = process.memoryUsage().rss;
  let previous = performance.now(),
    peakRss = initialRss;
  probe = setInterval(() => {
    const now = performance.now();
    delays.push(Math.max(0, now - previous - 10));
    previous = now;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  service.start();
  await applyVote(
    f.job.scope,
    { outTrackId: "card-1", userId: "alice", eventId: "first", eventAt: Date.now(), vote: "like" },
    Date.now(),
    f.config,
  );
  const receiptPath = reportPaths(f.job.scope, "card-1", f.config.destinationKey).receipt;
  let failed: ReportReceipt | undefined;
  await until(async () => {
    failed = await readSmallJson<ReportReceipt>(receiptPath);
    return failed?.error === "http_503" && service.status().failures === 1;
  });
  const order: string[] = [];
  for await (const entry of await opendir(directory)) order.push(entry.name);
  let foregroundReleasedAt: number | undefined;
  if (values.foreground) {
    await service.setForeground("synthetic-foreground", true);
    await sleep(Math.max(0, failed!.nextAttemptAt - Date.now()) + 300);
    if (requests.length !== 1 || service.status().workerResident || service.status().timerScheduled)
      throw Error("foreground reporting was not suspended");
    foregroundReleasedAt = Date.now();
    service.setForeground("synthetic-foreground", false);
  }
  await until(() => service.status().delivered === 1);
  const receipt = await readSmallJson<ReportReceipt>(receiptPath);
  const used = process.cpuUsage(cpu);
  const sorted = delays.toSorted((a, b) => a - b);
  const result = {
    runtime: process.version,
    storage: "synthetic-jsonl",
    historyFiles: count,
    entriesBeforeTarget: order.indexOf(path.basename(file)),
    receiverPort: port,
    serviceModule: values["service-module"] ? "comparison bundle" : "current source",
    scanPauseMs: 100,
    tickMs: 1000,
    startupScan: values["startup-scan"],
    foreground: values.foreground,
    retryDueAt: failed!.nextAttemptAt,
    retriedAt: requests[1].at,
    retryLatenessMs: requests[1].at - failed!.nextAttemptAt,
    foregroundRecoveryMs: foregroundReleasedAt ? requests[1].at - foregroundReleasedAt : undefined,
    requests: requests.length,
    identicalRetry: requests[0].raw === requests[1].raw,
    terminal: receipt?.terminal,
    probeLagMs: {
      p99: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))],
      max: Math.max(...delays),
    },
    cpuMs: (used.user + used.system) / 1000,
    rssMiB: { initial: initialRss / 1048576, peak: peakRss / 1048576 },
    service: service.status(),
    resourceEvents,
    scope:
      "Real worker and HTTP 503-to-200; isolated synthetic data. Extra latency is measured after durable retry deadline, not initial backoff.",
  };
  if (
    !result.identicalRetry ||
    !result.terminal ||
    result.requests !== 2 ||
    result.retryLatenessMs < 0
  )
    throw Error("retry contract failed");
  const text = JSON.stringify(result, null, 2) + "\n";
  if (values.output) await writeFile(values.output, text);
  else process.stdout.write(text);
} finally {
  if (probe) clearInterval(probe);
  await service.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(f.dir, { recursive: true, force: true });
}
