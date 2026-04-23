interface SessionState {
  model?: string;
  effort?: string;
  taskStartTime: number;
}

const sessionStore = new Map<string, SessionState>();

function sessionKey(accountId: string, conversationId: string): string {
  return `${accountId}:${conversationId}`;
}

export function initSessionState(accountId: string, conversationId: string): SessionState {
  const key = sessionKey(accountId, conversationId);
  const existing = sessionStore.get(key);
  if (existing) {
    existing.taskStartTime = Date.now();
    return existing;
  }
  const state: SessionState = {
    taskStartTime: Date.now(),
  };
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
