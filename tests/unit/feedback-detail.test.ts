import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFeedbackCommand } from "../../src/command/feedback-command";
import {
  feedbackDetail,
  resolveFeedbackTranscriptMessages,
} from "../../src/command/feedback-detail";
import {
  registerFeedbackCard,
  completeFeedbackCard,
  readFeedbackRecord,
  type FeedbackRecord,
} from "../../src/command/feedback-store";

const link = {
  status: "linked" as const,
  source: "runtime-events" as const,
  sessionId: "original-session",
  userMessageId: "question-id",
  assistantMessageId: "answer-id",
};
const events = () => [
  { type: "session", id: "original-session" },
  {
    type: "message",
    id: "question-id",
    message: { role: "user", content: "My original question" },
  },
  {
    type: "message",
    id: "answer-id",
    parentId: "question-id",
    message: { role: "assistant", content: [{ type: "text", text: "Exact answer" }] },
  },
  {
    type: "message",
    id: "newer-answer",
    message: { role: "assistant", content: "Do not substitute this newer answer" },
  },
];
function verified(record: FeedbackRecord, rows: unknown[]) {
  const pair = resolveFeedbackTranscriptMessages(record, rows);
  return pair
    ? { mode: "replace" as const, status: "available" as const, ...pair }
    : {
        mode: "replace" as const,
        status: "unverified" as const,
        reason: "content_verification_failed",
      };
}
describe("explicit owner-only transcript lookup", () => {
  let dir: string;
  let scope: { storePath: string; accountId: string };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "feedback-detail-"));
    scope = { storePath: path.join(dir, "sessions.json"), accountId: "default" };
    await registerFeedbackCard(scope, {
      outTrackId: "card-1",
      ownerUserId: "alice",
      agentId: "main",
      sessionKey: "agent:main:main",
      conversationId: "cid-1",
      sourceMsgId: "ding-question",
    });
    await completeFeedbackCard(scope, "card-1", "Exact answer", undefined, link);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("saves immutable transcript identity alongside the original answer hash", async () => {
    const record = await readFeedbackRecord(scope, "card-1");
    expect(record?.transcript).toEqual(link);
    await completeFeedbackCard(scope, "card-1", "different", undefined, {
      ...link,
      sessionId: "wrong",
    });
    expect((await readFeedbackRecord(scope, "card-1"))?.transcript).toEqual(link);
  });
  it("uses the stored session id, not the session key's current turn", async () => {
    const readContent = vi
      .fn()
      .mockImplementation(async (record: FeedbackRecord) => verified(record, events()));
    const result = await feedbackDetail({
      scope,
      outTrackId: "card-1",
      userId: "alice",
      readContent,
    });
    expect(readContent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:main",
        transcript: link,
      }),
    );
    expect(result).toContain("My original question");
    expect(result).toContain("Exact answer");
    expect(result).not.toContain("newer answer");
  });
  it("checks ownership before reading a shared transcript", async () => {
    const readContent = vi.fn();
    expect(
      await feedbackDetail({ scope, outTrackId: "card-1", userId: "bob", readContent }),
    ).toContain("有权");
    expect(readContent).not.toHaveBeenCalled();
  });
  it("does not read any transcript for unknown cards", async () => {
    const readContent = vi.fn();
    await feedbackDetail({ scope, outTrackId: "unknown", userId: "alice", readContent });
    expect(readContent).not.toHaveBeenCalled();
  });
  it("rejects missing old messages rather than falling back to the latest", async () => {
    const result = await feedbackDetail({
      scope,
      outTrackId: "card-1",
      userId: "alice",
      readContent: async (record) =>
        verified(
          record,
          events().filter((x) => x.id !== "answer-id"),
        ),
    });
    expect(result).toContain("指定消息缺失");
    expect(result).not.toContain("newer answer");
  });
  it("checks content integrity before showing a persisted answer", async () => {
    const changed = events();
    changed[2].message!.content = "changed answer";
    const result = await feedbackDetail({
      scope,
      outTrackId: "card-1",
      userId: "alice",
      readContent: async (record) => verified(record, changed),
    });
    expect(result).toContain("内容校验不一致");
  });
  it("rejects a different session header or duplicate message ids", async () => {
    const record = (await readFeedbackRecord(scope, "card-1"))!;
    const changed = events();
    changed[0].id = "other-session";
    expect(resolveFeedbackTranscriptMessages(record, changed)).toBeUndefined();
    expect(resolveFeedbackTranscriptMessages(record, [...events(), events()[2]])).toBeUndefined();
  });
  it("rejects swapped roles or order", async () => {
    const record = (await readFeedbackRecord(scope, "card-1"))!;
    const changed = events();
    changed[2].message!.role = "user";
    expect(resolveFeedbackTranscriptMessages(record, changed)).toBeUndefined();
    const e = events();
    expect(resolveFeedbackTranscriptMessages(record, [e[0], e[2], e[1]])).toBeUndefined();
  });
  it("rejects a question from another sender or channel", async () => {
    const record = (await readFeedbackRecord(scope, "card-1"))!;
    for (const extra of [{ senderId: "bob" }, { sourceChannel: "webchat" }]) {
      const changed = events();
      Object.assign(changed[1].message!, extra);
      expect(resolveFeedbackTranscriptMessages(record, changed)).toBeUndefined();
    }
    const valid = events();
    Object.assign(valid[1].message!, { senderId: "dingtalk:alice", sourceChannel: "dingtalk" });
    expect(resolveFeedbackTranscriptMessages(record, valid)?.question).toBe("My original question");
  });
  it("reports cleanup or unavailable host reads without inventing an answer", async () => {
    expect(
      await feedbackDetail({
        scope,
        outTrackId: "card-1",
        userId: "alice",
        readContent: async () => {
          throw new Error("missing");
        },
      }),
    ).toContain("无法读取");
  });
  it("does not backfill legacy records by scanning transcripts", async () => {
    await registerFeedbackCard(scope, {
      outTrackId: "legacy",
      ownerUserId: "alice",
      agentId: "main",
      sessionKey: "agent:main:main",
      conversationId: "cid-1",
    });
    await completeFeedbackCard(scope, "legacy", "old answer");
    const readContent = vi.fn();
    expect(
      await feedbackDetail({ scope, outTrackId: "legacy", userId: "alice", readContent }),
    ).toContain("旧记录未保存消息 ID");
    expect(readContent).not.toHaveBeenCalled();
  });
  it("routes explicit detail commands without a model call", async () => {
    expect(
      await runFeedbackCommand("/feedback detail card-1", {
        scope,
        userId: "alice",
        isDirect: true,
        enabled: true,
        readContent: async (record) => verified(record, events()),
      }),
    ).toContain("Exact answer");
  });
  it.each(["resource_budget", "read_timeout", "detail_busy"])(
    "reports %s without displaying a guessed answer",
    async (reason) => {
      const reply = await feedbackDetail({
        scope,
        outTrackId: "card-1",
        userId: "alice",
        readContent: async () => ({ mode: "replace", status: "pending", reason }),
      });
      expect(reply).not.toContain("**回答**");
      expect(reply).toMatch(/预算|超时|稍后/);
    },
  );
  it("does not expose query results in group chats", async () => {
    const readContent = vi.fn();
    expect(
      await runFeedbackCommand("/feedback detail card-1", {
        scope,
        userId: "alice",
        isDirect: false,
        enabled: true,
        readContent,
      }),
    ).toContain("私聊");
    expect(readContent).not.toHaveBeenCalled();
  });
});
