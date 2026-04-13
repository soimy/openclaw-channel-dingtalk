import * as os from "node:os";
import * as path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
  resolveDingTalkSecretConfig,
} from "./secret-input";
import type { DingTalkChannelConfig, DingTalkConfig } from "./types";

const WINDOWS_ROOT_DIRECTORIES = new Set([
  "Users",
  "Program Files",
  "Program Files (x86)",
  "ProgramData",
  "Windows",
  "Documents and Settings",
]);
const DEFAULT_LEARNING_NOTE_TTL_MS = 6 * 60 * 60 * 1000;
export type RuntimeDingTalkConfig = Omit<DingTalkConfig, "clientSecret"> & { clientSecret: string };

function normalizeLearningConfig(
  config: DingTalkConfig,
  options: { applyDefaults: boolean },
): DingTalkConfig {
  return {
    ...config,
    learningEnabled: options.applyDefaults ? config.learningEnabled ?? false : config.learningEnabled,
    learningAutoApply: options.applyDefaults
      ? config.learningAutoApply ?? false
      : config.learningAutoApply,
    learningNoteTtlMs: options.applyDefaults
      ? config.learningNoteTtlMs ?? DEFAULT_LEARNING_NOTE_TTL_MS
      : config.learningNoteTtlMs,
    cardStreamingMode: options.applyDefaults
      ? (config.cardStreamingMode ?? (config.cardRealTimeStream === true ? "all" : "off"))
      : config.cardStreamingMode,
  };
}

function stripRemovedLegacyFields(config: DingTalkConfig): DingTalkConfig {
  const {
    verboseRealtimeStream: _verboseRealtimeStream,
    cardStreamReasoning: _cardStreamReasoning,
    accounts,
    ...rest
  } = config as DingTalkConfig & {
    verboseRealtimeStream?: unknown;
    cardStreamReasoning?: unknown;
    accounts?: Record<string, DingTalkConfig | undefined>;
  };
  const sanitizedAccounts = accounts
    ? Object.fromEntries(
        Object.entries(accounts).map(([accountId, accountConfig]) => [
          accountId,
          accountConfig ? stripRemovedLegacyFields(accountConfig) : accountConfig,
        ]),
      )
    : undefined;
  if (sanitizedAccounts) {
    return { ...rest, accounts: sanitizedAccounts } as DingTalkConfig;
  }
  return rest as DingTalkConfig;
}

/**
 * Merge channel-level defaults into an account-specific config.
 * Account-level values take precedence; `accounts` key is excluded to avoid recursion.
 */
export function mergeAccountWithDefaults(
  channelCfg: DingTalkConfig,
  accountCfg: DingTalkConfig,
): DingTalkConfig {
  const { accounts: _accounts, ...defaultCandidate } =
    channelCfg as DingTalkConfig & { accounts?: unknown; verboseRealtimeStream?: unknown };
  const defaults = stripRemovedLegacyFields(defaultCandidate as DingTalkConfig);
  const normalizedAccountCfg = stripRemovedLegacyFields(
    normalizeLearningConfig(accountCfg, { applyDefaults: false }),
  );
  const overrides: Partial<DingTalkConfig> = {};
  for (const [key, value] of Object.entries(normalizedAccountCfg)) {
    if (value !== undefined) {
      Object.assign(overrides, { [key]: value });
    }
  }
  return normalizeLearningConfig(
    {
      ...defaults,
      ...overrides,
    },
    { applyDefaults: true },
  );
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

  if (accountId) {
    return stripRemovedLegacyFields(normalizeLearningConfig(dingtalkCfg, { applyDefaults: true }));
  }

  if (dingtalkCfg.accounts && Object.keys(dingtalkCfg.accounts).length > 0) {
    return stripRemovedLegacyFields(dingtalkCfg);
  }

  return stripRemovedLegacyFields(normalizeLearningConfig(dingtalkCfg, { applyDefaults: true }));
}

export function isConfigured(cfg: OpenClawConfig, accountId?: string): boolean {
  const config = getConfig(cfg, accountId);
  return Boolean(config.clientId && hasConfiguredSecretInput(config.clientSecret));
}

export function resolveRuntimeConfig(config: DingTalkConfig): RuntimeDingTalkConfig {
  return resolveDingTalkSecretConfig(config) as RuntimeDingTalkConfig;
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
  const pathSegments = segments(trimmed);
  const firstSegment = pathSegments[0];

  // Expand bare "~" and "~/" or "~\\" prefixes into the user home directory.
  if (trimmed === "~") {
    return path.resolve(os.homedir());
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), ...segments(trimmed.slice(2)));
  }

  if (process.platform === "win32") {
    // On Windows, OpenClaw may drop the leading "\" from root-based paths like
    // "Users\name\.openclaw\workspace\file.xlsx". Only recover paths that start
    // with well-known root directories to avoid misclassifying ordinary relative paths.
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
      return path.win32.normalize(trimmed);
    }
    if (firstSegment && /^[a-zA-Z]:$/.test(firstSegment)) {
      return path.win32.resolve(`${firstSegment}\\`, ...pathSegments.slice(1));
    }
    if (firstSegment && WINDOWS_ROOT_DIRECTORIES.has(firstSegment)) {
      return path.win32.resolve("\\", ...pathSegments);
    }
  }
  // Treat both "/" and "\\" as absolute root prefixes for cross-platform input.
  if (/^[\\/]/.test(trimmed)) {
    return path.resolve(path.sep, ...pathSegments);
  }

  // Resolve relative path against cwd; supports mixed separators and "..\\..".
  return path.resolve(process.cwd(), ...pathSegments);
}

export const resolveUserPath = resolveRelativePath;

/**
 * Resolve the robot code used by DingTalk APIs.
 * DingTalk robotCode is always equal to clientId; this helper trims whitespace.
 */
export function resolveRobotCode(config: Pick<DingTalkConfig, "clientId">): string {
  return (config.clientId || "").trim();
}

export function resolveGroupConfig(
  cfg: DingTalkConfig,
  groupId: string,
): { systemPrompt?: string; requireMention?: boolean; groupAllowFrom?: string[] } | undefined {
  // Group config supports exact match first, then wildcard fallback.
  const groups = cfg.groups;
  if (!groups) {
    return undefined;
  }
  return groups[groupId] || groups["*"] || undefined;
}

function hasOwn(obj: unknown, key: string): boolean {
  return typeof obj === "object" && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

function resolveAgentIdentityEmoji(cfg: OpenClawConfig, agentId?: string | null): string | undefined {
  const targetAgentId = String(agentId || "").trim();
  if (!targetAgentId) {
    return undefined;
  }
  const agents = Array.isArray((cfg as any)?.agents?.list) ? (cfg as any).agents.list : [];
  const agent = agents.find((entry: any) => String(entry?.id || "").trim() === targetAgentId);
  const emoji = typeof agent?.identity?.emoji === "string" ? agent.identity.emoji.trim() : "";
  return emoji || undefined;
}

function normalizeAckReactionValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "off") {
    return "off";
  }
  if (normalized === "emoji") {
    return "emoji";
  }
  if (normalized === "kaomoji") {
    return "kaomoji";
  }
  if (trimmed === "🤔思考中") {
    return "emoji";
  }
  return trimmed;
}

export function resolveAckReactionSetting(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  agentId?: string | null;
}): string | undefined {
  const dingtalk = (params.cfg?.channels as any)?.dingtalk;
  const accountId = String(params.accountId || "").trim();
  const accountConfig =
    accountId && dingtalk?.accounts && typeof dingtalk.accounts === "object"
      ? dingtalk.accounts[accountId]
      : undefined;

  if (hasOwn(accountConfig, "ackReaction")) {
    return normalizeAckReactionValue(accountConfig.ackReaction);
  }
  if (hasOwn(dingtalk, "ackReaction")) {
    return normalizeAckReactionValue(dingtalk.ackReaction);
  }

  const messages = (params.cfg as any)?.messages;
  if (hasOwn(messages, "ackReaction")) {
    return normalizeAckReactionValue(messages.ackReaction);
  }

  return resolveAgentIdentityEmoji(params.cfg, params.agentId) || "👀";
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

// ============ Onboarding Helper Functions ============

const DEFAULT_ACCOUNT_ID = "default";


/**
 * List all DingTalk account IDs from config
 */
export function listDingTalkAccountIds(cfg: OpenClawConfig): string[] {
  const dingtalk = cfg.channels?.dingtalk as DingTalkChannelConfig | undefined;
  if (!dingtalk) {
    return [];
  }

  const accountIds: string[] = [];

  if (dingtalk.clientId || dingtalk.clientSecret) {
    accountIds.push(DEFAULT_ACCOUNT_ID);
  }

  if (dingtalk.accounts) {
    accountIds.push(...Object.keys(dingtalk.accounts));
  }

  return accountIds;
}

/**
 * Resolved DingTalk account with configuration status
 */
export interface ResolvedDingTalkAccount extends DingTalkConfig {
  accountId: string;
  configured: boolean;
}

/**
 * Resolve a specific DingTalk account configuration
 */
export function resolveDingTalkAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedDingTalkAccount {
  const id = accountId || DEFAULT_ACCOUNT_ID;
  const dingtalk = cfg.channels?.dingtalk as DingTalkChannelConfig | undefined;

  if (id === DEFAULT_ACCOUNT_ID) {
    const rawConfig: DingTalkConfig = {
      clientId: dingtalk?.clientId ?? "",
      clientSecret: dingtalk?.clientSecret ?? "",
      name: dingtalk?.name,
      enabled: dingtalk?.enabled,
      dmPolicy: dingtalk?.dmPolicy,
      groupPolicy: dingtalk?.groupPolicy,
      allowFrom: dingtalk?.allowFrom,
      groupAllowFrom: dingtalk?.groupAllowFrom,
      displayNameResolution: dingtalk?.displayNameResolution,
      contextVisibility: dingtalk?.contextVisibility,
      journalTTLDays: dingtalk?.journalTTLDays,
      ackReaction: dingtalk?.ackReaction,
      debug: dingtalk?.debug,
      messageType: dingtalk?.messageType,
      cardTemplateId: dingtalk?.cardTemplateId,
      cardTemplateKey: dingtalk?.cardTemplateKey,
      groups: dingtalk?.groups,
      accounts: dingtalk?.accounts,
      maxConnectionAttempts: dingtalk?.maxConnectionAttempts,
      initialReconnectDelay: dingtalk?.initialReconnectDelay,
      maxReconnectDelay: dingtalk?.maxReconnectDelay,
      reconnectJitter: dingtalk?.reconnectJitter,
      maxReconnectCycles: dingtalk?.maxReconnectCycles,
      reconnectDeadlineMs: dingtalk?.reconnectDeadlineMs,
      useConnectionManager: dingtalk?.useConnectionManager,
      mediaMaxMb: dingtalk?.mediaMaxMb,
      keepAlive: dingtalk?.keepAlive,
      bypassProxyForSend: dingtalk?.bypassProxyForSend,
      proactivePermissionHint: dingtalk?.proactivePermissionHint,
      cardStreamingMode: dingtalk?.cardStreamingMode,
      cardRealTimeStream: dingtalk?.cardRealTimeStream,
      cardStreamInterval: dingtalk?.cardStreamInterval,
      aicardDegradeMs: dingtalk?.aicardDegradeMs,
      learningEnabled: dingtalk?.learningEnabled,
      learningAutoApply: dingtalk?.learningAutoApply,
      learningNoteTtlMs: dingtalk?.learningNoteTtlMs,
      convertMarkdownTables: dingtalk?.convertMarkdownTables,
      cardAtSender: dingtalk?.cardAtSender,
    };
    const config = stripRemovedLegacyFields(rawConfig);
    return {
      ...config,
      accountId: id,
      configured: Boolean(config.clientId && hasConfiguredSecretInput(config.clientSecret)),
      clientSecret: normalizeSecretInputString(config.clientSecret) || "",
    };
  }

  const accountConfig = dingtalk?.accounts?.[id];
  if (accountConfig) {
    const merged = mergeAccountWithDefaults(
      dingtalk as DingTalkConfig,
      accountConfig,
    );
    const publicMerged = stripRemovedLegacyFields(merged);
    return {
      ...publicMerged,
      accountId: id,
      configured: Boolean(merged.clientId && hasConfiguredSecretInput(merged.clientSecret)),
      clientSecret: normalizeSecretInputString(merged.clientSecret) || "",
    };
  }

  return {
    clientId: "",
    clientSecret: "",
    accountId: id,
    configured: false,
  };
}
