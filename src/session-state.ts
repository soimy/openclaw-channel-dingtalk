interface SessionState {
  model?: string;
  effort?: string;
  taskStartTime: number;
}

interface SessionStateScope {
  accountId: string;
  conversationId: string;
  agentId: string;
}

type SessionStateInitialMetadata = Partial<Pick<SessionState, "model" | "effort">>;

const sessionStore = new Map<string, SessionState>();

function sessionKey(scope: SessionStateScope): string {
  return `${scope.accountId}:${scope.agentId}:${scope.conversationId}`;
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
  scope: SessionStateScope,
  metadata?: SessionStateInitialMetadata,
): SessionState {
  const key = sessionKey(scope);
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

export function getSessionState(scope: SessionStateScope): SessionState | undefined {
  return sessionStore.get(sessionKey(scope));
}

export function updateSessionState(
  scope: SessionStateScope,
  patch: Partial<Pick<SessionState, "model" | "effort">>,
): void {
  const state = sessionStore.get(sessionKey(scope));
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

export function getTaskTimeSeconds(scope: SessionStateScope): number | undefined {
  const state = sessionStore.get(sessionKey(scope));
  if (!state) {
    return undefined;
  }
  return Math.round((Date.now() - state.taskStartTime) / 1000);
}

export function clearSessionState(scope: SessionStateScope): void {
  sessionStore.delete(sessionKey(scope));
}

export function clearAllSessionStatesForTest(): void {
  sessionStore.clear();
}
