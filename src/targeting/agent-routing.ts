/**
 * Sub-agent routing for @mention-based multi-agent support.
 *
 * Extracts @mentions from inbound messages and resolves them to agent IDs
 * using agents.list configuration. This is a plugin-layer routing mechanism
 * because the framework's resolveAgentRoute only supports static matching
 * (channel + accountId + peer), not content-based dynamic routing.
 */

import { maybeResolveTextAlias } from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveRobotCode } from "../config";
import { parseLearnCommand } from "../learning-command-service";
import { getDingTalkRuntime } from "../runtime";
import { sendBySession } from "../send-service";
import type {
  AgentNameMatch,
  DingTalkConfig,
  DingTalkInboundMessage,
  HandleDingTalkMessageParams,
  Logger,
  MessageContent,
} from "../types";
import { getErrorMessage } from "../utils";
import { resolveAtAgents } from "./agent-name-matcher";

export class HostRoutingHelperUnavailableError extends Error {
  constructor(
    message = "DingTalk sub-agent routing requires runtime.channel.routing.buildAgentSessionKey from the host runtime.",
  ) {
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
  return (routing.buildAgentSessionKey as (p: unknown) => string)({
    agentId,
    channel: "dingtalk",
    accountId,
    peer: { kind: peerKind, id: peerId },
    dmScope: cfg.session?.dmScope,
    identityLinks: cfg.session?.identityLinks,
  }).toLowerCase();
}

/**
 * The single routing decision for an inbound message.
 *
 * - `default` — route to the peer's default agent via `resolveAgentRoute`.
 *   Covers messages with no @mention, learn/session commands, and slash
 *   commands that mention only real users.
 * - `subagent-content` — `@agent <message>` targeting one or more configured
 *   agents; each is dispatched recursively. `unmatchedNames` /
 *   `hasInvalidAgentNames` drive the "agent not found" notice.
 * - `subagent-command` — `@agent /command` targeting a configured agent. The
 *   command is dispatched to that agent's session with the @mention prefix
 *   stripped from `commandText`.
 */
export type MessageTarget =
  | { kind: "default" }
  | {
      kind: "subagent-content";
      matchedAgents: AgentNameMatch[];
      unmatchedNames: string[];
      hasInvalidAgentNames: boolean;
    }
  | { kind: "subagent-command"; agent: AgentNameMatch; commandText: string };

/**
 * Resolve how an inbound message should be routed.
 *
 * This is the single source of truth for "who does this message target": both
 * content sub-agent routing and targeted slash commands are decided here, so
 * the @mention/alias parsing happens exactly once. The function is pure — the
 * caller is responsible for any side effects (dispatch, fallback notices).
 *
 * In group chats @mentions come from the DingTalk SDK (`atMentions`); in DMs
 * `extractMessageContent` populates the same field for text messages, so the
 * same logic enables sub-agent routing in DMs without an `isGroup` guard.
 */
export function resolveMessageTarget(params: {
  extractedContent: MessageContent;
  cfg: OpenClawConfig;
  isGroup: boolean;
}): MessageTarget {
  const { extractedContent, cfg, isGroup } = params;
  const atMentions = extractedContent.atMentions || [];
  // No @mentions or no configured agents → nothing to route dynamically.
  if (atMentions.length === 0 || !cfg.agents?.list || cfg.agents.list.length === 0) {
    return { kind: "default" };
  }

  // Strip quoted prefix before inspecting commands to avoid false positives
  // when the quoted message itself contains a command.
  const textForCommandCheck = extractedContent.text.replace(/^\[引用[^\]]*\]\s*/, "");
  // Learn/session commands are handled by the plugin command layer on the
  // default route, so they must bypass sub-agent routing entirely.
  if (parseLearnCommand(textForCommandCheck).scope !== "unknown") {
    return { kind: "default" };
  }

  // DM has no @picker list from DingTalk; only group chats provide atUsers for real-user hints.
  const atUserDingtalkIds = isGroup ? extractedContent.atUserDingtalkIds : undefined;
  const { matchedAgents, unmatchedNames, hasInvalidAgentNames } = resolveAtAgents(
    atMentions,
    cfg,
    atUserDingtalkIds,
  );

  // Slash commands like /new, /stop, /reasoning must reach the framework's own
  // command layer. When one targets a configured agent, route it to that
  // agent's session with the leading @mention tokens stripped. When no agent
  // matched, fall through: an unmatched agent name still produces the "not
  // found" notice, while a slash command that only @mentions real users (or no
  // agent at all) goes to the default route.
  const commandText = textForCommandCheck.replace(/^(?:@\S+\s+)*/u, "").trim();
  if (maybeResolveTextAlias(commandText, cfg) !== null) {
    const firstMatch = matchedAgents[0];
    if (firstMatch) {
      return { kind: "subagent-command", agent: firstMatch, commandText };
    }
  }

  if (matchedAgents.length === 0 && !hasInvalidAgentNames) {
    return { kind: "default" };
  }
  return { kind: "subagent-content", matchedAgents, unmatchedNames, hasInvalidAgentNames };
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
 * Send the "agent not found" fallback notice for unmatched @mention names.
 *
 * In group chats the notice @s the sender back; in DMs it is a plain reply.
 * Failures are swallowed — the notice is best-effort and must not abort the
 * inbound pipeline.
 */
export async function sendUnmatchedAgentNotice(params: {
  unmatchedNames: string[];
  isGroup: boolean;
  senderId: string;
  dingtalkConfig: DingTalkConfig;
  sessionWebhook: string;
  log?: Logger;
}): Promise<void> {
  const { unmatchedNames, isGroup, senderId, dingtalkConfig, sessionWebhook, log } = params;
  const fallbackReason = `未找到名为"${unmatchedNames.join("、")}"的助手`;
  try {
    const sendOptions = isGroup ? { atUserId: senderId, log } : { log };
    await sendBySession(dingtalkConfig, sessionWebhook, `⚠️ ${fallbackReason}`, sendOptions);
  } catch (err: unknown) {
    log?.debug?.(`[DingTalk] Failed to send fallback notice: ${getErrorMessage(err)}`);
  }
}

/**
 * Process matched sub-agents by dispatching each to handleDingTalkMessage.
 *
 * When `commandText` is set, this is a targeted slash command (`@agent /new`):
 * `matchedAgents` holds the single resolved agent, the command is threaded
 * through `subAgentOptions.commandText`, and no response prefix is added.
 * Otherwise it is content routing — each matched agent is dispatched with a
 * `> 🤖 **agent**:` prefix. Both modes share the same recursive dispatch path,
 * so the host-helper-missing fallback below is the only copy.
 */
export async function dispatchSubAgents(params: {
  matchedAgents: AgentNameMatch[];
  commandText?: string;
  cfg: OpenClawConfig;
  accountId: string;
  data: DingTalkInboundMessage;
  dingtalkConfig: DingTalkConfig;
  sessionWebhook: string;
  extractedContent: MessageContent;
  handleMessage: (params: HandleDingTalkMessageParams) => Promise<void>;
  downloadMedia: (
    config: DingTalkConfig,
    mediaPath: string,
    log?: Logger,
  ) => Promise<{ path: string; mimeType: string } | null>;
  log?: Logger;
}): Promise<void> {
  const {
    matchedAgents,
    commandText,
    cfg,
    accountId,
    data,
    dingtalkConfig,
    sessionWebhook,
    extractedContent,
    handleMessage,
    downloadMedia: download,
    log,
  } = params;

  // Pre-download media once to avoid duplication across sub-agents
  let preDownloadedMedia:
    | {
        mediaPath?: string;
        mediaType?: string;
        mediaPaths?: string[];
        mediaTypes?: string[];
      }
    | undefined;
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
          responsePrefix: commandText
            ? ""
            : `> 🤖 **${sanitizeAgentName(agentMatch.matchedName)}**:\n\n`,
          matchedName: agentMatch.matchedName,
          commandText,
        },
        preDownloadedMedia,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      log?.error?.(`[DingTalk] Sub-agent ${agentMatch.agentId} failed: ${message}`);
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
