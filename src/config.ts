import * as os from "node:os";
import * as path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { DingTalkConfig } from "./types";

/**
 * Resolve DingTalk config for an account.
 * Falls back to top-level config for single-account setups.
 */
export function getConfig(cfg: OpenClawConfig, accountId?: string): DingTalkConfig {
  const dingtalkCfg = cfg?.channels?.dingtalk as DingTalkConfig | undefined;
  if (!dingtalkCfg) {
    return {} as DingTalkConfig;
  }

  if (accountId && dingtalkCfg.accounts?.[accountId]) {
    return dingtalkCfg.accounts[accountId];
  }

  return dingtalkCfg;
}

export function isConfigured(cfg: OpenClawConfig, accountId?: string): boolean {
  const config = getConfig(cfg, accountId);
  return Boolean(config.clientId && config.clientSecret);
}

export function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

export function resolveGroupConfig(
  cfg: DingTalkConfig,
  groupId: string,
): { systemPrompt?: string } | undefined {
  // Group config supports exact match first, then wildcard fallback.
  const groups = cfg.groups;
  if (!groups) {
    return undefined;
  }
  return groups[groupId] || groups["*"] || undefined;
}

/**
 * Strip group/user prefixes used by CLI targeting.
 * Returns raw DingTalk target ID and whether caller explicitly requested a user target.
 */
export function stripTargetPrefix(target: string): { targetId: string; isExplicitUser: boolean } {
  if (target.startsWith("group:")) {
    return { targetId: target.slice(6), isExplicitUser: false };
  }
  if (target.startsWith("user:")) {
    return { targetId: target.slice(5), isExplicitUser: true };
  }
  return { targetId: target, isExplicitUser: false };
}
