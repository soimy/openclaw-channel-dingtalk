export interface UsageAccumulation {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

const runMappings = new Map<string, { accountId: string; conversationId: string }>();
const usageStore = new Map<string, UsageAccumulation>();

function sessionKey(accountId: string, conversationId: string): string {
  return `${accountId}:${conversationId}`;
}

export function recordRunStart(runId: string, accountId: string, conversationId: string): void {
  runMappings.set(runId, { accountId, conversationId });
}

export function accumulateUsage(runId: string, usage: UsageAccumulation): void {
  const mapping = runMappings.get(runId);
  if (!mapping) { return; }

  const key = sessionKey(mapping.accountId, mapping.conversationId);
  const existing = usageStore.get(key) ?? {};
  const updated: UsageAccumulation = { ...existing };

  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    const value = usage[field];
    if (typeof value === "number") {
      updated[field] = (updated[field] ?? 0) + value;
    }
  }

  usageStore.set(key, updated);
}

export function getUsage(accountId: string, conversationId: string): UsageAccumulation | undefined {
  return usageStore.get(sessionKey(accountId, conversationId));
}

export function clearRun(runId: string): void {
  runMappings.delete(runId);
}

export function clearSessionUsage(accountId: string, conversationId: string): void {
  const key = sessionKey(accountId, conversationId);
  usageStore.delete(key);
  for (const [rid, mapping] of runMappings) {
    if (sessionKey(mapping.accountId, mapping.conversationId) === key) {
      runMappings.delete(rid);
    }
  }
}

export function clearAllForTest(): void {
  runMappings.clear();
  usageStore.clear();
}
