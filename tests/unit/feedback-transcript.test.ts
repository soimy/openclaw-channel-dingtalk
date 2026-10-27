import { describe, expect, it, vi } from "vitest";
import {
  createFeedbackTranscriptTracker,
  noteFeedbackRunSession,
  feedbackTranscriptText,
} from "../../src/card/feedback-transcript";

function setup(overrides: Partial<Parameters<typeof createFeedbackTranscriptTracker>[0]> = {}) {
  let listener: ((event: unknown) => void) | undefined;
  const unsubscribe = vi.fn();
  const tracker = createFeedbackTranscriptTracker({
    agentId: "main",
    sessionKey: "agent:main:test",
    senderId: "alice",
    questionTexts: ["Question"],
    subscribe: (fn) => {
      listener = fn;
      return unsubscribe;
    },
    ...overrides,
  });
  const emit = (role: string, id: string, text: string, extra: Record<string, unknown> = {}) =>
    listener?.({
      target: { agentId: "main", sessionKey: "agent:main:test", sessionId: "session-original" },
      sessionFile: "/state/session-original.jsonl",
      messageId: id,
      message: {
        role,
        content: [{ type: "text", text }],
        ...(role === "user"
          ? { sourceChannel: "dingtalk", senderId: "alice" }
          : { stopReason: "stop" }),
      },
      ...extra,
    });
  return { tracker, emit, unsubscribe };
}
const linked = {
  status: "linked",
  sessionId: "session-original",
  userMessageId: "q1",
  assistantMessageId: "a1",
  source: "runtime-events",
};
describe("zero-I/O transcript reference capture", () => {
  it("keeps trusted storage hints local and opt-in", () => {
    const x = setup();
    x.emit("user", "q1", "Question");
    x.emit("assistant", "a1", "Answer");
    expect(x.tracker.resolve("Answer")).not.toHaveProperty("localFile");
    expect(x.tracker.resolve("Answer", { includeLocalFile: true })).toMatchObject({
      localFile: "/state/session-original.jsonl",
    });
    x.tracker.dispose();
  });

  it("captures public session and persisted message ids", () => {
    const x = setup();
    x.emit("user", "q1", "Question");
    x.emit("assistant", "a1", "Answer");
    expect(x.tracker.resolve("Answer")).toEqual(linked);
    x.tracker.dispose();
  });
  it("uses existing llm_output identity when legacy append events omit sessionId", () => {
    const x = setup();
    x.tracker.bindRun("run-legacy");
    const extra = { target: undefined, agentId: "main", sessionKey: "agent:main:test" };
    x.emit("user", "q1", "Question", extra);
    x.emit("assistant", "a1", "Answer", extra);
    noteFeedbackRunSession("run-legacy", "session-original", {
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    expect(x.tracker.resolve("Answer")).toEqual(linked);
    x.tracker.dispose();
  });
  it("does not guess session id from a file path", () => {
    const x = setup();
    const extra = { target: undefined, agentId: "main", sessionKey: "agent:main:test" };
    x.emit("user", "q1", "Question", extra);
    x.emit("assistant", "a1", "Answer", extra);
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "session-id-missing" });
    x.tracker.dispose();
  });
  it("does not subscribe when the capability is unavailable", () => {
    const x = setup({ subscribe: undefined });
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "events-unavailable" });
    x.tracker.dispose();
  });
  it("handles optional subscription failures without affecting answers", () => {
    const x = setup({
      subscribe: () => {
        throw new Error("unavailable");
      },
    });
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "events-unavailable" });
    x.tracker.dispose();
  });
  it.each(["agent", "session"])("ignores another %s scope", (kind) => {
    const x = setup();
    x.emit("user", "q1", "Question", {
      target: {
        agentId: kind === "agent" ? "other" : "main",
        sessionKey: kind === "session" ? "other" : "agent:main:test",
        sessionId: "session-original",
      },
    });
    x.emit("assistant", "a1", "Answer");
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "question-not-observed" });
    x.tracker.dispose();
  });
  it.each([
    { sourceChannel: "webchat", senderId: "alice" },
    { sourceChannel: "dingtalk", senderId: "bob" },
  ])("ignores a foreign source or sender", (attribution) => {
    const x = setup();
    x.emit("user", "q1", "Question", {
      message: { role: "user", content: "Question", ...attribution },
    });
    x.emit("assistant", "a1", "Answer");
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "question-not-observed" });
    x.tracker.dispose();
  });
  it("does not attach an answer without observing its question", () => {
    const x = setup();
    x.emit("assistant", "a1", "Answer");
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "question-not-observed" });
    x.tracker.dispose();
  });
  it("rejects an intervening user turn even if its answer text is identical", () => {
    const x = setup();
    x.emit("user", "q1", "Question");
    x.emit("user", "q2", "Question");
    x.emit("assistant", "a1", "Answer");
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "ambiguous-turn" });
    x.tracker.dispose();
  });
  it("deduplicates repeated event delivery of the same message ids", () => {
    const x = setup();
    for (let i = 0; i < 2; i++) x.emit("user", "q1", "Question");
    for (let i = 0; i < 2; i++) x.emit("assistant", "a1", "Answer");
    expect(x.tracker.resolve("Answer")).toEqual(linked);
    x.tracker.dispose();
  });
  it("rejects identical content belonging to two different assistant messages", () => {
    const x = setup();
    x.emit("user", "q1", "Question");
    x.emit("assistant", "a1", "Answer");
    x.emit("assistant", "a2", "Answer");
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "ambiguous-turn" });
    x.tracker.dispose();
  });
  it("does not bind a different native provider turn", () => {
    const x = setup();
    x.emit("user", "q1", "Question", {
      message: {
        role: "user",
        content: "Question",
        __openclaw: { mirrorIdentity: "turn-a:prompt" },
      },
    });
    x.emit("assistant", "a1", "Answer", {
      message: {
        role: "assistant",
        content: "Answer",
        __openclaw: { mirrorIdentity: "turn-b:assistant" },
      },
    });
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "answer-not-observed" });
    x.tracker.dispose();
  });
  it("does not bind after session reset or a changed transcript artifact", () => {
    const x = setup();
    x.emit("user", "q1", "Question");
    x.emit("assistant", "a1", "Answer", { sessionFile: "/state/new.jsonl" });
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "ambiguous-turn" });
    x.tracker.dispose();
  });
  it("rejects inconsistent session identities from the runtime", () => {
    const x = setup();
    x.tracker.bindRun("run-conflict");
    x.emit("user", "q1", "Question");
    x.emit("assistant", "a1", "Answer");
    noteFeedbackRunSession("run-conflict", "other-session");
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "ambiguous-turn" });
    x.tracker.dispose();
  });
  it("does not match transformed or prefixed output by approximate text", () => {
    const x = setup();
    x.emit("user", "q1", "Question");
    x.emit("assistant", "a1", "Answer");
    expect(x.tracker.resolve("Prefix: Answer")).toMatchObject({ reason: "content-mismatch" });
    x.tracker.dispose();
  });
  it("ignores failed and tool-use assistant messages", () => {
    const x = setup();
    x.emit("user", "q1", "Question");
    for (const reason of ["error", "aborted", "toolUse"])
      x.emit("assistant", reason, "Answer", {
        message: { role: "assistant", content: "Answer", stopReason: reason },
      });
    x.emit("assistant", "a1", "Answer");
    expect(x.tracker.resolve("Answer")).toEqual(linked);
    x.tracker.dispose();
  });
  it("bounds candidate capture rather than retaining an entire session", () => {
    const x = setup();
    x.emit("user", "q1", "Question");
    for (let i = 0; i < 9; i++) x.emit("assistant", `a${i}`, `Answer${i}`);
    expect(x.tracker.resolve("Answer8")).toMatchObject({ reason: "capture-limit" });
    x.tracker.dispose();
  });
  it("does not retain oversized content or expose thinking blocks", () => {
    expect(
      feedbackTranscriptText({
        content: [
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "visible" },
        ],
      }),
    ).toBe("visible");
    const x = setup();
    x.emit("user", "q1", "Question");
    x.emit("assistant", "a1", "a".repeat(128001));
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "capture-limit" });
    x.tracker.dispose();
  });
  it("releases listeners and run bindings on disposal", () => {
    const x = setup();
    x.tracker.bindRun("run-cleanup");
    x.tracker.dispose();
    expect(x.unsubscribe).toHaveBeenCalledOnce();
    const y = setup();
    y.tracker.bindRun("run-cleanup");
    y.emit("user", "q1", "Question");
    y.emit("assistant", "a1", "Answer");
    noteFeedbackRunSession("run-cleanup", "session-original");
    expect(y.tracker.resolve("Answer")).toEqual(linked);
    y.tracker.dispose();
  });
  it("does not throw from optional unsubscribe cleanup", () => {
    const x = setup({
      subscribe: () => () => {
        throw new Error("cleanup");
      },
    });
    expect(() => x.tracker.dispose()).not.toThrow();
  });
  it("accepts only an explicit host-derived question alias for the same actual session", () => {
    const x = setup({ questionSessionKeys: ["agent:main:dingtalk:default:direct:alice"] });
    x.emit("user", "q1", "Question", {
      target: {
        agentId: "main",
        sessionKey: "agent:main:dingtalk:default:direct:alice",
        sessionId: "session-original",
      },
    });
    x.emit("assistant", "a1", "Answer");
    expect(x.tracker.resolve("Answer")).toEqual(linked);
    x.tracker.dispose();
  });
  it("does not accept an alias belonging to another account", () => {
    const x = setup({ questionSessionKeys: ["agent:main:dingtalk:default:direct:alice"] });
    x.emit("user", "q1", "Question", {
      target: {
        agentId: "main",
        sessionKey: "agent:main:dingtalk:other:direct:alice",
        sessionId: "session-original",
      },
    });
    x.emit("assistant", "a1", "Answer");
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "question-not-observed" });
    x.tracker.dispose();
  });
  it("rejects an accepted alias if the actual answer session differs", () => {
    const x = setup({ questionSessionKeys: ["question-alias"] });
    x.emit("user", "q1", "Question", {
      target: { agentId: "main", sessionKey: "question-alias", sessionId: "other-session" },
    });
    x.emit("assistant", "a1", "Answer");
    expect(x.tracker.resolve("Answer")).toMatchObject({ reason: "ambiguous-turn" });
    x.tracker.dispose();
  });
});
