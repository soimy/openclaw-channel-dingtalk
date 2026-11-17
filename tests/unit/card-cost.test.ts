import { beforeEach, describe, expect, it } from "vitest";
import {
  accumulateUsage,
  clearAllForTest,
  clearRuns,
  getAggregatedUsage,
  recordRunStart,
} from "../../src/card/run-usage-store";
import { renderStatusLine } from "../../src/card/statusline-renderer";
import { resolveCallCost } from "../../src/card/usage-cost";

const config = {
  models: {
    providers: {
      example: {
        models: [{ id: "model", cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } }],
      },
    },
  },
};
beforeEach(clearAllForTest);
describe("card cost", () => {
  it("prices input, output and cache separately", () => {
    expect(
      resolveCallCost(
        { provider: "example", model: "model", usage: { input: 3, output: 185, cacheRead: 40400 } },
        config,
      )?.total,
    ).toBeCloseTo(0.005896);
  });
  it("preserves a reported zero instead of replacing it with an estimate", () => {
    expect(resolveCallCost({ usage: { input: 1000, cost: { total: 0 } } }, config)).toEqual({
      total: 0,
    });
  });
  it("does not fabricate prices or price total-only usage", () => {
    expect(
      resolveCallCost(
        { provider: "other", model: "model", usage: { input: 100, output: 20 } },
        config,
      ),
    ).toBeUndefined();
    expect(
      resolveCallCost({ provider: "example", model: "model", usage: { total: 100 } }, config),
    ).toBeUndefined();
  });
  it.each([NaN, Infinity, -1])("rejects invalid token counts: %s", (input) => {
    expect(
      resolveCallCost({ provider: "example", model: "model", usage: { input, output: 1 } }, config),
    ).toBeUndefined();
  });
  it("sums call costs across runs, without using the last selected model price", () => {
    recordRunStart("a");
    recordRunStart("b");
    accumulateUsage("a", { cost: { total: 0.01 } });
    accumulateUsage("a", { cost: { total: 0.02 } });
    accumulateUsage("b", { cost: { total: 0.04 } });
    expect(getAggregatedUsage(new Set(["a", "b"])).cost?.total).toBeCloseTo(0.07);
  });
  it("does not present partial costs as a complete total", () => {
    recordRunStart("a");
    accumulateUsage("a", { cost: { total: 0.01 } });
    accumulateUsage("a", { input: 100 });
    accumulateUsage("a", { cost: { total: 0.02 } });
    expect(getAggregatedUsage(new Set(["a"])).cost).toBeUndefined();
  });
  it("clears missing-cost tracking when a run is cleared", () => {
    recordRunStart("a");
    accumulateUsage("a", { input: 1 });
    clearRuns(new Set(["a"]));
    recordRunStart("a");
    accumulateUsage("a", { cost: { total: 0 } });
    expect(getAggregatedUsage(new Set(["a"])).cost?.total).toBe(0);
  });
  it("requires opt-in, hides unknown amounts, and renders zero", () => {
    expect(renderStatusLine({ costUsd: 0.005896 }, {})).toBe("");
    expect(renderStatusLine({}, { cardStatusLine: { cost: true } })).toBe("");
    expect(renderStatusLine({ costUsd: 0.005896 }, { cardStatusLine: { cost: true } })).toBe(
      "~$0.0059",
    );
    expect(renderStatusLine({ costUsd: 0 }, { cardStatusLine: { cost: true } })).toBe("~$0.0000");
  });
});
