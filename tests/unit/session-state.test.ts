import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  clearAllSessionStatesForTest,
  getSessionState,
  getTaskTimeSeconds,
  initSessionState,
  updateSessionState,
} from "../../src/session-state";

const mainScope = {
  accountId: "main",
  conversationId: "conv-1",
  agentId: "main",
};

describe("session-state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAllSessionStatesForTest();
  });

  it("resets taskStartTime on each initSessionState call for the same session", async () => {
    initSessionState(mainScope);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getTaskTimeSeconds(mainScope)).toBe(5);

    initSessionState(mainScope);
    expect(getTaskTimeSeconds(mainScope)).toBe(0);
  });

  it("initializes model and effort when provided", () => {
    initSessionState(mainScope, {
      model: "deepseek-v4-pro",
      effort: "high",
    });

    expect(getSessionState(mainScope)).toMatchObject({
      model: "deepseek-v4-pro",
      effort: "high",
    });
  });

  it("preserves existing model and effort when reinitialized without metadata", () => {
    initSessionState(mainScope, {
      model: "deepseek-v4-pro",
      effort: "high",
    });

    initSessionState(mainScope);

    expect(getSessionState(mainScope)).toMatchObject({
      model: "deepseek-v4-pro",
      effort: "high",
    });
  });

  it("keeps runtime-selected model and effort when configured metadata is seeded again", () => {
    initSessionState(mainScope, {
      model: "configured-model",
      effort: "low",
    });
    updateSessionState(mainScope, {
      model: "runtime-model",
      effort: "high",
    });

    initSessionState(mainScope, {
      model: "configured-model",
      effort: "low",
    });

    expect(getSessionState(mainScope)).toMatchObject({
      model: "runtime-model",
      effort: "high",
    });
  });

  it("treats blank initial metadata as absent", () => {
    initSessionState(mainScope, {
      model: "runtime-model",
      effort: "high",
    });

    initSessionState(mainScope, {
      model: "",
      effort: "   ",
    });

    expect(getSessionState(mainScope)).toMatchObject({
      model: "runtime-model",
      effort: "high",
    });
  });

  it("isolates task metadata by routed agent within the same conversation", () => {
    const agentAScope = {
      accountId: "main",
      conversationId: "conv-1",
      agentId: "agent-a",
    };
    const agentBScope = {
      accountId: "main",
      conversationId: "conv-1",
      agentId: "agent-b",
    };

    initSessionState(agentAScope, {
      model: "model-a",
      effort: "low",
    });
    initSessionState(agentBScope, {
      model: "model-b",
      effort: "high",
    });

    expect(getSessionState(agentAScope)).toMatchObject({
      model: "model-a",
      effort: "low",
    });
    expect(getSessionState(agentBScope)).toMatchObject({
      model: "model-b",
      effort: "high",
    });
  });
});
