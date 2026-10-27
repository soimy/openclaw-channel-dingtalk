import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveFeedbackReporting } from "../../../src/command/feedback-reporting-config";
import type { ReportJob } from "../../../src/command/feedback-reporting-protocol";

export async function reportingFixture(endpoint = "http://127.0.0.1:1/report") {
  const dir = await mkdtemp(path.join(tmpdir(), "feedback-report-"));
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const transcriptStorePath = path.join(dir, "sessions.json");
  const sessionFile = path.join(dir, `${sessionId}.jsonl`);
  const now = Date.now();
  const config = resolveFeedbackReporting({
    enabled: true,
    endpoint,
    tenantId: "test-org",
    instanceId: "test-instance",
    token: "test-only-token",
    idleMs: 1000,
    requestTimeoutMs: 500,
  })!;
  const { token, ...publicConfig } = config;
  const job: ReportJob = {
    scope: { storePath: path.join(dir, "ratings", "sessions.json"), accountId: "default" },
    transcriptStorePath,
    config: publicConfig,
    token: String(token),
    record: {
      version: 1,
      accountId: "default",
      outTrackId: "card-1",
      ownerUserId: "alice",
      conversationId: "cid-1",
      sessionKey: "agent:main:main",
      agentId: "main",
      sourceMsgId: "ding-q1",
      createdAt: now,
      expiresAt: now + 86400000,
      completedAt: now,
      lastEventAt: now,
      vote: "dislike",
      reasons: ["2"],
      reasonsSubmitted: true,
      answerHash: createHash("sha256").update("Answer").digest("hex"),
      transcript: {
        status: "linked",
        source: "runtime-events",
        sessionId,
        userMessageId: "q1",
        assistantMessageId: "a1",
      },
      reporting: {
        destinationKey: config.destinationKey,
        revision: 1,
        retainUntil: now + 86400000,
      },
    },
  };
  const events = [
    { type: "session", id: sessionId },
    {
      type: "message",
      id: "q1",
      message: { role: "user", content: "Question", senderId: "alice", sourceChannel: "dingtalk" },
    },
    {
      type: "message",
      id: "a1",
      parentId: "q1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Answer" },
          { type: "thinking", thinking: "Never report this" },
        ],
      },
    },
  ];
  await mkdir(path.dirname(job.scope.storePath), { recursive: true });
  await writeFile(
    transcriptStorePath,
    JSON.stringify({ "agent:main:main": { sessionId, sessionFile, updatedAt: now } }),
  );
  await writeFile(sessionFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { dir, job, config, events, sessionFile };
}
