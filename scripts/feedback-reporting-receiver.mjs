#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, appendFile, rename, open } from "node:fs/promises";
// Loopback contract acceptance receiver, not a production OceanBase server.
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "19071" },
    "state-dir": { type: "string" },
    tenant: { type: "string", default: "test-org" },
    instance: { type: "string", default: "test-instance" },
    host: { type: "string", default: "127.0.0.1" },
  },
});
const root = values["state-dir"];
const token = process.env.FEEDBACK_REPORT_TOKEN;
if (!root || !token) throw Error("Provide --state-dir and FEEDBACK_REPORT_TOKEN");
await mkdir(root, { recursive: true, mode: 0o700 });
const queues = new Map();
const hash = (x) => createHash("sha256").update(x).digest("hex");
function reply(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}
async function read(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}
function validate(b, req) {
  const supplied = Buffer.from(String(req.headers.authorization ?? ""));
  const wanted = Buffer.from(`Bearer ${token}`);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return 401;
  if (
    b?.schemaVersion !== 1 ||
    b.type !== "dingtalk.feedback.snapshot" ||
    !Number.isSafeInteger(b.revision) ||
    b.revision < 1 ||
    b.revision >= Number.MAX_SAFE_INTEGER
  )
    return 400;
  if (
    b.source?.tenantId !== values.tenant ||
    b.source?.instanceId !== values.instance ||
    b.source?.channel !== "dingtalk"
  )
    return 403;
  if (
    typeof b.source.accountId !== "string" ||
    typeof b.cardId !== "string" ||
    !b.cardId ||
    b.cardId.length > 200 ||
    b.source.accountId.length > 128
  )
    return 400;
  if (
    b.recordId !==
    hash(JSON.stringify([b.source.tenantId, b.source.instanceId, b.source.accountId, b.cardId]))
  )
    return 400;
  if (req.headers["idempotency-key"] !== `${b.recordId}:${b.revision}`) return 400;
  if (
    !["like", "dislike", "none"].includes(b.feedback?.vote) ||
    !Array.isArray(b.feedback.reasons) ||
    b.feedback.reasons.some((x) => !["1", "2", "3", "4", "5", "6"].includes(x))
  )
    return 400;
  if (
    !["replace", "preserve"].includes(b.content?.mode) ||
    !["available", "missing", "unverified", "pending"].includes(b.content.status)
  )
    return 400;
  if (
    b.content.mode === "replace" &&
    b.content.status === "available" &&
    (typeof b.content.question !== "string" ||
      typeof b.content.answer !== "string" ||
      hash(b.content.answer) !== b.answerHash ||
      b.content.answerHash !== b.answerHash)
  )
    return 400;
  return 0;
}
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/feedback/snapshots") {
    reply(res, 404, { error: "not_found" });
    return;
  }
  try {
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 300 * 1024) {
        reply(res, 413, { error: "too_large" });
        return;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    const b = JSON.parse(raw.toString("utf8"));
    const status = validate(b, req);
    if (status) {
      reply(res, status, { error: "invalid_request" });
      return;
    }
    await appendFile(
      path.join(root, "requests.jsonl"),
      JSON.stringify({
        at: Date.now(),
        recordId: b.recordId,
        revision: b.revision,
        vote: b.feedback.vote,
      }) + "\n",
      { mode: 0o600 },
    );
    const control = (await read(path.join(root, "control.json"))) ?? {};
    if (control.delayMs)
      await new Promise((resolve) => setTimeout(resolve, Math.min(30000, control.delayMs)));
    if (control.status && control.status !== 200) {
      reply(res, control.status, { error: "injected_test_failure" });
      return;
    }
    const task = (queues.get(b.recordId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const file = path.join(root, `${b.recordId}.json`);
        const previous = await read(file);
        const immutable = (x) =>
          JSON.stringify([
            x.source.tenantId,
            x.source.instanceId,
            x.source.accountId,
            x.source.channel,
            x.cardId,
            x.questionerUserId,
            x.conversation.agentId,
            x.conversation.sessionKey,
            x.conversation.conversationId,
            x.conversation.sourceMsgId,
            x.conversation.transcript?.status,
            x.conversation.transcript?.sessionId,
            x.conversation.transcript?.userMessageId,
            x.conversation.transcript?.assistantMessageId,
            x.answerHash,
            x.createdAt,
            x.completedAt,
          ]);
        if (previous && immutable(previous.snapshot) !== immutable(b)) {
          reply(res, 409, { error: "identity_conflict" });
          return;
        }
        if (previous && previous.snapshot.revision === b.revision) {
          if (previous.requestHash !== hash(raw)) {
            reply(res, 409, { error: "revision_conflict" });
            return;
          }
          reply(res, 200, {
            schemaVersion: 1,
            recordId: b.recordId,
            acceptedRevision: b.revision,
            status: "duplicate",
          });
          return;
        }
        if (previous && previous.snapshot.revision > b.revision) {
          reply(res, 200, {
            schemaVersion: 1,
            recordId: b.recordId,
            acceptedRevision: previous.snapshot.revision,
            status: "stale",
          });
          return;
        }
        if (b.content.mode === "preserve" && !previous) {
          reply(res, 409, { error: "content_required" });
          return;
        }
        const content =
          b.content.mode === "preserve" ||
          (previous?.content?.status === "available" && b.content.status !== "available")
            ? previous.content
            : b.content;
        const saved = { snapshot: b, content, requestHash: hash(raw), receivedAt: Date.now() };
        const tmp = `${file}.tmp`;
        const h = await open(tmp, "w", 0o600);
        try {
          await h.writeFile(JSON.stringify(saved));
          await h.sync();
        } finally {
          await h.close();
        }
        await rename(tmp, file);
        if (control.badAck) {
          reply(res, 200, { ok: true });
          return;
        }
        reply(res, 200, {
          schemaVersion: 1,
          recordId: b.recordId,
          acceptedRevision: b.revision,
          status: "applied",
        });
      });
    queues.set(b.recordId, task);
    await task;
    if (queues.get(b.recordId) === task) queues.delete(b.recordId);
  } catch {
    if (!res.headersSent) reply(res, 500, { error: "receiver_failure" });
  }
});
server.listen(Number(values.port), values.host, () =>
  process.stdout.write(`Acceptance receiver listening on ${values.host}:${values.port}\n`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
