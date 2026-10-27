import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
/** Focused module A/B probe. Run in an isolated test Pod, never against employee data. */
import { Worker } from "node:worker_threads";
import { resolveFeedbackReporting } from "../src/command/feedback-reporting-config";
import { withFeedbackForegroundActivity } from "../src/command/feedback-reporting-events";
import { FeedbackReportingService } from "../src/command/feedback-reporting-service";
import {
  registerFeedbackCard,
  completeFeedbackCard,
  applyFeedback,
} from "../src/command/feedback-store";

const { values } = parseArgs({
  options: {
    enabled: { type: "boolean", default: false },
    scenario: { type: "string", default: "idle" },
    seconds: { type: "string", default: "20" },
    cards: { type: "string", default: "24" },
    worker: { type: "string" },
    legacy: { type: "boolean", default: false },
    sqlite: { type: "boolean", default: false },
    checkpoint: { type: "string" },
    output: { type: "string" },
  },
});
const enabled = values.enabled;
const scenario = values.scenario;
const duration = Number(values.seconds) * 1000;
if (
  !["idle", "foreground", "ratings", "slow", "large", "pressure"].includes(scenario) ||
  duration < 3000 ||
  duration > 300000
)
  throw Error("Invalid benchmark scenario or duration");
const root = await mkdtemp(path.join(tmpdir(), "feedback-ab-"));
const sessionId = "22222222-2222-4222-8222-222222222222";
const transcriptStorePath = values.sqlite
  ? path.join(root, "agents/main/sessions/sessions.json")
  : path.join(root, "sessions.json");
const sessionFile = path.join(root, `${sessionId}.jsonl`);
const ratingStore = path.join(root, "ratings", "sessions.json");
let firstRequest: () => void = () => {};
let received = 0;
let firstRequestAt: number | undefined;
const receiver = new Worker(
  `const {parentPort,workerData}=require('node:worker_threads');const http=require('node:http');const server=http.createServer((req,res)=>{let data='';req.on('data',c=>data+=c);req.on('end',()=>{const b=JSON.parse(data);parentPort.postMessage({request:true});if(workerData.slow)return;res.end(JSON.stringify({schemaVersion:1,recordId:b.recordId,acceptedRevision:b.revision,status:'applied'}));});});server.listen(0,'127.0.0.1',()=>parentPort.postMessage({port:server.address().port}));`,
  { eval: true, workerData: { slow: scenario === "slow" } },
);
const port = await new Promise<number>((resolve) => {
  receiver.on("message", (message) => {
    if (message.port) resolve(message.port);
    else if (message.request) {
      received++;
      firstRequestAt ??= Date.now();
      firstRequest();
    }
  });
});
const raw = {
  enabled: true,
  endpoint: `http://127.0.0.1:${port}/v1/feedback/snapshots`,
  tenantId: "bench-org",
  instanceId: "bench-instance",
  token: "synthetic-only-token",
  idleMs: 1000,
  requestTimeoutMs: 5000,
};
const config = resolveFeedbackReporting(raw)!;
let agentListener: ((event: any) => void) | undefined;
const api: any = {
  config: {
    channels: {
      dingtalk: {
        clientId: "synthetic",
        clientSecret: "synthetic",
        feedbackEnabled: true,
        feedbackReporting: raw,
      },
    },
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  runtime: {
    channel: {
      session: {
        resolveStorePath: (_x: any, p: any) =>
          p.agentId === "default" ? ratingStore : transcriptStorePath,
      },
    },
    events: {
      onAgentEvent: (fn: any) => {
        agentListener = fn;
        return () => {
          agentListener = undefined;
        };
      },
    },
  },
};
const emit = (phase: string) =>
  agentListener?.({ stream: "lifecycle", runId: "foreground-probe", data: { phase } });
const answer = "A visible answer. ".repeat(512);
await mkdir(path.dirname(ratingStore), { recursive: true });
const events = [
  { type: "session", id: sessionId },
  {
    type: "message",
    id: "question",
    message: {
      role: "user",
      content: "A test question",
      senderId: "employee",
      sourceChannel: "dingtalk",
    },
  },
  {
    type: "message",
    id: "answer",
    message: { role: "assistant", content: [{ type: "text", text: answer }] },
  },
];
if (values.sqlite) {
  const storeEntry = "openclaw/plugin-sdk/session-store-runtime";
  const transcriptEntry = "openclaw/plugin-sdk/session-transcript-runtime";
  const store = await import(storeEntry);
  const transcript = await import(transcriptEntry);
  const target = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId,
    storePath: transcriptStorePath,
    env: { OPENCLAW_STATE_DIR: root },
  };
  await mkdir(path.dirname(transcriptStorePath), { recursive: true });
  await store.upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: Date.now() } });
  for (const event of events.slice(1)) {
    await transcript.appendSessionTranscriptMessageByIdentity({
      ...target,
      eventId: event.id,
      message: event.message,
      updateMode: "none",
    });
  }
  if (scenario === "large") {
    await transcript.appendSessionTranscriptMessageByIdentity({
      ...target,
      eventId: "unrelated-large-row",
      message: { role: "assistant", content: "x".repeat(9 * 1024 * 1024) },
      updateMode: "none",
    });
  }
} else {
  await writeFile(
    transcriptStorePath,
    JSON.stringify({ "agent:main:main": { sessionId, sessionFile, updatedAt: Date.now() } }),
  );
  await writeFile(
    sessionFile,
    scenario === "large"
      ? "x".repeat(9 * 1024 * 1024)
      : events.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
}
const scope = { storePath: ratingStore, accountId: "default" };
const count = Math.min(512, Math.max(1, Number(values.cards)));
const now = Date.now();
for (let i = 0; i < count; i++) {
  await registerFeedbackCard(scope, {
    outTrackId: `bench-card-${i}`,
    ownerUserId: "employee",
    agentId: "main",
    sessionKey: "agent:main:main",
    conversationId: "bench-conversation",
  });
  await completeFeedbackCard(scope, `bench-card-${i}`, answer, undefined, {
    status: "linked",
    source: "runtime-events",
    sessionId,
    userMessageId: "question",
    assistantMessageId: "answer",
    ...(values.legacy || values.sqlite ? {} : { localFile: sessionFile }),
  });
  await applyFeedback(
    scope,
    {
      outTrackId: `bench-card-${i}`,
      userId: "employee",
      eventId: `seed-${i}`,
      eventAt: now + i,
      vote: "like",
    },
    Date.now(),
    enabled ? config : undefined,
  );
}
const service = enabled
  ? new FeedbackReportingService(api, {
      startupDelayMs: 0,
      workerUrl: values.worker
        ? pathToFileURL(path.resolve(values.worker))
        : new URL("./feedback-reporting-worker.js", import.meta.url),
    })
  : undefined;
const delays: number[] = [];
const acknowledgements: number[] = [];
let maxRss = process.memoryUsage().rss;
const initialRss = maxRss;
let mutation = 0;
let writing = false;
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
const cpu = process.cpuUsage();
const started = performance.now();
const startCall = performance.now();
service?.start();
const startupMs = performance.now() - startCall;
if (scenario === "foreground") emit("start");
if (scenario === "slow") firstRequest = () => emit("start");
let previous = performance.now();
const probePayload = JSON.stringify({ text: "a".repeat(4096) });
const timer = setInterval(() => {
  const n = performance.now();
  delays.push(Math.max(0, n - previous - 10));
  previous = n;
  JSON.parse(probePayload);
  maxRss = Math.max(maxRss, process.memoryUsage().rss);
}, 10);
const clicks = setInterval(() => {
  if (writing || !["foreground", "ratings"].includes(scenario)) return;
  writing = true;
  const n = mutation++;
  const start = performance.now();
  void withFeedbackForegroundActivity(() =>
    applyFeedback(
      scope,
      {
        outTrackId: "bench-card-0",
        userId: "employee",
        eventId: `live-${n}`,
        eventAt: Date.now() + count,
        vote: n % 2 ? "none" : "dislike",
      },
      Date.now(),
      enabled ? config : undefined,
    ),
  )
    .then(() => acknowledgements.push(performance.now() - start))
    .finally(() => (writing = false));
}, 250);
let pressureEndedAt: number | undefined;
const pressureTimer =
  scenario === "pressure"
    ? setInterval(() => {
        const until = performance.now() + 75;
        while (performance.now() < until) {
          /* Bounded contention in this test process only. */
        }
      }, 200)
    : undefined;
const pressureEnd = pressureTimer
  ? setTimeout(() => {
      clearInterval(pressureTimer);
      pressureEndedAt = Date.now();
    }, duration / 2)
  : undefined;
const checkpoints: unknown[] = [];
const checkpoint = values.checkpoint
  ? setTimeout(
      () =>
        checkpoints.push({
          at: Date.now(),
          receiverRequests: received,
          service: service?.status(),
        }),
      Number(values.checkpoint),
    )
  : undefined;
await new Promise((resolve) => setTimeout(resolve, duration));
if (checkpoint) clearTimeout(checkpoint);
if (pressureEnd) clearTimeout(pressureEnd);
if (pressureTimer) clearInterval(pressureTimer);
clearInterval(timer);
clearInterval(clicks);
while (writing) await new Promise((r) => setTimeout(r, 10));
const stats = service?.status();
await service?.stop();
await receiver.terminate();
histogram.disable();
const elapsed = performance.now() - started;
const used = process.cpuUsage(cpu);
const percentile = (x: number[], p: number) =>
  x.length ? [...x].sort((a, b) => a - b)[Math.min(x.length - 1, Math.floor(x.length * p))] : null;
const cgroup: Record<string, string> = {};
for (const name of ["cpu.max", "cpu.weight", "cpu.stat", "memory.max"])
  try {
    cgroup[name] = (await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim();
  } catch {}
const report =
  JSON.stringify(
    {
      enabled,
      scenario,
      storage: values.sqlite ? "host-sqlite" : "jsonl",
      receiverPort: port,
      processId: process.pid,
      cards: count,
      durationMs: elapsed,
      startupMs,
      samples: delays.length,
      probeLagMs: {
        p95: percentile(delays, 0.95),
        p99: percentile(delays, 0.99),
        max: Math.max(...delays),
      },
      eventLoopMs: { p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 },
      ratingAckMs: {
        p95: percentile(acknowledgements, 0.95),
        p99: percentile(acknowledgements, 0.99),
      },
      cpuMs: (used.user + used.system) / 1000,
      rssMiB: { initial: initialRss / 1048576, peak: maxRss / 1048576 },
      receiverRequests: received,
      firstRequestAt,
      pressureEndedAt,
      pressureDeferralPassed:
        scenario === "pressure"
          ? Boolean(firstRequestAt && pressureEndedAt && firstRequestAt >= pressureEndedAt)
          : undefined,
      checkpoints,
      service: stats,
      cgroup,
      scope:
        "real reporting module with synthetic foreground probe and local receiver worker; not LLM first-token latency",
    },
    null,
    2,
  ) + "\n";
if (values.output) await writeFile(values.output, report);
else process.stdout.write(report);
await rm(root, { recursive: true, force: true });
if (
  enabled &&
  scenario === "pressure" &&
  !(firstRequestAt && pressureEndedAt && firstRequestAt >= pressureEndedAt)
) {
  throw new Error("Reporting started before pressure ended, or did not recover within the probe");
}
