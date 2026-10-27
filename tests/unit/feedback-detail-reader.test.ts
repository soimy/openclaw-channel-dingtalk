import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readFeedbackDetailContent,
  stopFeedbackDetailReads,
} from "../../src/command/feedback-detail-reader";
import { onFeedbackForegroundActivity } from "../../src/command/feedback-reporting-events";
import type { FeedbackRecord } from "../../src/command/feedback-store";
import { reportingFixture } from "./fixtures/feedback-reporting";

const dirs: string[] = [];
const subscriptions: Array<() => void> = [];
afterEach(async () => {
  await stopFeedbackDetailReads();
  for (const f of subscriptions.splice(0)) f();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function setup() {
  const f = await reportingFixture();
  dirs.push(f.dir);
  const record = { ...f.job.record, history: [], seen: [] } as FeedbackRecord;
  if (record.transcript?.status === "linked") record.transcript.localFile = f.sessionFile;
  const options = {
    storePath: f.job.transcriptStorePath,
    workerUrl: pathToFileURL(path.resolve(".local/test-runtime/feedback-detail-worker.js")),
  };
  return { ...f, record, options };
}
describe("bounded foreground feedback detail worker", () => {
  it("reads just the verified pair without reporting credentials or HTTP being enabled", async () => {
    const f = await setup();
    delete f.record.reporting;
    const result = await readFeedbackDetailContent(f.record, undefined, f.options);
    expect(result).toMatchObject({ status: "available", question: "Question", answer: "Answer" });
    expect(JSON.stringify(result)).not.toContain("Never report this");
  });

  it("waits for background termination before reading and bounds concurrent queries", async () => {
    const f = await setup();
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const activity: boolean[] = [];
    subscriptions.push(
      onFeedbackForegroundActivity((_id, active) => {
        activity.push(active);
        if (active) return barrier;
      }),
    );
    let done = false;
    const first = readFeedbackDetailContent(f.record, undefined, f.options).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    expect(await readFeedbackDetailContent(f.record, undefined, f.options)).toMatchObject({
      status: "pending",
      reason: "detail_busy",
    });
    release();
    expect(await first).toMatchObject({ status: "available" });
    expect(activity).toEqual([true, false]);
  });

  it("returns a budget status for an oversized transcript instead of reading it on the caller thread", async () => {
    const f = await setup();
    await writeFile(f.sessionFile, "x".repeat(9 * 1024 * 1024));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      expect(await readFeedbackDetailContent(f.record, undefined, f.options)).toMatchObject({
        status: "pending",
        reason: "resource_budget",
      });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it("enforces its deadline even if background termination does not settle", async () => {
    const f = await setup();
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    subscriptions.push(
      onFeedbackForegroundActivity((_id, active) => (active ? barrier : undefined)),
    );
    expect(
      await readFeedbackDetailContent(f.record, undefined, { ...f.options, timeoutMs: 30 }),
    ).toMatchObject({ status: "pending", reason: "read_timeout" });
    release();
  });

  it("terminates a stalled read worker and admits a subsequent query", async () => {
    const f = await setup();
    const stuck = path.join(f.dir, "stuck.mjs");
    await writeFile(
      stuck,
      "import {parentPort} from 'node:worker_threads';setInterval(()=>{},1000);parentPort.on('message',()=>{});\n",
    );
    expect(
      await readFeedbackDetailContent(f.record, undefined, {
        ...f.options,
        workerUrl: pathToFileURL(stuck),
        timeoutMs: 100,
      }),
    ).toMatchObject({ status: "pending", reason: "read_timeout" });
    expect(await readFeedbackDetailContent(f.record, undefined, f.options)).toMatchObject({
      status: "available",
    });
  });

  it("declines a query when memory headroom is insufficient", async () => {
    const f = await setup();
    vi.spyOn(process, "availableMemory").mockReturnValue(64 * 1048576);
    expect(await readFeedbackDetailContent(f.record, undefined, f.options)).toMatchObject({
      status: "pending",
      reason: "resource_budget",
    });
  });

  it("cancels a pending foreground read during plugin shutdown", async () => {
    const f = await setup();
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    subscriptions.push(
      onFeedbackForegroundActivity((_id, active) => (active ? barrier : undefined)),
    );
    const work = readFeedbackDetailContent(f.record, undefined, f.options);
    await stopFeedbackDetailReads();
    expect(await work).toMatchObject({ status: "pending", reason: "read_cancelled" });
    release();
  });
});
