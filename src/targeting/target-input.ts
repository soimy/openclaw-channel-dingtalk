import { stripTargetPrefix } from "../config";

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(dingtalk|dd|ding)\s*:\s*/i, "");
}

function parseDingTalkTargetInput(raw: string): {
  targetId: string;
  explicitUser: boolean;
  explicitGroup: boolean;
} {
  const providerStripped = stripProviderPrefix(raw.trim()).trim();
  const explicitGroup = providerStripped.startsWith("group:");
  const { targetId, isExplicitUser } = stripTargetPrefix(providerStripped);
  return {
    targetId: targetId.trim(),
    explicitUser: isExplicitUser,
    explicitGroup,
  };
}

export function normalizeDingTalkTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const providerStripped = stripProviderPrefix(trimmed).trim();
  const { targetId } = stripTargetPrefix(providerStripped);
  const normalized = targetId.trim();
  return normalized || undefined;
}

export function looksLikeDingTalkTargetId(raw: string, normalized?: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const parsed = parseDingTalkTargetInput(trimmed);
  if (parsed.explicitUser || parsed.explicitGroup) {
    return true;
  }
  const candidate = (normalized || parsed.targetId).trim();
  if (!candidate) {
    return false;
  }
  if (/^cid[\w+\-/=]*$/i.test(candidate)) {
    return true;
  }
  if (/^\+?\d{6,}$/.test(candidate)) {
    return true;
  }
  if (/^[a-z0-9]{16,}$/i.test(candidate)) {
    return true;
  }
  if (/^[A-Za-z0-9+/=]{16,}$/.test(candidate) && /[+/=]/.test(candidate)) {
    return true;
  }
  if (/^[A-Za-z0-9_-]{24,}$/.test(candidate) && /\d/.test(candidate)) {
    return true;
  }
  return false;
}
