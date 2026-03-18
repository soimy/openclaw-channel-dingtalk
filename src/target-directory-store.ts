import { readNamespaceJson, writeNamespaceJsonAtomic } from "./persistence-store";

const TARGET_DIRECTORY_NAMESPACE = "targets.directory";
const MAX_HISTORICAL_NAMES = 20;
const MAX_RECENT_CONVERSATIONS = 20;

export interface GroupTargetEntry {
  conversationId: string;
  currentTitle: string;
  historicalTitles: string[];
  lastSeenAt: number;
}

export interface UserTargetEntry {
  canonicalUserId: string;
  staffId?: string;
  senderId: string;
  currentDisplayName: string;
  historicalDisplayNames: string[];
  lastSeenAt: number;
  lastSeenInConversationIds: string[];
}

interface TargetDirectoryState {
  version: 1;
  groups: Record<string, GroupTargetEntry>;
  users: Record<string, UserTargetEntry>;
}

const inMemoryFallbackState = new Map<string, TargetDirectoryState>();

function fallbackState(): TargetDirectoryState {
  return {
    version: 1,
    groups: {},
    users: {},
  };
}

function trimValue(value: string | undefined): string {
  return String(value || "").trim();
}

function normalizeLookup(value: string | undefined): string {
  return trimValue(value).replace(/\s+/g, " ").toLowerCase();
}

function normalizeScopeKey(storePath: string | undefined, accountId: string): string {
  return JSON.stringify([storePath || "__memory__", accountId]);
}

function readState(params: {
  storePath?: string;
  accountId: string;
}): TargetDirectoryState {
  if (!params.storePath) {
    return inMemoryFallbackState.get(normalizeScopeKey(undefined, params.accountId)) || fallbackState();
  }
  return readNamespaceJson<TargetDirectoryState>(TARGET_DIRECTORY_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId },
    fallback: fallbackState(),
  });
}

function writeState(params: {
  storePath?: string;
  accountId: string;
  state: TargetDirectoryState;
}): void {
  if (!params.storePath) {
    inMemoryFallbackState.set(normalizeScopeKey(undefined, params.accountId), params.state);
    return;
  }
  writeNamespaceJsonAtomic(TARGET_DIRECTORY_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId },
    data: params.state,
  });
}

function appendUniqueText(list: string[], value: string, maxSize: number): void {
  const normalized = normalizeLookup(value);
  if (!normalized) {
    return;
  }
  const existingIndex = list.findIndex((item) => normalizeLookup(item) === normalized);
  if (existingIndex >= 0) {
    return;
  }
  list.push(value.trim());
  if (list.length > maxSize) {
    list.splice(0, list.length - maxSize);
  }
}

function findUserKeyByIdentifiers(
  state: TargetDirectoryState,
  params: { canonicalUserId?: string; staffId?: string; senderId?: string },
): string | undefined {
  const canonical = normalizeLookup(params.canonicalUserId);
  if (canonical && state.users[params.canonicalUserId || ""]) {
    return params.canonicalUserId;
  }

  const staffNorm = normalizeLookup(params.staffId);
  const senderNorm = normalizeLookup(params.senderId);
  for (const [key, entry] of Object.entries(state.users)) {
    if (canonical && normalizeLookup(key) === canonical) {
      return key;
    }
    if (staffNorm && normalizeLookup(entry.staffId) === staffNorm) {
      return key;
    }
    if (senderNorm && normalizeLookup(entry.senderId) === senderNorm) {
      return key;
    }
  }
  return undefined;
}

export function upsertObservedGroupTarget(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
  title?: string;
  seenAt?: number;
}): void {
  const conversationId = trimValue(params.conversationId);
  if (!conversationId) {
    return;
  }
  const nowMs = params.seenAt && Number.isFinite(params.seenAt) ? params.seenAt : Date.now();
  const title = trimValue(params.title) || conversationId;
  const state = readState({ storePath: params.storePath, accountId: params.accountId });
  const entry = state.groups[conversationId] || {
    conversationId,
    currentTitle: title,
    historicalTitles: [],
    lastSeenAt: nowMs,
  };
  if (normalizeLookup(entry.currentTitle) !== normalizeLookup(title)) {
    appendUniqueText(entry.historicalTitles, entry.currentTitle, MAX_HISTORICAL_NAMES);
    entry.currentTitle = title;
  }
  entry.lastSeenAt = Math.max(entry.lastSeenAt || 0, nowMs);
  state.groups[conversationId] = entry;
  writeState({ storePath: params.storePath, accountId: params.accountId, state });
}

export function upsertObservedUserTarget(params: {
  storePath?: string;
  accountId: string;
  senderId: string;
  staffId?: string;
  displayName?: string;
  conversationId?: string;
  seenAt?: number;
}): void {
  const senderId = trimValue(params.senderId);
  if (!senderId) {
    return;
  }
  const staffId = trimValue(params.staffId);
  const canonicalUserId = staffId || senderId;
  const nowMs = params.seenAt && Number.isFinite(params.seenAt) ? params.seenAt : Date.now();
  const displayName = trimValue(params.displayName) || canonicalUserId;
  const conversationId = trimValue(params.conversationId);

  const state = readState({ storePath: params.storePath, accountId: params.accountId });
  const existingKey = findUserKeyByIdentifiers(state, {
    canonicalUserId,
    staffId,
    senderId,
  });
  const entry = existingKey
    ? state.users[existingKey]
    : {
      canonicalUserId,
      staffId: staffId || undefined,
      senderId,
      currentDisplayName: displayName,
      historicalDisplayNames: [],
      lastSeenAt: nowMs,
      lastSeenInConversationIds: [],
    };

  if (normalizeLookup(entry.currentDisplayName) !== normalizeLookup(displayName)) {
    appendUniqueText(entry.historicalDisplayNames, entry.currentDisplayName, MAX_HISTORICAL_NAMES);
    entry.currentDisplayName = displayName;
  }
  if (staffId) {
    entry.staffId = staffId;
  }
  entry.senderId = senderId;
  entry.canonicalUserId = canonicalUserId;
  entry.lastSeenAt = Math.max(entry.lastSeenAt || 0, nowMs);
  if (conversationId) {
    const exists = entry.lastSeenInConversationIds.some(
      (value) => normalizeLookup(value) === normalizeLookup(conversationId),
    );
    if (!exists) {
      entry.lastSeenInConversationIds.push(conversationId);
      if (entry.lastSeenInConversationIds.length > MAX_RECENT_CONVERSATIONS) {
        entry.lastSeenInConversationIds.splice(0, entry.lastSeenInConversationIds.length - MAX_RECENT_CONVERSATIONS);
      }
    }
  }

  if (existingKey && existingKey !== canonicalUserId) {
    delete state.users[existingKey];
  }
  state.users[canonicalUserId] = entry;
  writeState({ storePath: params.storePath, accountId: params.accountId, state });
}

function matchesGroupQuery(entry: GroupTargetEntry, query: string): boolean {
  const normalizedQuery = normalizeLookup(query);
  if (!normalizedQuery) {
    return true;
  }
  const candidates = [
    entry.conversationId,
    entry.currentTitle,
    ...entry.historicalTitles,
  ];
  return candidates.some((value) => normalizeLookup(value) === normalizedQuery);
}

function matchesUserQuery(entry: UserTargetEntry, query: string): boolean {
  const normalizedQuery = normalizeLookup(query);
  if (!normalizedQuery) {
    return true;
  }
  const candidates = [
    entry.canonicalUserId,
    entry.staffId || "",
    entry.senderId,
    entry.currentDisplayName,
    ...entry.historicalDisplayNames,
  ];
  return candidates.some((value) => normalizeLookup(value) === normalizedQuery);
}

export function listKnownGroupTargets(params: {
  storePath?: string;
  accountId: string;
  query?: string;
  limit?: number;
}): GroupTargetEntry[] {
  const state = readState({ storePath: params.storePath, accountId: params.accountId });
  const entries = Object.values(state.groups)
    .filter((entry) => matchesGroupQuery(entry, params.query || ""))
    .toSorted((a, b) => b.lastSeenAt - a.lastSeenAt);
  if (params.limit && params.limit > 0) {
    return entries.slice(0, params.limit);
  }
  return entries;
}

export function listKnownUserTargets(params: {
  storePath?: string;
  accountId: string;
  query?: string;
  limit?: number;
}): UserTargetEntry[] {
  const state = readState({ storePath: params.storePath, accountId: params.accountId });
  const entries = Object.values(state.users)
    .filter((entry) => matchesUserQuery(entry, params.query || ""))
    .toSorted((a, b) => b.lastSeenAt - a.lastSeenAt);
  if (params.limit && params.limit > 0) {
    return entries.slice(0, params.limit);
  }
  return entries;
}
