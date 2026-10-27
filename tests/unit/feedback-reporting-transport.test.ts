import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFeedbackReporting } from "../../src/command/feedback-reporting-config";
import { readSmallJson, reportPaths } from "../../src/command/feedback-reporting-io";
import {
  createReportEnvelope,
  validateReportAck,
} from "../../src/command/feedback-reporting-protocol";
import { postFeedbackReport } from "../../src/command/feedback-reporting-transport";
import { executeReportJob } from "../../src/command/feedback-reporting-worker";
import { reportingFixture } from "./fixtures/feedback-reporting";
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function receiver(handler: (body: any, req: any, res: any) => void) {
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (x) => (text += x));
    req.on("end", () => handler(JSON.parse(text), req, res));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as any).port}/report`;
}
async function setup(endpoint: string) {
  const f = await reportingFixture(endpoint);
  dirs.push(f.dir);
  return f;
}
const ack = (body: any, res: any, status = "applied") =>
  res.end(
    JSON.stringify({
      schemaVersion: 1,
      recordId: body.recordId,
      acceptedRevision: body.revision,
      status,
    }),
  );
describe("HTTP reporting contract and durable outbox", () => {
  it("does not resurrect a stale local vote by automatically increasing its version", async () => {
    const bodies: any[] = [];
    const endpoint = await receiver((body, _req, res) => {
      bodies.push(body);
      if (bodies.length === 1)
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            recordId: body.recordId,
            acceptedRevision: 10,
            status: "stale",
          }),
        );
      else ack(body, res);
    });
    const f = await setup(endpoint);
    expect(await executeReportJob(f.job)).toMatchObject({
      kind: "done",
      receipt: { terminal: true, superseded: true },
    });
    await executeReportJob(f.job);
    expect(bodies).toHaveLength(1);
    f.job.record.vote = "none";
    f.job.record.reporting!.revision++;
    await executeReportJob(f.job);
    expect(bodies[1].revision).toBeGreaterThan(10);
    expect(bodies[1].feedback.vote).toBe("none");
  });

  it("never uploads local transcript paths", async () => {
    const f = await setup("http://127.0.0.1:1");
    if (f.job.record.transcript?.status === "linked")
      f.job.record.transcript.localFile = "/private/user/transcript.jsonl";
    expect(
      JSON.stringify(createReportEnvelope(f.job, 1, { mode: "replace", status: "pending" })),
    ).not.toContain("/private/user");
  });

  it("validates configuration and keeps it disabled by default", () => {
    expect(resolveFeedbackReporting(undefined)).toBeUndefined();
    expect(() => resolveFeedbackReporting({ enabled: true })).toThrow();
    expect(() =>
      resolveFeedbackReporting({
        enabled: true,
        endpoint: "http://example.com/report",
        tenantId: "a",
        instanceId: "b",
        token: "c",
      }),
    ).toThrow();
  });
  it("sends an authenticated snapshot only after durable outbox preparation", async () => {
    let checked = false;
    let f: any;
    const endpoint = await receiver(async (body, req, res) => {
      expect(req.headers.authorization).toBe("Bearer test-only-token");
      expect(
        (
          await readSmallJson<any>(
            reportPaths(f.job.scope, "card-1", f.config.destinationKey).state,
          )
        )?.envelope,
      ).toEqual(body);
      checked = true;
      ack(body, res);
    });
    f = await setup(endpoint);
    const result = await executeReportJob(f.job);
    expect(checked).toBe(true);
    expect(result).toMatchObject({ kind: "done", receipt: { terminal: true, sourceRevision: 1 } });
  });
  it("retries the same prepared version after an invalid ACK", async () => {
    const bodies: any[] = [];
    const endpoint = await receiver((body, _req, res) => {
      bodies.push(body);
      if (bodies.length === 1) res.end("{}");
      else ack(body, res, "duplicate");
    });
    const f = await setup(endpoint);
    expect(await executeReportJob(f.job)).toMatchObject({
      kind: "done",
      receipt: { terminal: false, error: "invalid_ack" },
    });
    expect(await executeReportJob(f.job)).toMatchObject({
      kind: "done",
      receipt: { terminal: true },
    });
    expect(bodies[0]).toEqual(bodies[1]);
  });
  it("withdraws with a newer wire revision while preserving accepted body", async () => {
    const bodies: any[] = [];
    const endpoint = await receiver((body, _req, res) => {
      bodies.push(body);
      ack(body, res);
    });
    const f = await setup(endpoint);
    await executeReportJob(f.job);
    f.job.record.vote = "none";
    f.job.record.reporting!.revision++;
    await executeReportJob(f.job);
    expect(bodies[0].content.status).toBe("available");
    expect(bodies[1].content).toMatchObject({ mode: "preserve", status: "available" });
    expect(bodies[1].revision).toBeGreaterThan(bodies[0].revision);
    expect(bodies[1].feedback.vote).toBe("none");
  });
  it("does not resubmit an already accepted unchanged record after restart", async () => {
    let calls = 0;
    const endpoint = await receiver((body, _req, res) => {
      calls++;
      ack(body, res);
    });
    const f = await setup(endpoint);
    await executeReportJob(f.job);
    await executeReportJob(f.job);
    expect(calls).toBe(1);
  });
  it("publishes metadata for a missing transcript and accepts later vote changes", async () => {
    const bodies: any[] = [];
    const endpoint = await receiver((body, _req, res) => {
      bodies.push(body);
      ack(body, res);
    });
    const f = await setup(endpoint);
    await rm(f.sessionFile);
    await executeReportJob(f.job);
    expect(bodies[0].content.status).toBe("missing");
  });
  it("enriches a pending body with a newer version even if the rating is unchanged", async () => {
    const bodies: any[] = [];
    const endpoint = await receiver((body, _req, res) => {
      bodies.push(body);
      ack(body, res);
    });
    const f = await setup(endpoint);
    f.job.metadataOnly = true;
    await executeReportJob(f.job);
    f.job.metadataOnly = false;
    await executeReportJob(f.job);
    expect(bodies[0].content.status).toBe("pending");
    expect(bodies[1].content.status).toBe("available");
    expect(bodies[1].revision).toBeGreaterThan(bodies[0].revision);
  });
  it("rejects redirects instead of forwarding credentials", async () => {
    let calls = 0;
    const endpoint = await receiver((_body, _req, res) => {
      calls++;
      res.writeHead(302, { location: "/different" });
      res.end();
    });
    const f = await setup(endpoint);
    await expect(
      postFeedbackReport(
        endpoint,
        f.job.token,
        createReportEnvelope(f.job, 1, { mode: "replace", status: "missing" }),
        500,
      ),
    ).rejects.toThrow("http_302");
    expect(calls).toBe(1);
  });
  it("bounds slow receiver time and response size", async () => {
    const slow = await receiver(() => {});
    const f = await setup(slow);
    const packet = createReportEnvelope(f.job, 1, { mode: "replace", status: "missing" });
    await expect(postFeedbackReport(slow, f.job.token, packet, 50)).rejects.toThrow(
      "request_timeout",
    );
    const big = await receiver((_body, _req, res) => res.end("x".repeat(9000)));
    await expect(postFeedbackReport(big, f.job.token, packet, 500)).rejects.toThrow(
      "response_size_limit",
    );
  });
  it("requires an exact durable acknowledgement identity and version", async () => {
    const f = await setup("http://127.0.0.1:1");
    const e = createReportEnvelope(f.job, 2, { mode: "replace", status: "missing" });
    for (const a of [
      { schemaVersion: 1, recordId: e.recordId, status: "applied", acceptedRevision: 3 },
      { schemaVersion: 1, recordId: "other", status: "applied", acceptedRevision: 2 },
      { schemaVersion: 1, recordId: e.recordId, status: "stale", acceptedRevision: 1 },
    ])
      expect(() => validateReportAck(a, e)).toThrow();
  });
});
