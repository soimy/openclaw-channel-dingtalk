import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNamespacePath } from "../../src/persistence-store";
import {
  activateAskUserQuestion,
  claimAskUserQuestion,
  invalidateAskUserQuestionsInScope,
  recoverAskUserQuestionsAfterRestart,
  reserveAskUserQuestion,
  resolveAskUserQuestion,
  terminateAskUserQuestion,
} from "../../src/card/ask-user-question-store";

describe("ask-user-question-store", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-ask-user-store-"));
    tempDirs.push(dir);
    return {
      storePath: path.join(dir, "sessions.json"),
      accountId: "main",
      now: () => 1_000,
    };
  }

  function reserve(
    store: ReturnType<typeof createStore>,
    overrides: Partial<Parameters<typeof reserveAskUserQuestion>[1]> = {},
    now = 1_000,
  ) {
    return reserveAskUserQuestion(
      { ...store, now: () => now },
      {
        questionId: "q_1",
        questionScopeKey: "main:session:user-1",
        outTrackId: "ask_1",
        title: "需要确认",
        ...overrides,
      },
    );
  }

  it("reserves then activates a pending question", () => {
    const store = createStore();
    expect(reserve(store).state).toBe("reserved");

    const result = activateAskUserQuestion({ ...store, now: () => 1_100 }, "q_1");

    expect(result.record?.state).toBe("pending");
    expect(result.superseded).toEqual([]);
    expect(resolveAskUserQuestion(store, { outTrackId: "ask_1" })?.state).toBe("pending");
  });

  it("supersedes an older active question only when the new one activates", () => {
    const store = createStore();
    reserve(store);
    activateAskUserQuestion({ ...store, now: () => 1_100 }, "q_1");
    reserve(
      store,
      { questionId: "q_2", outTrackId: "ask_2", title: "更新的问题" },
      1_200,
    );

    expect(resolveAskUserQuestion(store, { questionId: "q_1" })?.state).toBe("pending");

    const result = activateAskUserQuestion({ ...store, now: () => 1_300 }, "q_2");

    expect(result.record?.state).toBe("pending");
    expect(result.superseded.map((record) => record.questionId)).toEqual(["q_1"]);
    expect(resolveAskUserQuestion(store, { questionId: "q_1" })).toMatchObject({
      state: "terminal",
      terminalReason: "superseded_by_question",
    });
  });

  it("allows a pending question to be claimed exactly once", () => {
    const store = createStore();
    reserve(store);
    activateAskUserQuestion(store, "q_1");

    expect(claimAskUserQuestion(store, { questionId: "q_1" })?.state).toBe("dispatching");
    expect(claimAskUserQuestion(store, { questionId: "q_1" })).toBeUndefined();
  });

  it("keeps the first terminal transition", () => {
    const store = createStore();
    reserve(store);
    activateAskUserQuestion(store, "q_1");

    expect(terminateAskUserQuestion(store, "q_1", "cancelled")?.terminalReason).toBe(
      "cancelled",
    );
    expect(terminateAskUserQuestion(store, "q_1", "submitted")).toBeUndefined();
    expect(resolveAskUserQuestion(store, { questionId: "q_1" })?.terminalReason).toBe(
      "cancelled",
    );
  });

  it("invalidates all active questions in one scope without touching another scope", () => {
    const store = createStore();
    reserve(store);
    activateAskUserQuestion(store, "q_1");
    reserve(
      store,
      {
        questionId: "q_2",
        outTrackId: "ask_2",
        questionScopeKey: "main:other-session:user-1",
      },
      1_100,
    );
    activateAskUserQuestion(store, "q_2");

    const invalidated = invalidateAskUserQuestionsInScope(
      store,
      "main:session:user-1",
      "superseded_by_message",
    );

    expect(invalidated.map((record) => record.questionId)).toEqual(["q_1"]);
    expect(resolveAskUserQuestion(store, { questionId: "q_1" })?.terminalReason).toBe(
      "superseded_by_message",
    );
    expect(resolveAskUserQuestion(store, { questionId: "q_2" })?.state).toBe("pending");
  });

  it("turns expired active records into tombstones and later removes old tombstones", () => {
    const store = createStore();
    reserve(store, {}, 1_000);
    activateAskUserQuestion({ ...store, now: () => 1_100 }, "q_1");

    const expired = resolveAskUserQuestion(
      { ...store, now: () => 5 * 60 * 1_000 + 1_101 },
      { questionId: "q_1" },
    );
    expect(expired).toMatchObject({ state: "terminal", terminalReason: "expired" });

    expect(
      resolveAskUserQuestion(
        { ...store, now: () => 35 * 60 * 1_000 + 1_102 },
        { questionId: "q_1" },
      ),
    ).toBeUndefined();
  });

  it("persists lifecycle metadata without runtime context or answer bodies", () => {
    const store = createStore();
    reserve(store);
    const filePath = resolveNamespacePath("cards.ask-user.lifecycle", {
      ...store,
      scope: { accountId: store.accountId },
    });

    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain("questionScopeKey");
    expect(raw).not.toContain("sessionWebhook");
    expect(raw).not.toContain("access-token");
    expect(raw).not.toContain("answer_");
  });

  it("fails closed when recovering active records after restart", () => {
    const store = createStore();
    reserve(store);
    activateAskUserQuestion(store, "q_1");
    reserve(
      store,
      {
        questionId: "q_2",
        outTrackId: "ask_2",
        questionScopeKey: "main:session:user-2",
      },
      1_100,
    );
    activateAskUserQuestion(store, "q_2");
    claimAskUserQuestion(store, { questionId: "q_2" });

    const recovered = recoverAskUserQuestionsAfterRestart({ ...store, now: () => 2_000 });

    expect(recovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionId: "q_1",
          state: "terminal",
          terminalReason: "restart_invalidated",
        }),
        expect.objectContaining({
          questionId: "q_2",
          state: "terminal",
          terminalReason: "restart_during_dispatch",
        }),
      ]),
    );
  });
});
