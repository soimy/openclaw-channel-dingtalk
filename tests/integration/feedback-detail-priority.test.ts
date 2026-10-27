import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import {
  readFeedbackDetailContent,
  stopFeedbackDetailReads,
} from "../../src/command/feedback-detail-reader";
import { FeedbackReportingService } from "../../src/command/feedback-reporting-service";
import {
  registerFeedbackCard,
  completeFeedbackCard,
  applyFeedback,
  readFeedbackRecord,
} from "../../src/command/feedback-store";
import { reportingFixture } from "../unit/fixtures/feedback-reporting";

it("completes a foreground detail query while cancelling a slow background report", async () => {
  let requests = 0;
  const server = createServer(async (req) => {
    for await (const _chunk of req) {
      /* Consume only synthetic input. */
    }
    requests++;
  });
  await new Promise<void>((r, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", r);
  });
  const f = await reportingFixture(`http://127.0.0.1:${(server.address() as any).port}/report`);
  const raw = {
    enabled: true,
    endpoint: f.config.endpoint,
    tenantId: "test-org",
    instanceId: "test-instance",
    token: "test-only-token",
    idleMs: 1000,
    requestTimeoutMs: 5000,
  };
  const host: any = {
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
          resolveStorePath: (_s: unknown, p: { agentId: string }) =>
            p.agentId === "default" ? f.job.scope.storePath : f.job.transcriptStorePath,
        },
      },
      events: { onAgentEvent: () => () => {} },
    },
  };
  const service = new FeedbackReportingService(host, {
    startupDelayMs: 0,
    tickMs: 10,
    scanPauseMs: 0,
    workerUrl: pathToFileURL(path.resolve(".local/test-runtime/feedback-reporting-worker.js")),
  });
  try {
    await registerFeedbackCard(f.job.scope, {
      outTrackId: "priority-card",
      ownerUserId: "alice",
      conversationId: "test-group",
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    await completeFeedbackCard(f.job.scope, "priority-card", "Answer", undefined, {
      ...f.job.record.transcript!,
      localFile: f.sessionFile,
    } as any);
    service.start();
    await applyFeedback(
      f.job.scope,
      {
        outTrackId: "priority-card",
        userId: "alice",
        eventId: "vote-1",
        eventAt: Date.now(),
        vote: "like",
      },
      Date.now(),
      f.config,
    );
    const deadline = Date.now() + 8000;
    while (requests === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(requests).toBe(1);
    expect(service.status().workerActive).toBe(true);
    const record = (await readFeedbackRecord(f.job.scope, "priority-card"))!;
    let foregroundWithoutReporter = false;
    const timer = setInterval(() => {
      const s = service.status();
      if (s.foregroundRuns > 0 && !s.workerResident) foregroundWithoutReporter = true;
    }, 1);
    try {
      expect(
        await readFeedbackDetailContent(record, undefined, {
          storePath: f.job.transcriptStorePath,
          workerUrl: pathToFileURL(path.resolve(".local/test-runtime/feedback-detail-worker.js")),
        }),
      ).toMatchObject({ status: "available", question: "Question", answer: "Answer" });
    } finally {
      clearInterval(timer);
    }
    expect(foregroundWithoutReporter).toBe(true);
    expect(service.status()).toMatchObject({ workerResident: false, foregroundRuns: 0, queued: 1 });
    expect(requests).toBe(1);
  } finally {
    await stopFeedbackDetailReads();
    await service.stop();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(f.dir, { recursive: true, force: true });
  }
}, 15000);
