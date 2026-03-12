/**
 * Agent name matcher for @sub-agent feature
 *
 * Matches @mentions to agent IDs based on name and id fields in agents.list config.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { AtMention, AgentNameMatch } from "./types";

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
 * @returns Matched agents, unmatched names, and main agent ID
 *
 * @remarks
 * Exclusion logic for unmatched @mentions:
 * - If mention.userId is set (from richText), it's a real user → excluded from unmatchedNames
 * - If atUserDingtalkIds is non-empty, some @mentions are real users but we don't know which
 *   → we still add to unmatchedNames but caller can use atUserDingtalkIds.length for heuristics
 *
 * Limitation: For text messages, we cannot map dingtalkId to display names, so we cannot
 * definitively determine which specific @mention corresponds to a real user vs an agent name.
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
} {
  const agents = cfg?.agents?.list as AgentConfig[] | undefined;
  const mainAgentId = getMainAgentId(agents);

  if (!atMentions || atMentions.length === 0) {
    return {
      matchedAgents: [],
      unmatchedNames: [],
      mainAgentId,
      realUserCount: 0,
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

  return {
    matchedAgents,
    unmatchedNames,
    mainAgentId,
    realUserCount,
  };
}
