interface SessionState {
  model?: string;
  effort?: string;
  taskStartTime: number;
}

type SessionStateInitialMetadata = Partial<Pick<SessionState, "model" | "effort">>;

const sessionStore = new Map<string, SessionState>();

function sessionKey(accountId: string, conversationId: string): string {
  return `${accountId}:${conversationId}`;
}

function normalizeMetadataValue(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function seedMissingSessionStateMetadata(
  state: SessionState,
  metadata?: SessionStateInitialMetadata,
): void {
  const model = normalizeMetadataValue(metadata?.model);
  const effort = normalizeMetadataValue(metadata?.effort);
  if (state.model === undefined && model !== undefined) {
    state.model = model;
  }
  if (state.effort === undefined && effort !== undefined) {
    state.effort = effort;
  }
}

export function initSessionState(
  accountId: string,
  conversationId: string,
  metadata?: SessionStateInitialMetadata,
): SessionState {
  const key = sessionKey(accountId, conversationId);
  const existing = sessionStore.get(key);
  if (existing) {
    existing.taskStartTime = Date.now();
    seedMissingSessionStateMetadata(existing, metadata);
    return existing;
  }
  const state: SessionState = {
    taskStartTime: Date.now(),
  };
  seedMissingSessionStateMetadata(state, metadata);
  sessionStore.set(key, state);
  return state;
}

export function getSessionState(accountId: string, conversationId: string): SessionState | undefined {
  return sessionStore.get(sessionKey(accountId, conversationId));
}

export function updateSessionState(
  accountId: string,
  conversationId: string,
  patch: Partial<Pick<SessionState, "model" | "effort">>,
): void {
  const state = sessionStore.get(sessionKey(accountId, conversationId));
  if (!state) {
    return;
  }
  if (patch.model !== undefined) {
    state.model = patch.model;
  }
  if (patch.effort !== undefined) {
    state.effort = patch.effort;
  }
}

export function getTaskTimeSeconds(accountId: string, conversationId: string): number | undefined {
  const state = sessionStore.get(sessionKey(accountId, conversationId));
  if (!state) {
    return undefined;
  }
  return Math.round((Date.now() - state.taskStartTime) / 1000);
}

export function clearSessionState(accountId: string, conversationId: string): void {
  sessionStore.delete(sessionKey(accountId, conversationId));
}

export function clearAllSessionStatesForTest(): void {
  sessionStore.clear();
}
