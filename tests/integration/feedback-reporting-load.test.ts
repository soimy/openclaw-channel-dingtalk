import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackReportingService } from "../../src/command/feedback-reporting-service";
import {
  applyFeedback,
  completeFeedbackCard,
  readFeedbackRecord,
  registerFeedbackCard,
} from "../../src/command/feedback-store";
import { reportingFixture } from "../unit/fixtures/feedback-reporting";
import { feedbackHttpReceiver } from "./fixtures/feedback-http-receiver";

const services: FeedbackReportingService[] = [];
const receivers: Awaited<ReturnType<typeof feedbackHttpReceiver>>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const receiver of receivers.splice(0)) await receiver.close();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("load recovery timed out");
    await sleep(25);
  }
}
async function fixture(enabled = true) {
  const f = await reportingFixture();
  directories.push(f.dir);
  const receiver = await feedbackHttpReceiver(f.dir);
  receivers.push(receiver);
  const raw = {
    enabled,
    endpoint: receiver.endpoint,
    tenantId: "test-org",
    instanceId: "test-instance",
    token: "test-only-token",
    idleMs: 1000,
    requestTimeoutMs: 1000,
  };
  const { resolveFeedbackReporting } = await import("../../src/command/feedback-reporting-config");
  const config = resolveFeedbackReporting({ ...raw, enabled: true })!;
  const api: any = {
    config: {
      channels: {
        dingtalk: {
          clientId: "test",
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
          resolveStorePath: (_x: unknown, p: { agentId: string }) =>
            p.agentId === "default" ? f.job.scope.storePath : f.job.transcriptStorePath,
        },
      },
      events: { onAgentEvent: vi.fn(() => () => {}) },
    },
  };
  const create = () => {
    const service = new FeedbackReportingService(api, {
      startupDelayMs: 0,
      tickMs: 5,
      scanPauseMs: 1,
      workerUrl: pathToFileURL(path.resolve(".local/test-runtime/feedback-reporting-worker.js")),
    });
    services.push(service);
    return service;
  };
  const seed = async (id: string) => {
    await registerFeedbackCard(f.job.scope, {
      outTrackId: id,
      ownerUserId: "alice",
      conversationId: "load-group",
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    await completeFeedbackCard(f.job.scope, id, "Answer", undefined, {
      ...f.job.record.transcript!,
      localFile: f.sessionFile,
    } as any);
    await applyFeedback(
      f.job.scope,
      { outTrackId: id, userId: "alice", eventId: `seed-${id}`, eventAt: Date.now(), vote: "like" },
      Date.now(),
      config,
    );
  };
  return { ...f, receiver, config, create, seed, api };
}

describe("bounded reporting backlog and rating pressure", () => {
  it("recovers an overflowing 160-card backlog after a real worker/service restart", async () => {
    const f = await fixture();
    const first = f.create();
    first.start();
    first.setForeground("test-foreground", true);
    // At most eight concurrent writers; data and receiver belong only to this test.
    for (let offset = 0; offset < 160; offset += 8) {
      await Promise.all(Array.from({ length: 8 }, (_, i) => f.seed(`load-${offset + i}`)));
    }
    expect(first.status()).toMatchObject({ queued: 128, workersStarted: 0, timerScheduled: false });
    await applyFeedback(
      f.job.scope,
      {
        outTrackId: "load-159",
        userId: "alice",
        eventId: "withdraw-latest",
        eventAt: Date.now() + 1,
        vote: "none",
      },
      Date.now(),
      f.config,
    );
    first.setForeground("test-foreground", false);
    await until(() => f.receiver.requests.length >= 20);
    await first.stop();
    const second = f.create();
    second.start();
    await until(() => new Set(f.receiver.requests.map((body) => body.cardId)).size === 160);
    await until(() => !second.status().scanning && second.status().queued === 0);
    const latest = f.receiver.requests.findLast((body) => body.cardId === "load-159")!;
    expect(JSON.parse(f.receiver.read(latest.recordId)!.snapshot).feedback.vote).toBe("none");
    expect(second.status().queued).toBeLessThanOrEqual(128);
  }, 45_000);

  it("keeps the newest owner vote under 512 concurrent changes, retries and unauthorized requests", async () => {
    const f = await fixture(false);
    await f.seed("hot-card");
    const now = Date.now() + 100;
    const results = await Promise.all(
      Array.from({ length: 512 }, (_, i) =>
        applyFeedback(
          f.job.scope,
          {
            outTrackId: "hot-card",
            userId: i % 4 === 0 ? "bob" : "alice",
            eventId: `pressure-${i}`,
            eventAt: now + i,
            vote: i === 511 ? "none" : "dislike",
          },
          Date.now(),
          f.config,
        ),
      ),
    );
    expect(results.filter((result) => result.status === "forbidden")).toHaveLength(128);
    const final = await readFeedbackRecord(f.job.scope, "hot-card");
    expect(final).toMatchObject({ vote: "none", reasons: [], lastEventAt: now + 511 });
    expect(final!.seen).toHaveLength(256);
    expect(final!.history.length).toBeLessThanOrEqual(100);
    expect(
      (
        await applyFeedback(f.job.scope, {
          outTrackId: "hot-card",
          userId: "alice",
          eventId: "pressure-511",
          eventAt: now + 511,
          vote: "none",
        })
      ).status,
    ).toBe("duplicate");
    const service = f.create();
    service.start();
    await sleep(1100);
    expect(service.status()).toMatchObject({ queued: 0, workersStarted: 0, timerScheduled: false });
    expect(f.receiver.requests).toHaveLength(0);
  }, 15_000);
});
