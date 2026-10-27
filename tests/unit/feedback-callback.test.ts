import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleFeedbackCallback, parseFeedbackCallback } from "../../src/card/feedback-callback";
import { runFeedbackCommand } from "../../src/command/feedback-command";
import {
  completeFeedbackCard,
  feedbackStats,
  registerFeedbackCard,
} from "../../src/command/feedback-store";
import type { DingTalkConfig } from "../../src/platform/types";

// Matches the real Stream payload captured from the native Feedback component.
function payload(value: unknown = "like", key = "node_ocmncu094ga_likeOrDislike") {
  return {
    type: "actionCallback",
    spaceType: "im",
    userId: "alice",
    userIdType: 1,
    outTrackId: "card-1",
    content: JSON.stringify({
      cardPrivateData: {
        actionIds: ["feedback_vote"],
        params: { variableKey: key, variableValue: value, extraParams: {} },
      },
    }),
  };
}
describe("native feedback callback contract", () => {
  let dir: string;
  let scope: { storePath: string; accountId: string };
  const config = { feedbackEnabled: true } as DingTalkConfig;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dt-feedback-callback-"));
    scope = { storePath: path.join(dir, "sessions.json"), accountId: "default" };
    await registerFeedbackCard(scope, {
      outTrackId: "card-1",
      ownerUserId: "alice",
      conversationId: "cid-1",
      sessionKey: "session-1",
      agentId: "main",
    });
    await completeFeedbackCard(scope, "card-1", "Answer");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const event = () => ({ eventId: "e1", eventAt: String(Date.now()), config });
  it("returns a private state patch only after recording success", async () => {
    const result = await handleFeedbackCallback({ ...event(), scope, payload: payload() });
    expect(result?.notice).toBeUndefined();
    expect(result?.response).toEqual({
      cardUpdateOptions: { updatePrivateDataByKey: true },
      userPrivateData: {
        cardParamMap: {
          node_ocmncu094ga_likeOrDislike: "like",
          node_ocmncu094ga_dislikeTags: "null",
        },
      },
    });
    expect((await feedbackStats(scope, "alice", 7)).like).toBe(1);
  });
  it("never trusts an owner claimed inside submitted parameters", async () => {
    const body = payload();
    body.userId = "bob";
    body.content = body.content.replace(
      '"extraParams":{}',
      '"extraParams":{"ownerUserId":"alice"}',
    );
    const result = await handleFeedbackCallback({ ...event(), scope, payload: body });
    expect(result?.notice).toContain("原提问者");
    expect((await feedbackStats(scope, "alice", 7)).like).toBe(0);
  });
  it("fails closed when identity type is unionId instead of staff UserId", async () => {
    expect(
      (
        await handleFeedbackCallback({
          ...event(),
          scope,
          payload: { ...payload(), userIdType: 2 },
        })
      )?.notice,
    ).toContain("原提问者");
  });
  it("rejects feedback when recording is disabled", async () => {
    expect(
      (
        await handleFeedbackCallback({
          ...event(),
          scope,
          payload: payload(),
          config: {} as DingTalkConfig,
        })
      )?.notice,
    ).toContain("未启用");
  });
  it("does not fall back to volatile storage", async () => {
    expect((await handleFeedbackCallback({ ...event(), payload: payload() }))?.notice).toContain(
      "未启用",
    );
  });
  it("accepts actual reason codes and rejects unknown/prototype keys", () => {
    expect(
      parseFeedbackCallback(payload(["2", "3"], "node_ocmncu094ga_dislikeTags"))?.reasons,
    ).toEqual(["2", "3"]);
    for (const value of [["constructor"], ["7"], [2], "2"]) {
      expect(parseFeedbackCallback(payload(value, "node_ocmncu094ga_dislikeTags"))?.valid).toBe(
        false,
      );
    }
  });
  it("rejects arbitrary variable writes", () => {
    expect(parseFeedbackCallback(payload("like", "content"))?.valid).toBe(false);
    expect(parseFeedbackCallback(payload("yes"))?.valid).toBe(false);
  });
  it("does not claim unrelated card callbacks", () => {
    expect(
      parseFeedbackCallback({
        ...payload(),
        content: payload().content.replace("feedback_vote", "btn_stop"),
      }),
    ).toBeUndefined();
  });
  it("requires a transport event id for durable idempotency", async () => {
    expect(
      (await handleFeedbackCallback({ ...event(), scope, payload: payload(), eventId: undefined }))
        ?.notice,
    ).toContain("无效");
  });
  it("supports content and value envelopes without taking identity from the body", () => {
    const body = payload();
    expect(parseFeedbackCallback({ ...body, content: undefined, value: body.content })?.vote).toBe(
      "like",
    );
  });
  it("formats self-service statistics without invoking a model", async () => {
    await handleFeedbackCallback({ ...event(), scope, payload: payload() });
    const text = await runFeedbackCommand("/feedback stats 30d", {
      scope,
      userId: "alice",
      isDirect: true,
      enabled: true,
    });
    expect(text).toContain("点赞：1 条");
    expect(text).toContain("100.0%");
  });
  it("does not disclose personal statistics in a group", async () => {
    expect(
      await runFeedbackCommand("/feedback stats", {
        scope,
        userId: "alice",
        isDirect: false,
        enabled: true,
      }),
    ).toContain("私聊");
  });
  it("bounds query windows and does not intercept other slash commands", async () => {
    const options = { scope, userId: "alice", isDirect: true, enabled: true };
    expect(await runFeedbackCommand("/feedback stats 999d", options)).toContain("用法");
    expect(await runFeedbackCommand("/learn list", options)).toBeUndefined();
  });
  it("distinguishes an unopened reason panel from closing it without a reason", async () => {
    const time = Date.now();
    const base = { config, scope, eventAt: String(time) };
    const down = await handleFeedbackCallback({
      ...base,
      eventId: "down",
      payload: payload("dislike"),
    });
    expect(JSON.stringify(down?.response)).toContain('"node_ocmncu094ga_dislikeTags":"null"');
    const closed = await handleFeedbackCallback({
      ...base,
      eventAt: String(time + 1),
      eventId: "closed",
      payload: payload([], "node_ocmncu094ga_dislikeTags"),
    });
    expect(JSON.stringify(closed?.response)).toContain('"node_ocmncu094ga_dislikeTags":"[]"');
    const withdrawn = await handleFeedbackCallback({
      ...base,
      eventAt: String(time + 2),
      eventId: "withdrawn",
      payload: payload("none"),
    });
    expect(JSON.stringify(withdrawn?.response)).toContain('"node_ocmncu094ga_dislikeTags":"null"');
    const again = await handleFeedbackCallback({
      ...base,
      eventAt: String(time + 3),
      eventId: "again",
      payload: payload("dislike"),
    });
    expect(JSON.stringify(again?.response)).toContain('"node_ocmncu094ga_dislikeTags":"null"');
  });
});
