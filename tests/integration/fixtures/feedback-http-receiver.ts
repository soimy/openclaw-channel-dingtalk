import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FeedbackReportEnvelope } from "../../../src/command/feedback-reporting-protocol";

/** Test-only database receiver: every successful ACK follows a real SQL COMMIT. */
export async function feedbackHttpReceiver(directory: string) {
  const databasePath = path.join(directory, "receiver.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS feedback (
      record_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
      request_hash TEXT NOT NULL, snapshot TEXT NOT NULL, content TEXT NOT NULL
    );
  `);
  const control = { status: 200, badAck: false, loseAck: false, failCommit: false };
  const requests: FeedbackReportEnvelope[] = [];
  const read = (recordId: string) =>
    database.prepare("SELECT * FROM feedback WHERE record_id = ?").get(recordId) as
      | {
          record_id: string;
          revision: number;
          request_hash: string;
          snapshot: string;
          content: string;
        }
      | undefined;
  const server = createServer(async (req, res) => {
    const respond = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.method !== "POST" || req.url !== "/v1/feedback/snapshots") {
      respond(404, { error: "not_found" });
      return;
    }
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 300 * 1024) {
          respond(413, { error: "too_large" });
          return;
        }
      }
      const body: FeedbackReportEnvelope = JSON.parse(raw);
      if (req.headers.authorization !== "Bearer test-only-token") {
        respond(401, { error: "unauthorized" });
        return;
      }
      if (req.headers["idempotency-key"] !== `${body.recordId}:${body.revision}`) {
        respond(400, { error: "idempotency_key" });
        return;
      }
      requests.push(body);
      if (control.status !== 200) {
        respond(control.status, { error: "injected_failure" });
        return;
      }
      const hash = createHash("sha256").update(raw).digest("hex");
      database.exec("BEGIN IMMEDIATE");
      let status = "applied";
      let revision = body.revision;
      try {
        const old = read(body.recordId);
        if (old && old.revision === body.revision) {
          if (old.request_hash !== hash) {
            database.exec("ROLLBACK");
            respond(409, { error: "revision_conflict" });
            return;
          }
          status = "duplicate";
        } else if (old && old.revision > body.revision) {
          status = "stale";
          revision = old.revision;
        } else {
          if (!old && body.content.mode === "preserve") {
            database.exec("ROLLBACK");
            respond(409, { error: "content_required" });
            return;
          }
          const oldContent = old ? JSON.parse(old.content) : undefined;
          const content =
            body.content.mode === "preserve" ||
            (oldContent?.status === "available" && body.content.status !== "available")
              ? oldContent
              : body.content;
          database
            .prepare(`INSERT INTO feedback VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(record_id) DO UPDATE SET revision=excluded.revision,
            request_hash=excluded.request_hash, snapshot=excluded.snapshot, content=excluded.content`)
            .run(body.recordId, body.revision, hash, raw, JSON.stringify(content));
        }
        if (control.failCommit) throw new Error("injected_commit_failure");
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      if (control.loseAck) {
        res.destroy();
        return;
      }
      respond(
        200,
        control.badAck
          ? { ok: true }
          : {
              schemaVersion: 1,
              recordId: body.recordId,
              acceptedRevision: revision,
              status,
            },
      );
    } catch {
      if (!res.headersSent) respond(503, { error: "transaction_failed" });
    }
  });
  // Port 0 atomically reserves an unused loopback port; no fixed port can collide.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  await mkdir(".local/reports", { recursive: true });
  await appendFile(
    ".local/reports/test-ports.jsonl",
    JSON.stringify({
      purpose: "feedback-sqlite-transaction-test",
      port,
      pid: process.pid,
      at: new Date().toISOString(),
    }) + "\n",
  );
  return {
    endpoint: `http://127.0.0.1:${port}/v1/feedback/snapshots`,
    control,
    requests,
    databasePath,
    read,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    },
  };
}
