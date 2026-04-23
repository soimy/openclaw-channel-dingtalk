import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  clearAllSessionStatesForTest,
  getTaskTimeSeconds,
  initSessionState,
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
});
