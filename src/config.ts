import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  formatSecretInputResolutionFailure,
  hasConfiguredSecretInput,
  resolveDingTalkSecretConfig,
} from "./secret-input";
import type {
  DingTalkChannelConfig,
  DingTalkConfig,
  DingTalkGatewayCapabilityConfig,
} from "./types";
export { resolveRelativePath, resolveUserPath } from "./path-utils";
const DEFAULT_LEARNING_NOTE_TTL_MS = 6 * 60 * 60 * 1000;
export type RuntimeDingTalkConfig = Omit<DingTalkConfig, "clientSecret"> & { clientSecret: string };

function normalizeLearningConfig(
  config: DingTalkConfig,
  options: { applyDefaults: boolean },
): DingTalkConfig {
  return {
    ...config,
    learningEnabled: options.applyDefaults
      ? (config.learningEnabled ?? false)
      : config.learningEnabled,
    learningAutoApply: options.applyDefaults
      ? (config.learningAutoApply ?? false)
      : config.learningAutoApply,
    learningNoteTtlMs: options.applyDefaults
      ? (config.learningNoteTtlMs ?? DEFAULT_LEARNING_NOTE_TTL_MS)
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
 * Merge channel-level and account-level `gatewayRpc` gates by sub-key.
 *
 * `mergeAccountWithDefaults` is a shallow merge, so without this helper an
 * account-level object would replace the whole channel-level `gatewayRpc` and
 * silently drop a channel-level allowlist (fail-open). Merging `tools` /
 * `docs` / `send` separately keeps channel-level restrictions in force unless
 * the account explicitly overrides that exact sub-key.
 */
export function mergeGatewayRpcConfig(
  channelLevel: DingTalkGatewayCapabilityConfig | undefined,
  accountLevel: DingTalkGatewayCapabilityConfig | undefined,
): DingTalkGatewayCapabilityConfig | undefined {
  if (!channelLevel) {
    return accountLevel;
  }
  if (!accountLevel) {
    return channelLevel;
  }
  return {
    tools: { ...channelLevel.tools, ...accountLevel.tools },
    docs: { ...channelLevel.docs, ...accountLevel.docs },
    send: { ...channelLevel.send, ...accountLevel.send },
  };
}

/**
 * Merge channel-level defaults into an account-specific config.
 * Account-level values take precedence; `accounts` key is excluded to avoid recursion.
 */
export function mergeAccountWithDefaults(
  channelCfg: DingTalkConfig,
  accountCfg: DingTalkConfig,
): DingTalkConfig {
  const { accounts: _accounts, ...defaultCandidate } = channelCfg as DingTalkConfig & {
    accounts?: unknown;
    verboseRealtimeStream?: unknown;
  };
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
  const merged: DingTalkConfig = {
    ...defaults,
    ...overrides,
  };
  const gatewayRpc = mergeGatewayRpcConfig(defaults.gatewayRpc, overrides.gatewayRpc);
  if (gatewayRpc) {
    merged.gatewayRpc = gatewayRpc;
  }
  return normalizeLearningConfig(merged, { applyDefaults: true });
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

/**
 * Resolved Gateway RPC capability settings (Issue #608, 问题 3).
 * All capabilities default to enabled; allowlists default to unrestricted.
 */
export interface ResolvedGatewayCapabilities {
  /** `dingtalk.docs.*` / `dingtalk-connector.docs.*` RPCs enabled (default: true) */
  docsEnabled: boolean;
  /** `dingtalk-connector.sendToUser/sendToGroup/send` RPCs enabled (default: true) */
  proactiveSendEnabled: boolean;
  /** When set, docs RPCs only accept these spaceId values */
  allowedSpaceIds?: string[];
  /** When set, proactive-send RPCs only accept these `user:*` / `group:*` targets */
  allowedTargets?: string[];
}

/** Denial reason returned when `gatewayRpc.tools.docs` is explicitly false. */
export const DOCS_GATE_DISABLED_REASON =
  "dingtalk docs Gateway RPC is disabled by config (gatewayRpc.tools.docs = false)";

/** Denial reason returned when `gatewayRpc.tools.proactiveSend` is explicitly false. */
export const PROACTIVE_SEND_GATE_DISABLED_REASON =
  "dingtalk proactive-send Gateway RPC is disabled by config (gatewayRpc.tools.proactiveSend = false)";

const DEFAULT_GATEWAY_CAPABILITIES: ResolvedGatewayCapabilities = Object.freeze({
  docsEnabled: true,
  proactiveSendEnabled: true,
});

/**
 * Resolve Gateway RPC capability configuration for an account.
 * Account-level `gatewayRpc` is merged with channel-level defaults by sub-key
 * (see `mergeGatewayRpcConfig`); both default to all capabilities enabled.
 */
export function resolveGatewayCapabilityConfig(
  cfg: OpenClawConfig,
  accountId?: string,
): ResolvedGatewayCapabilities {
  const config = getConfig(cfg, accountId);
  const gatewayRpc = config.gatewayRpc;
  if (!gatewayRpc) {
    return DEFAULT_GATEWAY_CAPABILITIES;
  }
  const tools = gatewayRpc.tools ?? {};
  const docs = gatewayRpc.docs ?? {};
  const send = gatewayRpc.send ?? {};
  return {
    docsEnabled: tools.docs !== false,
    proactiveSendEnabled: tools.proactiveSend !== false,
    allowedSpaceIds: docs.allowedSpaceIds,
    allowedTargets: send.allowedTargets,
  };
}

/**
 * Check a docs RPC request against the configured capability gates.
 * Returns null when allowed, or a human-readable denial reason.
 *
 * A configured allowlist is fail-closed: an empty list (possible only when
 * config validation was bypassed) denies every docs RPC, and a request without
 * a spaceId is denied as well because its doc space cannot be verified.
 */
export function checkDocsGatewayCapability(
  caps: ResolvedGatewayCapabilities,
  spaceId: string | undefined,
): string | null {
  if (!caps.docsEnabled) {
    return DOCS_GATE_DISABLED_REASON;
  }
  if (caps.allowedSpaceIds) {
    if (!spaceId) {
      return "docs RPC denied: this request carries no spaceId while gatewayRpc.docs.allowedSpaceIds is configured (dingtalk.docs.append never carries a spaceId)";
    }
    if (!caps.allowedSpaceIds.includes(spaceId)) {
      return "spaceId is not in gatewayRpc.docs.allowedSpaceIds allowlist";
    }
  }
  return null;
}

/**
 * Check a proactive-send RPC request against the configured capability gates.
 * Returns null when allowed, or a human-readable denial reason.
 *
 * A configured allowlist is fail-closed: an empty list (possible only when
 * config validation was bypassed) denies every proactive-send RPC.
 */
export function checkProactiveSendGatewayCapability(
  caps: ResolvedGatewayCapabilities,
  target: string,
): string | null {
  if (!caps.proactiveSendEnabled) {
    return PROACTIVE_SEND_GATE_DISABLED_REASON;
  }
  if (caps.allowedTargets) {
    if (!caps.allowedTargets.includes(target)) {
      return "target is not in gatewayRpc.send.allowedTargets allowlist";
    }
  }
  return null;
}

export async function resolveRuntimeConfig(
  config: DingTalkConfig,
  log?: { warn?: (message: string, data?: unknown) => void },
): Promise<RuntimeDingTalkConfig> {
  const resolved = await resolveDingTalkSecretConfig(config, log);
  if (!resolved.clientId || !resolved.clientSecret) {
    const secretFailure = resolved.clientSecretResolutionFailure
      ? `: clientSecret resolution failed for ${formatSecretInputResolutionFailure(resolved.clientSecretResolutionFailure)}`
      : "";
    throw new Error(`DingTalk clientId and resolved clientSecret are required${secretFailure}`);
  }
  return {
    ...resolved,
    clientSecret: resolved.clientSecret,
  };
}

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

function resolveAgentIdentityEmoji(
  cfg: OpenClawConfig,
  agentId?: string | null,
): string | undefined {
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
    };
  }

  const accountConfig = dingtalk?.accounts?.[id];
  if (accountConfig) {
    const merged = mergeAccountWithDefaults(dingtalk as DingTalkConfig, accountConfig);
    const publicMerged = stripRemovedLegacyFields(merged);
    return {
      ...publicMerged,
      accountId: id,
      configured: Boolean(merged.clientId && hasConfiguredSecretInput(merged.clientSecret)),
    };
  }

  return {
    clientId: "",
    clientSecret: "",
    accountId: id,
    configured: false,
  };
}
