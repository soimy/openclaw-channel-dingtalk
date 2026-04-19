export interface UsageAccumulation {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

const usageStore = new Map<string, UsageAccumulation>();

export function recordRunStart(runId: string): void {
  if (!usageStore.has(runId)) {
    usageStore.set(runId, {});
  }
}

export function accumulateUsage(runId: string, usage: UsageAccumulation): void {
  const existing = usageStore.get(runId);
  if (!existing) { return; }

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

export function clearRun(runId: string | undefined): void {
  if (runId) { usageStore.delete(runId); }
}

export function clearAllForTest(): void {
  usageStore.clear();
}
