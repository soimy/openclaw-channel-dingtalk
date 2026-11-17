import type { UsageAccumulation } from "./run-usage-store";

type Rates = Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite", number>>;
type PricingConfig = {
  models?: { providers?: Record<string, { models?: Array<{ id: string; cost?: Rates }> }> };
};

/** Price each call before aggregation, preserving provider/model boundaries. */
export function resolveCallCost(
  event: { provider?: string; model?: string; usage?: UsageAccumulation },
  config: PricingConfig,
): { total: number } | undefined {
  const usage = event.usage;
  if (!usage) {
    return undefined;
  }
  const recorded = usage.cost?.total;
  if (typeof recorded === "number" && Number.isFinite(recorded) && recorded >= 0) {
    return { total: recorded };
  }
  if (!event.provider || !event.model) {
    return undefined;
  }
  const cost = config.models?.providers?.[event.provider]?.models?.find(
    (model) => model.id === event.model,
  )?.cost;
  // Do not flatten tier schedules or import private host pricing modules.
  if (!cost || "tieredPricing" in cost) {
    return undefined;
  }
  if (usage.input === undefined || usage.output === undefined) {
    return undefined;
  }
  let total = 0;
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const count = usage[field] ?? 0;
    if (!Number.isFinite(count) || count < 0) {
      return undefined;
    }
    if (count === 0) {
      continue;
    }
    const rate = cost[field];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
      return undefined;
    }
    total += (count * rate) / 1_000_000;
  }
  return Number.isFinite(total) ? { total } : undefined;
}
