import { describe, it, expect, beforeEach } from "vitest";
import {
  recordRunStart,
  accumulateUsage,
  getUsage,
  clearRun,
  clearSessionUsage,
  clearAllForTest,
} from "../../src/run-usage-store";

beforeEach(() => {
  clearAllForTest();
});

describe("recordRunStart + accumulateUsage", () => {
  it("stores mapping and accumulates usage through it", () => {
    recordRunStart("run-1", "acc-1", "conv-1");
    accumulateUsage("run-1", { input: 100, output: 50, total: 150 });

    const usage = getUsage("acc-1", "conv-1");
    expect(usage).toEqual({ input: 100, output: 50, total: 150 });
  });

  it("accumulates across multiple LLM calls for same run", () => {
    recordRunStart("run-1", "acc-1", "conv-1");
    accumulateUsage("run-1", { input: 100, output: 50 });
    accumulateUsage("run-1", { input: 200, output: 80, total: 280 });

    const usage = getUsage("acc-1", "conv-1");
    expect(usage).toEqual({ input: 300, output: 130, total: 280 });
  });

  it("returns undefined for unknown runId", () => {
    accumulateUsage("unknown-run", { input: 100 });

    const usage = getUsage("acc-1", "conv-1");
    expect(usage).toBeUndefined();
  });

  it("handles partial usage objects with only input field", () => {
    recordRunStart("run-1", "acc-1", "conv-1");
    accumulateUsage("run-1", { input: 42 });

    const usage = getUsage("acc-1", "conv-1");
    expect(usage).toEqual({ input: 42 });
  });

  it("handles cacheRead and cacheWrite", () => {
    recordRunStart("run-1", "acc-1", "conv-1");
    accumulateUsage("run-1", { cacheRead: 1000, cacheWrite: 500 });

    const usage = getUsage("acc-1", "conv-1");
    expect(usage).toEqual({ cacheRead: 1000, cacheWrite: 500 });
  });

  it("ignores non-number fields", () => {
    recordRunStart("run-1", "acc-1", "conv-1");
    accumulateUsage("run-1", { input: 10, output: "not-a-number" as unknown as number });

    const usage = getUsage("acc-1", "conv-1");
    expect(usage).toEqual({ input: 10 });
  });
});

describe("getUsage", () => {
  it("returns undefined when no usage recorded", () => {
    expect(getUsage("acc-1", "conv-1")).toBeUndefined();
  });
});

describe("clearRun", () => {
  it("removes mapping but keeps accumulated usage", () => {
    recordRunStart("run-1", "acc-1", "conv-1");
    accumulateUsage("run-1", { input: 100, output: 50, total: 150 });

    clearRun("run-1");

    const usage = getUsage("acc-1", "conv-1");
    expect(usage).toEqual({ input: 100, output: 50, total: 150 });

    accumulateUsage("run-1", { input: 200 });
    expect(usage).toEqual({ input: 100, output: 50, total: 150 });
  });

  it("ignores calls for cleared runId", () => {
    recordRunStart("run-1", "acc-1", "conv-1");
    accumulateUsage("run-1", { input: 100 });
    clearRun("run-1");

    accumulateUsage("run-1", { input: 999 });
    const usage = getUsage("acc-1", "conv-1");
    expect(usage).toEqual({ input: 100 });
  });
});

describe("clearSessionUsage", () => {
  it("removes all usage data and run mappings for a session", () => {
    recordRunStart("run-1", "acc-1", "conv-1");
    recordRunStart("run-2", "acc-1", "conv-1");
    accumulateUsage("run-1", { input: 100 });
    accumulateUsage("run-2", { output: 50 });

    clearSessionUsage("acc-1", "conv-1");

    expect(getUsage("acc-1", "conv-1")).toBeUndefined();

    accumulateUsage("run-1", { input: 999 });
    expect(getUsage("acc-1", "conv-1")).toBeUndefined();

    accumulateUsage("run-2", { output: 999 });
    expect(getUsage("acc-1", "conv-1")).toBeUndefined();
  });

  it("does not affect other sessions", () => {
    recordRunStart("run-a", "acc-1", "conv-1");
    recordRunStart("run-b", "acc-1", "conv-2");
    accumulateUsage("run-a", { input: 100 });
    accumulateUsage("run-b", { output: 50 });

    clearSessionUsage("acc-1", "conv-1");

    expect(getUsage("acc-1", "conv-1")).toBeUndefined();
    expect(getUsage("acc-1", "conv-2")).toEqual({ output: 50 });
  });
});
