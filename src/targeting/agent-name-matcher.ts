/**
 * Agent name matcher for @sub-agent feature
 *
 * Matches @mentions to agent IDs based on name and id fields in agents.list config.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { AtMention, AgentNameMatch } from "../types";

interface AgentConfig {
  id: string;
  name?: string;
  default?: boolean;
}

/**
 * Normalize name for case-insensitive matching
 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Get main agent ID from agents.list
 */
export function getMainAgentId(agents: AgentConfig[] | undefined): string {
  if (!agents || agents.length === 0) {
    return "main";
  }

  const defaultAgent = agents.find((a) => a.default);
  if (defaultAgent) {
    return defaultAgent.id;
  }

  return agents[0].id;
}

/**
 * Match a single @name to an agent
 */
function matchAtName(atName: string, agents: AgentConfig[]): AgentNameMatch | null {
  const normalizedAtName = normalizeName(atName);

  for (const agent of agents) {
    // 1. Match by name field
    if (agent.name && normalizeName(agent.name) === normalizedAtName) {
      return {
        agentId: agent.id,
        matchSource: "name",
        matchedName: agent.name,
      };
    }

    // 2. Match by id field
    if (normalizeName(agent.id) === normalizedAtName) {
      return {
        agentId: agent.id,
        matchSource: "id",
        matchedName: agent.id,
      };
    }
  }

  return null;
}

/**
 * Resolve @mentions to agent matches
 *
 * @param atMentions - List of @mentions extracted from message
 * @param cfg - OpenClaw configuration
 * @param atUserDingtalkIds - dingtalkIds from webhook atUsers field (real users selected via @picker)
 * @returns Matched agents, unmatched names, main agent ID, and whether there are invalid agent names
 *
 * @remarks
 * Exclusion logic for unmatched @mentions:
 * - If mention.userId is set (from richText), it's a real user → excluded from unmatchedNames
 * - In text mode, we cannot map dingtalkIds to specific @mention names
 * - To avoid false positives (reporting real user names as missing agents),
 *   we use a conservative heuristic:
 *   - If realUserCount > 0, hasInvalidAgentNames is always false
 *   - This means we never report "agent not found" in text mode when there are real users
 * - In richText mode, mention.userId allows precise exclusion, so the heuristic is not needed
 */
export function resolveAtAgents(
  atMentions: AtMention[],
  cfg: OpenClawConfig,
  atUserDingtalkIds?: string[],
): {
  matchedAgents: AgentNameMatch[];
  unmatchedNames: string[];
  mainAgentId: string;
  /** Count of @mentions that are likely real users (from atUserDingtalkIds) */
  realUserCount: number;
  /** Whether there are invalid agent names (conservative: false if realUserCount > 0) */
  hasInvalidAgentNames: boolean;
} {
  const agents = cfg?.agents?.list as AgentConfig[] | undefined;
  const mainAgentId = getMainAgentId(agents);

  if (!atMentions || atMentions.length === 0) {
    return {
      matchedAgents: [],
      unmatchedNames: [],
      mainAgentId,
      realUserCount: 0,
      hasInvalidAgentNames: false,
    };
  }

  const matchedAgents: AgentNameMatch[] = [];
  const unmatchedNames: string[] = [];

  for (const mention of atMentions) {
    const match = agents ? matchAtName(mention.name, agents) : null;

    if (match) {
      // Avoid duplicate agents
      if (!matchedAgents.some((m) => m.agentId === match.agentId)) {
        matchedAgents.push(match);
      }
    } else {
      // Exclude @real users (those with userId are real users from richText)
      if (!mention.userId) {
        unmatchedNames.push(mention.name);
      }
    }
  }

  // Count real users from atUserDingtalkIds
  // These are real DingTalk users selected via @picker, but we don't know which names they correspond to
  const realUserCount = atUserDingtalkIds?.length || 0;

  // Conservative heuristic: if there are real users, never report invalid agent names
  // This avoids false positives where real user names are incorrectly reported as missing agents
  // In text mode, we cannot distinguish which @mentions correspond to real users
  // In richText mode, mention.userId provides precise exclusion, so this is just a safety net
  const hasInvalidAgentNames = realUserCount === 0 && unmatchedNames.length > 0;

  return {
    matchedAgents,
    unmatchedNames,
    mainAgentId,
    realUserCount,
    hasInvalidAgentNames,
  };
}

/**
 * Get agent display name for statusLine in card template.
 *
 * Priority:
 * 1. subAgentOptions.matchedName - user-friendly name from @mention (e.g., "代码专家")
 * 2. agents.list lookup - name field from agent config
 * 3. agentId fallback - technical identifier
 */
export function getAgentDisplayName(params: {
  subAgentOptions?: { matchedName?: string };
  agentId: string;
  agentsList?: Array<{ id: string; name?: string }>;
}): string {
  // Priority 1: sub-agent matchedName (user-friendly)
  if (params.subAgentOptions?.matchedName) {
    return params.subAgentOptions.matchedName;
  }
  // Priority 2: lookup from agents.list
  if (params.agentsList) {
    const agent = params.agentsList.find((a) => a.id === params.agentId);
    if (agent?.name) {
      return agent.name;
    }
  }
  // Priority 3: fallback to agentId
  return params.agentId;
}
