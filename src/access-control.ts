export type NormalizedAllowFrom = {
  entries: string[];
  entriesLower: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
};

/**
 * Normalize allowFrom list:
 * - trim whitespace
 * - support "dingtalk:/dd:/ding:" prefixes
 * - precompute lower-case list for case-insensitive checks
 */
export function normalizeAllowFrom(list?: Array<string>): NormalizedAllowFrom {
  const entries = (list ?? []).map((value) => String(value).trim()).filter(Boolean);
  const hasWildcard = entries.includes("*");
  const normalized = entries
    .filter((value) => value !== "*")
    .map((value) => value.replace(/^(dingtalk|dd|ding):/i, ""));
  const normalizedLower = normalized.map((value) => value.toLowerCase());
  return {
    entries: normalized,
    entriesLower: normalizedLower,
    hasWildcard,
    hasEntries: entries.length > 0,
  };
}

export function isSenderAllowed(params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
}): boolean {
  const { allow, senderId } = params;
  if (!allow.hasEntries) {
    return true;
  }
  if (allow.hasWildcard) {
    return true;
  }
  if (senderId && allow.entriesLower.includes(senderId.toLowerCase())) {
    return true;
  }
  return false;
}

export function isSenderGroupAllowed(params: {
  allow: NormalizedAllowFrom;
  groupId?: string;
}): boolean {
  const { allow, groupId } = params;
  if (groupId && allow.entriesLower.includes(groupId.toLowerCase())) {
    return true;
  }
  return false;
}

export type GroupAccessResult = {
  allowed: boolean;
  reason?: "disabled" | "group_not_allowed" | "sender_not_allowed";
  legacyFallback?: boolean;
};

export type GroupAccessParams = {
  groupPolicy: "open" | "allowlist" | "disabled";
  groupId: string;
  senderId: string;
  groups?: Record<string, { groupAllowFrom?: string[] }>;
  groupAllowFrom?: string[];
  allowFrom?: string[]; // legacy fallback
};

export function resolveGroupAccess(params: GroupAccessParams): GroupAccessResult {
  const { groupPolicy, groupId, senderId, groups, groupAllowFrom, allowFrom } = params;

  // Step 1: disabled → block all
  if (groupPolicy === "disabled") {
    return { allowed: false, reason: "disabled" };
  }

  // Step 2: allowlist → group ID check
  let legacyFallback = false;
  if (groupPolicy === "allowlist") {
    const groupConfig = groups?.[groupId];
    const wildcardConfig = groups?.["*"];
    const groupInConfig = groupConfig !== undefined || wildcardConfig !== undefined;

    if (!groupInConfig) {
      // Legacy fallback: check allowFrom for group ID
      const legacyAllow = normalizeAllowFrom(allowFrom);
      if (isSenderGroupAllowed({ allow: legacyAllow, groupId })) {
        legacyFallback = true;
        // Continue to sender check below
      } else {
        return { allowed: false, reason: "group_not_allowed" };
      }
    }
  }

  // Step 3: Sender check
  // Priority: per-group > wildcard > top-level
  const perGroupAllowFrom = groups?.[groupId]?.groupAllowFrom;
  const wildcardAllowFrom = groups?.["*"]?.groupAllowFrom;
  const effectiveAllowFrom = perGroupAllowFrom ?? wildcardAllowFrom ?? groupAllowFrom;

  if (effectiveAllowFrom == null) {
    return { allowed: true, legacyFallback: legacyFallback || undefined };
  }

  // Empty array = block all senders (fail-closed per official design)
  if (effectiveAllowFrom.length === 0) {
    return { allowed: false, reason: "sender_not_allowed" };
  }

  const normalized = normalizeAllowFrom(effectiveAllowFrom);
  if (isSenderAllowed({ allow: normalized, senderId })) {
    return { allowed: true, legacyFallback: legacyFallback || undefined };
  }

  return { allowed: false, reason: "sender_not_allowed" };
}

export function isSenderOwner(params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
  rawSenderId?: string;
}): boolean {
  const { allow, senderId, rawSenderId } = params;
  if (!allow.hasEntries) {
    return false;
  }
  if (senderId && allow.entriesLower.includes(senderId.toLowerCase())) {
    return true;
  }
  if (rawSenderId && allow.entriesLower.includes(rawSenderId.toLowerCase())) {
    return true;
  }
  return false;
}
