import * as os from "node:os";
import * as path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { DingTalkConfig } from "./types";

/**
 * Merge channel-level defaults into an account-specific config.
 * Account-level values take precedence; `accounts` key is excluded to avoid recursion.
 */
export function mergeAccountWithDefaults(
  channelCfg: DingTalkConfig,
  accountCfg: DingTalkConfig,
): DingTalkConfig {
  const { accounts: _accounts, ...defaults } = channelCfg;
  const overrides: Partial<DingTalkConfig> = {};
  for (const [key, value] of Object.entries(accountCfg)) {
    if (value !== undefined) {
      Object.assign(overrides, { [key]: value });
    }
  }
  return {
    ...defaults,
    ...overrides,
  };
}

/**
 * Resolve DingTalk config for an account.
 * Named accounts inherit channel-level defaults with account-level overrides.
 * Falls back to top-level config for single-account setups.
 */
export function getConfig(cfg: OpenClawConfig, accountId?: string): DingTalkConfig {
  const dingtalkCfg = cfg?.channels?.dingtalk as DingTalkConfig | undefined;
  if (!dingtalkCfg) {
    return {} as DingTalkConfig;
  }

  if (accountId && dingtalkCfg.accounts?.[accountId]) {
    return mergeAccountWithDefaults(dingtalkCfg, dingtalkCfg.accounts[accountId]);
  }

  return dingtalkCfg;
}

export function isConfigured(cfg: OpenClawConfig, accountId?: string): boolean {
  const config = getConfig(cfg, accountId);
  return Boolean(config.clientId && config.clientSecret);
}

export function resolveRelativePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }

  const segments = (value: string): string[] => value.split(/[\\/]+/).filter(Boolean);
  const isWindowsDriveAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmed);

  // Expand bare "~" and "~/" or "~\\" prefixes into the user home directory.
  if (trimmed === "~") {
    return path.resolve(os.homedir());
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), ...segments(trimmed.slice(2)));
  }

  // Keep Windows drive-absolute input stable across platforms.
  if (isWindowsDriveAbsolute) {
    return path.win32.normalize(trimmed);
  }

  // OpenClaw on Windows may pass root-absolute workspace paths without the
  // leading "\" (for example: Users\name\.openclaw\workspace\file.png).
  if (
    process.platform === "win32" &&
    /^Users[\\/]/i.test(trimmed) &&
    /[\\/]\.openclaw(?:[\\/]|$)/i.test(trimmed)
  ) {
    const driveRoot = path.parse(process.cwd()).root;
    return path.win32.resolve(driveRoot, trimmed);
  }

  // Treat both "/" and "\\" as absolute root prefixes for cross-platform input.
  if (/^[\\/]/.test(trimmed)) {
    return path.resolve(path.sep, ...segments(trimmed));
  }

  // Resolve relative path against cwd; supports mixed separators and "..\\..".
  return path.resolve(process.cwd(), ...segments(trimmed));
}

export const resolveUserPath = resolveRelativePath;

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
