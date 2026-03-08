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

/**
 * Resolve relative paths against a base directory, with intelligent platform-specific handling.
 *
 * Supports:
 * - ~ and ~/ expansion to home directory
 * - Absolute paths (Unix: /path, Windows: \path or C:\path)
 * - Relative paths resolved against cwd
 * - Windows absolute paths without drive letters (e.g., Users\name\.openclaw\file.txt)
 * - Mixed path separators (/ and \)
 *
 * @param input - The path string to resolve
 * @returns The resolved absolute path
 */
export function resolveRelativePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }

  const segments = (value: string): string[] => value.split(/[\\/]+/).filter(Boolean);

  // Expand bare "~" and "~/" or "~\\" prefixes into the user home directory.
  if (trimmed === "~") {
    return path.resolve(os.homedir());
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), ...segments(trimmed.slice(2)));
  }

  // Check for Windows absolute paths with drive letters (e.g., "C:\path" or "C:/path")
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return path.resolve(trimmed);
  }

  // Get path segments for further analysis
  const pathSegments = segments(trimmed);
  const firstSegment = pathSegments[0];

  /**
   * Windows platform compatibility fix:
   * Detect Windows absolute paths that are missing the leading backslash
   * and/or drive letter. OpenClaw sometimes strips leading backslashes from
   * Windows paths, causing patterns like "Users\username\.openclaw\workspace\file.xlsx"
   * to be treated as relative paths.
   *
   * Pattern detection:
   * - First segment starts with a letter (directory name like "Users")
   * - Path has multiple segments (> 2)
   * - Second segment contains a dot (like ".openclaw", ".config")
   *
   * This pattern reliably indicates an absolute Windows path from root.
   */
  if (firstSegment && /^[a-zA-Z]/.test(firstSegment) && pathSegments.length > 2) {
    const secondSegment = pathSegments[1];
    if (secondSegment && secondSegment.includes('.')) {
      // Reconstruct as absolute path from root
      return path.resolve(path.sep, ...pathSegments);
    }
  }

  /**
   * Handle edge case: Windows paths with drive letter but no separator
   * e.g., "C:Users\..." (missing backslash after drive letter)
   */
  if (firstSegment && /^[a-zA-Z]:$/.test(firstSegment)) {
    return path.resolve(firstSegment + path.sep, ...pathSegments.slice(1));
  }

  // Treat both "/" and "\\" as absolute root prefixes for cross-platform input.
  if (/^[\\/]/.test(trimmed)) {
    return path.resolve(path.sep, ...pathSegments);
  }

  // Resolve relative path against cwd; supports mixed separators and "..\\..".
  return path.resolve(process.cwd(), ...pathSegments);
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
