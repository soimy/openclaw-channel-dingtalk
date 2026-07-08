import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  clearAllSessionStatesForTest,
  getSessionState,
  getTaskTimeSeconds,
  initSessionState,
  updateSessionState,
} from "../../src/session-state";

describe("session-state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAllSessionStatesForTest();
  });

  it("resets taskStartTime on each initSessionState call for the same session", async () => {
    initSessionState("main", "conv-1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(getTaskTimeSeconds("main", "conv-1")).toBe(5);

    initSessionState("main", "conv-1");
    expect(getTaskTimeSeconds("main", "conv-1")).toBe(0);
  });

  it("initializes model and effort when provided", () => {
    initSessionState("main", "conv-1", {
      model: "deepseek-v4-pro",
      effort: "high",
    });

    expect(getSessionState("main", "conv-1")).toMatchObject({
      model: "deepseek-v4-pro",
      effort: "high",
    });
  });

  it("preserves existing model and effort when reinitialized without metadata", () => {
    initSessionState("main", "conv-1", {
      model: "deepseek-v4-pro",
      effort: "high",
    });

    initSessionState("main", "conv-1");

    expect(getSessionState("main", "conv-1")).toMatchObject({
      model: "deepseek-v4-pro",
      effort: "high",
    });
  });

  it("keeps runtime-selected model and effort when configured metadata is seeded again", () => {
    initSessionState("main", "conv-1", {
      model: "configured-model",
      effort: "low",
    });
    updateSessionState("main", "conv-1", {
      model: "runtime-model",
      effort: "high",
    });

    initSessionState("main", "conv-1", {
      model: "configured-model",
      effort: "low",
    });

    expect(getSessionState("main", "conv-1")).toMatchObject({
      model: "runtime-model",
      effort: "high",
    });
  });

  it("treats blank initial metadata as absent", () => {
    initSessionState("main", "conv-1", {
      model: "runtime-model",
      effort: "high",
    });

    initSessionState("main", "conv-1", {
      model: "",
      effort: "   ",
    });

    expect(getSessionState("main", "conv-1")).toMatchObject({
      model: "runtime-model",
      effort: "high",
    });
  });
});
