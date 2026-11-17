export interface UsageAccumulation {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  /** USD total, only present when every observed call has a known cost. */
  cost?: { total: number };
}

const incompleteCosts = new Set<string>();

const usageStore = new Map<string, UsageAccumulation>();

export function recordRunStart(runId: string): void {
  if (!usageStore.has(runId)) {
    usageStore.set(runId, {});
  }
}

export function accumulateUsage(runId: string, usage: UsageAccumulation): void {
  const existing = usageStore.get(runId);
  if (!existing) {
    return;
  }

  const amount = usage.cost?.total;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    incompleteCosts.add(runId);
    delete existing.cost;
  } else if (!incompleteCosts.has(runId)) {
    existing.cost = { total: (existing.cost?.total ?? 0) + amount };
  }

  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    const value = usage[field];
    if (typeof value === "number") {
      existing[field] = (existing[field] ?? 0) + value;
    }
  }
}

export function getUsageByRunId(runId: string): UsageAccumulation | undefined {
  return usageStore.get(runId);
}

export function getAggregatedUsage(runIds: Set<string> | undefined): UsageAccumulation {
  const result: UsageAccumulation = {};
  if (!runIds) {
    return result;
  }
  let costIncomplete = false;
  for (const runId of runIds) {
    const usage = usageStore.get(runId);
    if (!usage) {
      costIncomplete = true;
      continue;
    }
    if (usage.cost) {
      result.cost = { total: (result.cost?.total ?? 0) + usage.cost.total };
    } else {
      costIncomplete = true;
    }
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      if (typeof usage[field] === "number") {
        result[field] = (result[field] ?? 0) + usage[field];
      }
    }
  }
  if (costIncomplete) {
    delete result.cost;
  }
  return result;
}

export function clearRun(runId: string | undefined): void {
  if (runId) {
    usageStore.delete(runId);
    incompleteCosts.delete(runId);
  }
}

export function clearRuns(runIds: Set<string> | undefined): void {
  if (!runIds) {
    return;
  }
  for (const runId of runIds) {
    usageStore.delete(runId);
    incompleteCosts.delete(runId);
  }
}

export function clearAllForTest(): void {
  usageStore.clear();
  incompleteCosts.clear();
}
