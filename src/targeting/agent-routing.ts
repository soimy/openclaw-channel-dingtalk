/**
 * Sub-agent routing for @mention-based multi-agent support.
 *
 * Extracts @mentions from inbound messages and resolves them to agent IDs
 * using agents.list configuration. This is a plugin-layer routing mechanism
 * because the framework's resolveAgentRoute only supports static matching
 * (channel + accountId + peer), not content-based dynamic routing.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { maybeResolveTextAlias } from "openclaw/plugin-sdk/command-auth";
import { resolveAtAgents } from "./agent-name-matcher";
import { resolveRobotCode } from "../config";
import { parseLearnCommand } from "../learning-command-service";
import { getDingTalkRuntime } from "../runtime";
import { sendBySession } from "../send-service";
import { getErrorMessage } from "../utils";
import type { AgentNameMatch, DingTalkConfig, DingTalkInboundMessage, HandleDingTalkMessageParams, Logger, MessageContent } from "../types";

export class HostRoutingHelperUnavailableError extends Error {
  constructor(message = "DingTalk sub-agent routing requires runtime.channel.routing.buildAgentSessionKey from the host runtime.") {
    super(message);
    this.name = "HostRoutingHelperUnavailableError";
  }
}

/**
 * Build a session key for a specific agent using the runtime API.
 * On supported host versions, sub-agent routing must use the shared helper
 * instead of synthesizing plugin-local fallback keys.
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
  if (typeof routing.buildAgentSessionKey !== "function") {
    throw new HostRoutingHelperUnavailableError();
  }
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

/**
 * Sanitize agent name for safe use in markdown prefix and context hints.
 * Strips brackets, newlines, and control characters to prevent markdown
 * breakage and prompt injection.
 */
function sanitizeAgentName(name: string): string {
  return name.replace(/[[\]\r\n]/g, "").trim();
}

/**
 * Resolve @mention-based sub-agent routing for a group or direct message.
 *
 * In group chats, @mentions are populated by the DingTalk SDK (atMentions field).
 * In direct messages (DM), the SDK also populates atMentions for text-type messages
 * via extractMessageContent in message-utils.ts, so the same field is reused here.
 * The !isGroup guard is removed to enable sub-agent routing in DM as well.
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
  // DM has no @picker list from DingTalk; only group chats provide atUsers for real-user hints.
  const atUserDingtalkIds = isGroup ? extractedContent.atUserDingtalkIds : undefined;
  // Strip quoted prefix before checking commands to avoid false positives
  // when the quoted message itself contains a command.
  const textForCommandCheck = extractedContent.text.replace(/^\[引用[^\]]*\]\s*/, "");
  const isLearnCommand = parseLearnCommand(textForCommandCheck).scope !== "unknown";
  // Slash commands like /new, /stop, /reasoning etc. must bypass sub-agent
  // routing so they reach the framework's own command handling layer.
  // Strip leading @mention tokens first since DM text may look like "@Agent /new".
  const textWithoutMentions = textForCommandCheck.replace(/^(?:@\S+\s+)*/u, "").trim();
  const isSlashCommand = maybeResolveTextAlias(textWithoutMentions, cfg) !== null;

  if (
    atMentions.length === 0 ||
    !cfg.agents?.list ||
    cfg.agents.list.length === 0 ||
    isLearnCommand ||
    isSlashCommand
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
      const sendOptions = isGroup ? { atUserId: senderId, log } : { log };
      await sendBySession(dingtalkConfig, sessionWebhook, `⚠️ ${fallbackReason}`, {
        ...sendOptions,
      });
    } catch (err: unknown) {
      log?.debug?.(`[DingTalk] Failed to send fallback notice: ${getErrorMessage(err)}`);
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
  let preDownloadedMedia: {
    mediaPath?: string;
    mediaType?: string;
    mediaPaths?: string[];
    mediaTypes?: string[];
  } | undefined;
  const robotCode = resolveRobotCode(dingtalkConfig);
  if (robotCode) {
    const downloadCodes =
      extractedContent.mediaPaths && extractedContent.mediaPaths.length > 0
        ? extractedContent.mediaPaths
        : extractedContent.mediaPath
          ? [extractedContent.mediaPath]
          : [];
    const mediaPaths: string[] = [];
    const mediaTypes: string[] = [];
    for (const downloadCode of downloadCodes) {
      const media = await download(dingtalkConfig, downloadCode, log);
      if (media) {
        mediaPaths.push(media.path);
        mediaTypes.push(media.mimeType);
      }
    }
    if (mediaPaths.length > 0) {
      preDownloadedMedia = {
        mediaPath: mediaPaths[0],
        mediaType: mediaTypes[0],
        mediaPaths,
        mediaTypes,
      };
    }
  }
  let helperMissingWarningSent = false;

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
          responsePrefix: `> 🤖 **${sanitizeAgentName(agentMatch.matchedName)}**:\n\n`,
          matchedName: agentMatch.matchedName,
        },
        preDownloadedMedia,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      log?.error?.(
        `[DingTalk] Sub-agent ${agentMatch.agentId} failed: ${message}`,
      );
      if (error instanceof HostRoutingHelperUnavailableError && !helperMissingWarningSent) {
        helperMissingWarningSent = true;
        try {
          const isGroup = data.conversationType !== "1";
          const sendOptions = isGroup ? { atUserId: data.senderId, log } : { log };
          await sendBySession(
            dingtalkConfig,
            sessionWebhook,
            "⚠️ 当前宿主版本不支持 DingTalk 子助手路由所需的 session helper，请升级 OpenClaw 后重试。",
            sendOptions,
          );
        } catch (notifyError: unknown) {
          log?.debug?.(
            `[DingTalk] Failed to send sub-agent helper-missing notice: ${getErrorMessage(notifyError)}`,
          );
        }
      }
    }
  }
}
