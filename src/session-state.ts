/**
 * Session state management for AI Card v2.
 *
 * Stores runtime state (model, effort, task timing, API count) in memory.
 * Key format: accountId:conversationId
 */

import type { Logger } from "./types";

export interface SessionState {
  model?: string;
  effort?: string;
  taskStartTime: number;
  dapiCount: number;
}

const sessionStates = new Map<string, SessionState>();

function getSessionKey(accountId: string, conversationId: string): string {
  return `${accountId}:${conversationId}`;
}

export function initSessionState(
  accountId: string,
  conversationId: string,
  log?: Logger,
): SessionState {
  const key = getSessionKey(accountId, conversationId);
  const existing = sessionStates.get(key);
  if (existing) {
    log?.debug?.(`[SessionState] Reusing existing session state for ${key}`);
    return existing;
  }
  const state: SessionState = {
    taskStartTime: Date.now(),
    dapiCount: 0,
  };
  sessionStates.set(key, state);
  log?.debug?.(`[SessionState] Initialized new session state for ${key}`);
  return state;
}

export function getSessionState(
  accountId: string,
  conversationId: string,
): SessionState | undefined {
  return sessionStates.get(getSessionKey(accountId, conversationId));
}

export function updateSessionState(
  accountId: string,
  conversationId: string,
  updates: Partial<Pick<SessionState, "model" | "effort">>,
  log?: Logger,
): void {
  const key = getSessionKey(accountId, conversationId);
  const state = sessionStates.get(key);
  if (!state) {
    log?.debug?.(`[SessionState] Cannot update: no state for ${key}`);
    return;
  }
  if (updates.model !== undefined) {
    state.model = updates.model;
    log?.debug?.(`[SessionState] Updated model to "${updates.model}" for ${key}`);
  }
  if (updates.effort !== undefined) {
    state.effort = updates.effort;
    log?.debug?.(`[SessionState] Updated effort to "${updates.effort}" for ${key}`);
  }
}

export function incrementDapiCount(
  accountId: string,
  conversationId: string,
  log?: Logger,
): number {
  const key = getSessionKey(accountId, conversationId);
  const state = sessionStates.get(key);
  if (!state) {
    log?.debug?.(`[SessionState] Cannot increment dapi: no state for ${key}`);
    return 0;
  }
  state.dapiCount += 1;
  log?.debug?.(`[SessionState] Incremented dapiCount to ${state.dapiCount} for ${key}`);
  return state.dapiCount;
}

export function getTaskTimeSeconds(
  accountId: string,
  conversationId: string,
): number | undefined {
  const state = sessionStates.get(getSessionKey(accountId, conversationId));
  if (!state) {
    return undefined;
  }
  return Math.round((Date.now() - state.taskStartTime) / 1000);
}

export function clearSessionState(accountId: string, conversationId: string): void {
  sessionStates.delete(getSessionKey(accountId, conversationId));
}

export function clearAllSessionStatesForTest(): void {
  sessionStates.clear();
}