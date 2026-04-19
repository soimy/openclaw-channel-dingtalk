import { describe, it, expect, beforeEach } from "vitest";
import {
  recordRunStart,
  accumulateUsage,
  getUsageByRunId,
  clearRun,
  clearAllForTest,
} from "../../src/run-usage-store";

beforeEach(() => {
  clearAllForTest();
});

describe("recordRunStart + accumulateUsage", () => {
  it("initializes and accumulates usage by runId", () => {
    recordRunStart("run-1");
    accumulateUsage("run-1", { input: 100, output: 50, total: 150 });

    expect(getUsageByRunId("run-1")).toEqual({ input: 100, output: 50, total: 150 });
  });

  it("accumulates across multiple LLM calls for same runId", () => {
    recordRunStart("run-1");
    accumulateUsage("run-1", { input: 100, output: 50 });
    accumulateUsage("run-1", { input: 200, output: 80, total: 280 });

    expect(getUsageByRunId("run-1")).toEqual({ input: 300, output: 130, total: 280 });
  });

  it("returns undefined for unknown runId", () => {
    accumulateUsage("unknown-run", { input: 100 });

    expect(getUsageByRunId("unknown-run")).toBeUndefined();
  });

  it("handles partial usage objects with only input field", () => {
    recordRunStart("run-1");
    accumulateUsage("run-1", { input: 42 });

    expect(getUsageByRunId("run-1")).toEqual({ input: 42 });
  });

  it("handles cacheRead and cacheWrite", () => {
    recordRunStart("run-1");
    accumulateUsage("run-1", { cacheRead: 1000, cacheWrite: 500 });

    expect(getUsageByRunId("run-1")).toEqual({ cacheRead: 1000, cacheWrite: 500 });
  });

  it("ignores non-number fields", () => {
    recordRunStart("run-1");
    accumulateUsage("run-1", { input: 10, output: "not-a-number" as unknown as number });

    expect(getUsageByRunId("run-1")).toEqual({ input: 10 });
  });

  it("keeps parallel runIds isolated", () => {
    recordRunStart("run-a");
    recordRunStart("run-b");
    accumulateUsage("run-a", { input: 100 });
    accumulateUsage("run-b", { input: 200, output: 50 });

    expect(getUsageByRunId("run-a")).toEqual({ input: 100 });
    expect(getUsageByRunId("run-b")).toEqual({ input: 200, output: 50 });
  });
});

describe("getUsageByRunId", () => {
  it("returns undefined when no usage recorded", () => {
    expect(getUsageByRunId("run-x")).toBeUndefined();
  });
});

describe("clearRun", () => {
  it("removes usage for a specific runId", () => {
    recordRunStart("run-1");
    accumulateUsage("run-1", { input: 100, total: 100 });

    clearRun("run-1");

    expect(getUsageByRunId("run-1")).toBeUndefined();
  });

  it("does not affect other runIds", () => {
    recordRunStart("run-a");
    recordRunStart("run-b");
    accumulateUsage("run-a", { input: 100 });
    accumulateUsage("run-b", { input: 200 });

    clearRun("run-a");

    expect(getUsageByRunId("run-a")).toBeUndefined();
    expect(getUsageByRunId("run-b")).toEqual({ input: 200 });
  });

  it("handles undefined gracefully", () => {
    clearRun(undefined);
    // No crash
  });
});
