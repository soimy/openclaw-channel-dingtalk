import { describe, it, expect, beforeEach } from "vitest";
import {
  clearAllSessionStatesForTest,
  clearSessionState,
  getSessionState,
  getTaskTimeSeconds,
  incrementDapiCount,
  initSessionState,
  updateSessionState,
} from "../../src/session-state";

describe("session-state", () => {
  beforeEach(() => {
    clearAllSessionStatesForTest();
  });

  describe("initSessionState", () => {
    it("creates new session state with defaults", () => {
      const state = initSessionState("account1", "conv1");
      expect(state.taskStartTime).toBeGreaterThan(0);
      expect(state.dapiCount).toBe(0);
      expect(state.model).toBeUndefined();
      expect(state.effort).toBeUndefined();
    });

    it("returns existing state if already initialized", () => {
      const state1 = initSessionState("account1", "conv1");
      state1.model = "gpt-4";
      const state2 = initSessionState("account1", "conv1");
      expect(state2.model).toBe("gpt-4");
      expect(state2).toBe(state1);
    });

    it("creates different states for different conversations", () => {
      const state1 = initSessionState("account1", "conv1");
      const state2 = initSessionState("account1", "conv2");
      expect(state1).not.toBe(state2);
    });
  });

  describe("updateSessionState", () => {
    it("updates model", () => {
      initSessionState("account1", "conv1");
      updateSessionState("account1", "conv1", { model: "claude-3" });
      const state = getSessionState("account1", "conv1");
      expect(state?.model).toBe("claude-3");
    });

    it("updates effort", () => {
      initSessionState("account1", "conv1");
      updateSessionState("account1", "conv1", { effort: "high" });
      const state = getSessionState("account1", "conv1");
      expect(state?.effort).toBe("high");
    });

    it("does nothing if state does not exist", () => {
      updateSessionState("account1", "conv1", { model: "gpt-4" });
      const state = getSessionState("account1", "conv1");
      expect(state).toBeUndefined();
    });
  });

  describe("incrementDapiCount", () => {
    it("increments count and returns new value", () => {
      initSessionState("account1", "conv1");
      const count1 = incrementDapiCount("account1", "conv1");
      const count2 = incrementDapiCount("account1", "conv1");
      expect(count1).toBe(1);
      expect(count2).toBe(2);
      const state = getSessionState("account1", "conv1");
      expect(state?.dapiCount).toBe(2);
    });

    it("returns 0 if state does not exist", () => {
      const count = incrementDapiCount("account1", "conv1");
      expect(count).toBe(0);
    });
  });

  describe("getTaskTimeSeconds", () => {
    it("returns undefined if state does not exist", () => {
      const time = getTaskTimeSeconds("account1", "conv1");
      expect(time).toBeUndefined();
    });

    it("returns elapsed time in seconds", async () => {
      initSessionState("account1", "conv1");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const time = getTaskTimeSeconds("account1", "conv1");
      expect(time).toBeGreaterThanOrEqual(0);
    });
  });

  describe("clearSessionState", () => {
    it("removes state from map", () => {
      initSessionState("account1", "conv1");
      clearSessionState("account1", "conv1");
      const state = getSessionState("account1", "conv1");
      expect(state).toBeUndefined();
    });
  });
});