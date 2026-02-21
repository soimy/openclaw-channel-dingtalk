import * as os from 'node:os';
import * as path from 'node:path';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import type { DingTalkConfig } from './types';

/**
 * Resolve DingTalk config for an account.
 * Falls back to top-level config for single-account setups.
 */
export function getConfig(cfg: OpenClawConfig, accountId?: string): DingTalkConfig {
  const dingtalkCfg = cfg?.channels?.dingtalk as DingTalkConfig | undefined;
  if (!dingtalkCfg) return {} as DingTalkConfig;

  if (accountId && dingtalkCfg.accounts?.[accountId]) {
    return dingtalkCfg.accounts[accountId];
  }

  return dingtalkCfg;
}

export function isConfigured(cfg: OpenClawConfig, accountId?: string): boolean {
  const config = getConfig(cfg, accountId);
  return Boolean(config.clientId && config.clientSecret);
}

const DEFAULT_AGENT_ID = 'main';
const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_AGENT_ID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return DEFAULT_AGENT_ID;
  if (VALID_AGENT_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_AGENT_ID_CHARS_RE, '-')
      .replace(LEADING_DASH_RE, '')
      .replace(TRAILING_DASH_RE, '')
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

export function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('~')) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

function resolveDefaultAgentWorkspaceDir(): string {
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== 'default') {
    return path.join(os.homedir(), '.openclaw', `workspace-${profile}`);
  }
  return path.join(os.homedir(), '.openclaw', 'workspace');
}

interface AgentConfig {
  id?: string;
  default?: boolean;
  workspace?: string;
}

function resolveDefaultAgentId(cfg: OpenClawConfig): string {
  const agents: AgentConfig[] = cfg.agents?.list ?? [];
  if (agents.length === 0) return DEFAULT_AGENT_ID;
  const defaults = agents.filter((agent: AgentConfig) => agent?.default);
  const chosen = (defaults[0] ?? agents[0])?.id?.trim();
  return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}

export function resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string): string {
  // Keep workspace resolution aligned with OpenClaw agent workspace conventions.
  const id = normalizeAgentId(agentId);
  const agents: AgentConfig[] = cfg.agents?.list ?? [];
  const agent = agents.find((entry: AgentConfig) => normalizeAgentId(entry?.id) === id);
  const configured = agent?.workspace?.trim();
  if (configured) return resolveUserPath(configured);
  const defaultAgentId = resolveDefaultAgentId(cfg);
  if (id === defaultAgentId) {
    const fallback = cfg.agents?.defaults?.workspace?.trim();
    if (fallback) return resolveUserPath(fallback);
    return resolveDefaultAgentWorkspaceDir();
  }
  return path.join(os.homedir(), '.openclaw', `workspace-${id}`);
}

export function resolveGroupConfig(cfg: DingTalkConfig, groupId: string): { systemPrompt?: string } | undefined {
  // Group config supports exact match first, then wildcard fallback.
  const groups = cfg.groups;
  if (!groups) return undefined;
  return groups[groupId] || groups['*'] || undefined;
}

/**
 * Strip group/user prefixes used by CLI targeting.
 * Returns raw DingTalk target ID and whether caller explicitly requested a user target.
 */
export function stripTargetPrefix(target: string): { targetId: string; isExplicitUser: boolean } {
  if (target.startsWith('group:')) {
    return { targetId: target.slice(6), isExplicitUser: false };
  }
  if (target.startsWith('user:')) {
    return { targetId: target.slice(5), isExplicitUser: true };
  }
  return { targetId: target, isExplicitUser: false };
}
