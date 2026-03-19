/**
 * Sub-agent routing for @mention-based multi-agent support.
 *
 * Extracts @mentions from inbound messages and resolves them to agent IDs
 * using agents.list configuration. This is a plugin-layer routing mechanism
 * because the framework's resolveAgentRoute only supports static matching
 * (channel + accountId + peer), not content-based dynamic routing.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveAtAgents } from "./agent-name-matcher";
import { parseLearnCommand } from "../learning-command-service";
import { getDingTalkRuntime } from "../runtime";
import { sendBySession } from "../send-service";
import type { AgentNameMatch, DingTalkConfig, DingTalkInboundMessage, HandleDingTalkMessageParams, Logger, MessageContent } from "../types";

/**
 * Build a session key for a specific agent using the runtime API.
 * Falls back to framework's resolveAgentRoute if buildAgentSessionKey is unavailable.
 */
export function buildAgentSessionKey(params: {
  rt: ReturnType<typeof getDingTalkRuntime>;
  cfg: OpenClawConfig;
  accountId: string;
  agentId: string;
  peerKind: "direct" | "group";
  peerId: string;
}): string {
  const { rt, cfg, accountId, agentId, peerKind, peerId } = params;
  const routing = rt.channel.routing as Record<string, unknown>;
  if (typeof routing.buildAgentSessionKey === "function") {
    return (
      (routing.buildAgentSessionKey as (p: unknown) => string)({
        agentId,
        channel: "dingtalk",
        accountId,
        peer: { kind: peerKind, id: peerId },
        dmScope: cfg.session?.dmScope,
        identityLinks: cfg.session?.identityLinks,
      })
    ).toLowerCase();
  }
  // Fallback: derive a session key with agentId suffix to ensure isolation.
  // resolveAgentRoute routes to the default agent, so we append the target
  // agentId to prevent session key collisions between sub-agents.
  const fallbackRoute = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: "dingtalk",
    accountId,
    peer: { kind: peerKind, id: peerId },
  });
  return `${fallbackRoute.sessionKey}:subagent:${agentId}`;
}

/**
 * Sanitize agent name for safe use in markdown prefix and context hints.
 * Strips brackets, newlines, and control characters to prevent markdown
 * breakage and prompt injection.
 */
function sanitizeAgentName(name: string): string {
  return name.replace(/[\[\]\r\n]/g, "").trim();
}

/**
 * Resolve @mention-based sub-agent routing for a group message.
 *
 * Returns matched agents if any @mentions resolve to configured agents,
 * or null if the message should be handled by the default agent.
 */
export async function resolveSubAgentRoute(params: {
  extractedContent: MessageContent;
  cfg: OpenClawConfig;
  isGroup: boolean;
  dingtalkConfig: DingTalkConfig;
  sessionWebhook: string;
  senderId: string;
  log?: Logger;
}): Promise<{
  matchedAgents: AgentNameMatch[];
  preDownloadedMedia?: { mediaPath?: string; mediaType?: string };
} | null> {
  const { extractedContent, cfg, isGroup, dingtalkConfig, sessionWebhook, senderId, log } = params;

  const atMentions = extractedContent.atMentions || [];
  const atUserDingtalkIds = extractedContent.atUserDingtalkIds;
  // Strip quoted prefix before checking /learn to avoid false positives
  // when the quoted message itself contains a /learn command.
  const textForCommandCheck = extractedContent.text.replace(/^\[引用[^\]]*\]\s*/, "");
  const isLearnCommand = parseLearnCommand(textForCommandCheck).scope !== "unknown";

  if (
    !isGroup ||
    atMentions.length === 0 ||
    !cfg.agents?.list ||
    cfg.agents.list.length === 0 ||
    isLearnCommand
  ) {
    return null;
  }

  const { matchedAgents, unmatchedNames, realUserCount, hasInvalidAgentNames } = resolveAtAgents(
    atMentions,
    cfg,
    atUserDingtalkIds,
  );
  log?.info?.(
    `[DingTalk] Sub-agent resolve: matched=${matchedAgents.map((a) => a.agentId).join(",")} unmatched=${unmatchedNames.join(",")} realUsers=${realUserCount}`,
  );

  // Send fallback notice for unmatched agent names
  if (hasInvalidAgentNames) {
    const fallbackReason = `未找到名为"${unmatchedNames.join("、")}"的助手`;
    try {
      await sendBySession(dingtalkConfig, sessionWebhook, `⚠️ ${fallbackReason}`, {
        atUserId: senderId,
        log,
      });
    } catch (err: any) {
      log?.debug?.(`[DingTalk] Failed to send fallback notice: ${err.message}`);
    }
  }

  if (matchedAgents.length === 0) {
    return null;
  }

  return { matchedAgents };
}

/**
 * Process matched sub-agents by dispatching each to handleDingTalkMessage.
 */
export async function dispatchSubAgents(params: {
  matchedAgents: AgentNameMatch[];
  cfg: OpenClawConfig;
  accountId: string;
  data: DingTalkInboundMessage;
  dingtalkConfig: DingTalkConfig;
  sessionWebhook: string;
  extractedContent: MessageContent;
  handleMessage: (params: HandleDingTalkMessageParams) => Promise<void>;
  downloadMedia: (config: DingTalkConfig, mediaPath: string, log?: Logger) => Promise<{ path: string; mimeType: string } | null>;
  log?: Logger;
}): Promise<void> {
  const { matchedAgents, cfg, accountId, data, dingtalkConfig, sessionWebhook, extractedContent, handleMessage, downloadMedia: download, log } = params;

  // Pre-download media once to avoid duplication across sub-agents
  let preDownloadedMedia: { mediaPath?: string; mediaType?: string } | undefined;
  if (extractedContent.mediaPath && dingtalkConfig.robotCode) {
    const media = await download(dingtalkConfig, extractedContent.mediaPath, log);
    if (media) {
      preDownloadedMedia = { mediaPath: media.path, mediaType: media.mimeType };
    }
  }

  for (const agentMatch of matchedAgents) {
    try {
      await handleMessage({
        cfg,
        accountId,
        data,
        sessionWebhook,
        log,
        dingtalkConfig,
        subAgentOptions: {
          agentId: agentMatch.agentId,
          responsePrefix: `[${sanitizeAgentName(agentMatch.matchedName)}] `,
          matchedName: agentMatch.matchedName,
        },
        preDownloadedMedia,
      });
    } catch (error) {
      log?.error?.(
        `[DingTalk] Sub-agent ${agentMatch.agentId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
