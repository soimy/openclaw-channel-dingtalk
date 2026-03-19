import type { ChannelDirectoryEntry, OpenClawConfig } from "openclaw/plugin-sdk";
import { getConfig, stripTargetPrefix } from "../config";
import { resolveOriginalPeerId } from "../peer-id-registry";
import { getDingTalkRuntime } from "../runtime";
import { listKnownGroupTargets, listKnownUserTargets } from "./target-directory-store";

export type DirectoryListParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
  runtime?: unknown;
};

type RuntimeSessionResolver = {
  resolveStorePath?: (store: unknown, options: { agentId?: string | null | undefined }) => string;
};

function normalizeDirectoryAccountId(accountId?: string | null): string {
  const resolved = String(accountId || "default").trim();
  return resolved || "default";
}

function normalizeDirectoryLimit(limit?: number | null): number | undefined {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return undefined;
  }
  return Math.floor(limit);
}

function resolveDirectoryStorePath(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  runtime?: unknown;
}): string | undefined {
  const normalizedAccountId = normalizeDirectoryAccountId(params.accountId);
  const runtimeSession = (
    params.runtime as { channel?: { session?: RuntimeSessionResolver } } | undefined
  )?.channel?.session;
  if (runtimeSession?.resolveStorePath) {
    return runtimeSession.resolveStorePath(params.cfg.session?.store, {
      agentId: normalizedAccountId,
    });
  }
  try {
    const rt = getDingTalkRuntime();
    return rt.channel.session.resolveStorePath(params.cfg.session?.store, {
      agentId: normalizedAccountId,
    });
  } catch {
    return undefined;
  }
}

function shouldFilterDirectoryByQuery(params: DirectoryListParams): boolean {
  // OpenClaw target-resolver currently uses a query-insensitive cache key and
  // always calls directory list APIs with limit=undefined. If we filter by
  // query at this layer during resolver calls, one miss can poison cache for
  // later different queries. Keep resolver reads query-agnostic.
  return params.limit !== undefined;
}

function isDisplayNameResolutionEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const mode = getConfig(params.cfg, params.accountId ?? undefined).displayNameResolution;
  // Current upstream target resolution does not pass requester owner/authz context into
  // plugin targetResolver/directory callbacks, so owner-only resolution is not yet safe.
  // Keep the config explicit: only "all" enables learned displayName resolution for now.
  // TODO(upstream target-resolver): add a true owner-only mode once requester authorization
  // is plumbed into plugin resolver and directory entry points.
  return mode === "all";
}

export function listDingTalkDirectoryGroups(params: DirectoryListParams): ChannelDirectoryEntry[] {
  if (!isDisplayNameResolutionEnabled(params)) {
    return [];
  }
  const accountId = normalizeDirectoryAccountId(params.accountId);
  const storePath = resolveDirectoryStorePath(params);
  const filterByQuery = shouldFilterDirectoryByQuery(params);
  const groups = listKnownGroupTargets({
    storePath,
    accountId,
    query: filterByQuery ? (params.query ?? undefined) : undefined,
    limit: filterByQuery ? normalizeDirectoryLimit(params.limit) : undefined,
  });
  const groupEntries: ChannelDirectoryEntry[] = groups.map((entry) => ({
    kind: "group" as const,
    id: resolveOriginalPeerId(entry.conversationId),
    name: entry.currentTitle,
    handle: entry.conversationId,
    rank: entry.lastSeenAt,
    raw: entry,
  }));

  if (filterByQuery) {
    return groupEntries;
  }

  // TODO(upstream target-resolver): remove this fallback once bare user labels
  // can be classified and routed to listPeers() instead of only listGroups().
  // Temporary hack for the current upstream target-resolver flow: bare names
  // are classified as "group" before directory lookup, so user displayName
  // targets never reach listPeers(). Merge users into the resolver-only group
  // lookup set so "displayName -> targetId" can still resolve for DingTalk.
  const users = listKnownUserTargets({
    storePath,
    accountId,
  });
  const userEntries: ChannelDirectoryEntry[] = users.map((entry) => ({
    kind: "user" as const,
    id: entry.canonicalUserId,
    name: entry.currentDisplayName,
    handle: entry.staffId || entry.senderId,
    rank: entry.lastSeenAt,
    raw: entry,
  }));

  return [...groupEntries, ...userEntries].toSorted(
    (left, right) => (right.rank || 0) - (left.rank || 0),
  );
}

export function listDingTalkDirectoryUsers(params: DirectoryListParams): ChannelDirectoryEntry[] {
  if (!isDisplayNameResolutionEnabled(params)) {
    return [];
  }
  const accountId = normalizeDirectoryAccountId(params.accountId);
  const storePath = resolveDirectoryStorePath(params);
  const filterByQuery = shouldFilterDirectoryByQuery(params);
  const users = listKnownUserTargets({
    storePath,
    accountId,
    query: filterByQuery ? (params.query ?? undefined) : undefined,
    limit: filterByQuery ? normalizeDirectoryLimit(params.limit) : undefined,
  });
  return users.map((entry) => ({
    kind: "user",
    id: entry.canonicalUserId,
    name: entry.currentDisplayName,
    handle: entry.staffId || entry.senderId,
    rank: entry.lastSeenAt,
    raw: entry,
  }));
}

export function normalizeResolvedDingTalkTarget(raw: string): string {
  return resolveOriginalPeerId(stripTargetPrefix(raw).targetId);
}
