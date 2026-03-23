import axios from "axios";
import { normalizeAllowFrom, isSenderAllowed, resolveGroupAccess } from "./access-control";
import { buildAgentSessionKey, resolveSubAgentRoute, dispatchSubAgents } from "./targeting/agent-routing";
import { classifyAckReactionEmoji } from "./ack-reaction-classifier";
import { attachNativeAckReaction } from "./ack-reaction-service";
import { createDynamicAckReactionController } from "./ack-reaction/dynamic-ack-reaction-controller";
import { extractAttachmentText } from "./attachment-text-extractor";
import { getAccessToken } from "./auth";
import { createAICard } from "./card-service";
import {
  formatSummaryCommandHelp,
  generateSummaryNarrative,
  isSummaryCommandText,
  parseSummaryCommand,
  resolveSummaryMentionNames,
} from "./commands/summary-command-service";
import { resolveAckReactionSetting, resolveGroupConfig } from "./config";
import {
  applyManualTargetLearningRule,
  applyManualTargetsLearningRule,
  applyManualGlobalLearningRule,
  applyManualSessionLearningNote,
  applyTargetSetLearningRule,
  buildLearningContextBlock,
  createOrUpdateTargetSet,
  deleteManualRule,
  disableManualRule,
  isFeedbackLearningEnabled,
  listLearningTargetSets,
  listScopedLearningRules,
  resolveManualForcedReply,
} from "./feedback-learning-service";
import { formatGroupMembers, noteGroupMember } from "./group-members-store";
import {
  formatLearnAppliedReply,
  formatLearnCommandHelp,
  formatLearnDeletedReply,
  formatLearnDisabledReply,
  formatLearnListReply,
  formatOwnerOnlyDeniedReply,
  formatOwnerStatusReply,
  formatTargetSetSavedReply,
  formatWhereAmIReply,
  formatWhoAmIReply,
  isLearningOwner,
  parseLearnCommand,
} from "./learning-command-service";
import { setCurrentLogger } from "./logger-context";
import { prepareMediaInput, resolveOutboundMediaType } from "./media-utils";
import {
  DEFAULT_MEDIA_CONTEXT_TTL_MS,
  DEFAULT_MESSAGE_CONTEXT_TTL_DAYS,
  upsertInboundMessageContext,
} from "./message-context-store";
import { extractMessageContent } from "./message-utils";
import { resolveQuotedRuntimeContext } from "./messaging/quoted-context";
import {
  buildInboundQuotedRef,
  createReplyQuotedRef,
  resolveQuotedRecord,
} from "./messaging/quoted-ref";
import { registerPeerId } from "./peer-id-registry";
import {
  clearProactiveRiskObservationsForTest,
  getProactiveRiskObservationForAny,
} from "./proactive-risk-registry";
import { downloadGroupFile, getUnionIdByStaffId, resolveQuotedFile } from "./quoted-file-service";
import { createReplyStrategy } from "./reply-strategy";
import type { DeliverPayload } from "./reply-strategy";
import { getDingTalkRuntime } from "./runtime";
import { sendBySession, sendMessage, sendProactiveMedia } from "./send-service";
import {
  formatSessionAliasBoundReply,
  formatSessionAliasClearedReply,
  formatSessionAliasReply,
  formatSessionAliasSetReply,
  formatSessionAliasUnboundReply,
  formatSessionAliasValidationErrorReply,
  parseSessionCommand,
  validateSessionAlias,
} from "./session-command-service";
import { acquireSessionLock } from "./session-lock";
import {
  clearSessionPeerOverride,
  getSessionPeerOverride,
  setSessionPeerOverride,
} from "./session-peer-store";
import { resolveDingTalkSessionPeer } from "./session-routing";
import {
  upsertObservedGroupTarget,
  upsertObservedUserTarget,
} from "./targeting/target-directory-store";
import type { DingTalkConfig, HandleDingTalkMessageParams, MediaFile } from "./types";
import { formatDingTalkErrorPayloadLog, getErrorMessage, getErrorResponseData, maskSensitiveData } from "./utils";

const DEFAULT_PROACTIVE_HINT_COOLDOWN_HOURS = 24;
const MIN_THINKING_REACTION_VISIBLE_MS = 1200;
const MAX_DYNAMIC_ACK_DISPOSE_WAIT_MS = 500;
const proactiveHintLastSentAt = new Map<string, number>();

function resolvePinnedMainDmOwner(params: {
  dmScope?: string;
  allowFrom?: string[];
}): string | null {
  if ((params.dmScope ?? "main") !== "main") {
    return null;
  }
  const allow = normalizeAllowFrom(params.allowFrom);
  if (allow.hasWildcard) {
    return null;
  }
  return allow.entries.length === 1 ? allow.entries[0] : null;
}

function ttlDaysToMs(ttlDays: number | undefined): number | undefined {
  if (typeof ttlDays !== "number" || !Number.isFinite(ttlDays) || ttlDays <= 0) {
    return undefined;
  }
  return ttlDays * 24 * 60 * 60 * 1000;
}

async function waitForDynamicAckDispose(params: {
  dispose: () => Promise<void>;
  log?: { debug?: (message: string) => void; warn?: (message: string) => void };
  sessionKey: string;
}): Promise<void> {
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const disposePromise = params.dispose().catch((err: unknown) => {
    params.log?.warn?.(
      `[DingTalk] Dynamic ack reaction cleanup failed for session ${params.sessionKey}: ${getErrorMessage(err)}`,
    );
  });

  try {
    await Promise.race([
      disposePromise,
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolve();
        }, MAX_DYNAMIC_ACK_DISPOSE_WAIT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  if (timedOut) {
    params.log?.debug?.(
      `[DingTalk] Dynamic ack reaction cleanup timed out after ${MAX_DYNAMIC_ACK_DISPOSE_WAIT_MS}ms; releasing session lock for ${params.sessionKey}`,
    );
  }
}

export function resetProactivePermissionHintStateForTest(): void {
  proactiveHintLastSentAt.clear();
  clearProactiveRiskObservationsForTest();
}

function shouldSendProactivePermissionHint(params: {
  isDirect: boolean;
  accountId: string;
  senderId: string;
  senderOriginalId?: string;
  senderStaffId?: string;
  config: DingTalkConfig;
  nowMs: number;
}): boolean {
  if (!params.isDirect) {
    return false;
  }

  const hintConfig = params.config.proactivePermissionHint;
  if (hintConfig?.enabled === false) {
    return false;
  }

  const targetId = (params.senderId || "").trim();
  if (!targetId) {
    return false;
  }

  const riskTargets = [params.senderId, params.senderOriginalId, params.senderStaffId]
    .map((id) => (id || "").trim())
    .filter((id, index, arr) => Boolean(id) && arr.indexOf(id) === index);
  if (riskTargets.length === 0) {
    return false;
  }

  const riskObservation = getProactiveRiskObservationForAny(
    params.accountId,
    riskTargets,
    params.nowMs,
  );
  if (!riskObservation || riskObservation.source !== "proactive-api") {
    return false;
  }

  const cooldownHours =
    hintConfig?.cooldownHours && hintConfig.cooldownHours > 0
      ? hintConfig.cooldownHours
      : DEFAULT_PROACTIVE_HINT_COOLDOWN_HOURS;
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const key = `${params.accountId}:${targetId}`;
  const lastSentAt = proactiveHintLastSentAt.get(key) || 0;
  if (params.nowMs - lastSentAt < cooldownMs) {
    return false;
  }

  proactiveHintLastSentAt.set(key, params.nowMs);
  return true;
}

function sanitizeGroupPromptName(value?: string): string {
  return (value || "")
    .replace(/[\r\n,=]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildGroupTurnContextPrompt(params: {
  conversationId: string;
  senderDingtalkId: string;
  senderName?: string;
}): string {
  const sanitizedSenderName = sanitizeGroupPromptName(params.senderName) || "Unknown";
  return [
    "Current DingTalk group turn context:",
    `- conversationId: ${params.conversationId}`,
    `- senderDingtalkId: ${params.senderDingtalkId}`,
    `- senderName: ${sanitizedSenderName}`,
    "Treat senderDingtalkId and senderName as the authoritative sender for this turn. Do not guess the current sender from GroupMembers.",
  ].join("\n");
}

type ReplyStreamPayload = {
  text?: string;
};

type ReplyChunkInfo = {
  kind?: string;
};

/**
 * Download DingTalk media file via runtime media service (sandbox-compatible).
 * Files are stored in the global media inbound directory.
 */
export async function downloadMedia(
  config: DingTalkConfig,
  downloadCode: string,
  log?: any,
): Promise<MediaFile | null> {
  const rt = getDingTalkRuntime();
  const formatAxiosErrorData = (value: unknown): string | undefined => {
    if (value === null || value === undefined) {
      return undefined;
    }
    if (Buffer.isBuffer(value)) {
      return `<buffer ${value.length} bytes>`;
    }
    if (value instanceof ArrayBuffer) {
      return `<arraybuffer ${value.byteLength} bytes>`;
    }
    if (typeof value === "string") {
      return value.length > 500 ? `${value.slice(0, 500)}…` : value;
    }
    try {
      return JSON.stringify(maskSensitiveData(value));
    } catch {
      return `[unstringifiable ${typeof value}]`;
    }
  };

  if (!downloadCode) {
    log?.error?.("[DingTalk] downloadMedia requires downloadCode to be provided.");
    return null;
  }
  if (!config.robotCode) {
    if (log?.error) {
      log.error("[DingTalk] downloadMedia requires robotCode to be configured.");
    }
    return null;
  }
  try {
    const token = await getAccessToken(config, log);
    const response = await axios.post(
      "https://api.dingtalk.com/v1.0/robot/messageFiles/download",
      { downloadCode, robotCode: config.robotCode },
      { headers: { "x-acs-dingtalk-access-token": token } },
    );
    const payload = response.data as Record<string, any>;
    const downloadUrl = payload?.downloadUrl ?? payload?.data?.downloadUrl;
    if (!downloadUrl) {
      const payloadDetail = formatAxiosErrorData(payload);
      log?.error?.(
        `[DingTalk] downloadMedia missing downloadUrl. payload=${payloadDetail ?? "unknown"}`,
      );
      return null;
    }
    const mediaResponse = await axios.get(downloadUrl, { responseType: "arraybuffer" });
    const contentType = mediaResponse.headers["content-type"] || "application/octet-stream";
    const buffer = Buffer.from(mediaResponse.data as ArrayBuffer);

    const maxBytes =
      config.mediaMaxMb && config.mediaMaxMb > 0 ? config.mediaMaxMb * 1024 * 1024 : undefined;
    const saved = maxBytes
      ? await rt.channel.media.saveMediaBuffer(buffer, contentType, "inbound", maxBytes)
      : await rt.channel.media.saveMediaBuffer(buffer, contentType, "inbound");
    log?.debug?.(`[DingTalk] Media saved: ${saved.path}`);
    return { path: saved.path, mimeType: saved.contentType ?? contentType };
  } catch (err: any) {
    if (log?.error) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const statusText = err.response?.statusText;
        const dataDetail = formatAxiosErrorData(err.response?.data);
        const code = err.code ? ` code=${err.code}` : "";
        const statusLabel = status ? ` status=${status}${statusText ? ` ${statusText}` : ""}` : "";
        log.error(
          `[DingTalk] Failed to download media:${statusLabel}${code} message=${err.message}`,
        );
        if (err.response?.data !== undefined) {
          log.error(formatDingTalkErrorPayloadLog("inbound.downloadMedia", err.response.data));
        } else if (dataDetail) {
          log.error(`[DingTalk] downloadMedia response data: ${dataDetail}`);
        }
      } else {
        log.error(`[DingTalk] Failed to download media: ${err.message}`);
      }
    }
    return null;
  }
}

export async function handleDingTalkMessage(params: HandleDingTalkMessageParams): Promise<void> {
  const { cfg, accountId, data, sessionWebhook, log, dingtalkConfig, subAgentOptions, preDownloadedMedia } = params;
  const rt = getDingTalkRuntime();

  // Save logger globally so shared services can log consistently without threading log everywhere.
  setCurrentLogger(log);

  log?.debug?.("[DingTalk] Full Inbound Data: " + JSON.stringify(maskSensitiveData(data)));

  // 1) Ignore self messages from bot.
  if (data.senderId === data.chatbotUserId || data.senderStaffId === data.chatbotUserId) {
    log?.debug?.("[DingTalk] Ignoring robot self-message");
    return;
  }

  // Shallow copy: only .text is reassigned below; nested arrays (atMentions, mediaTypes) are read-only downstream.
  const extractedContent = { ...extractMessageContent(data) };
  if (!extractedContent.text) {
    return;
  }

  // Add context hint for sub-agent mode, stripping quoted prefix to avoid protocol noise in agent context.
  if (subAgentOptions) {
    const cleanText = extractedContent.text.replace(/^\[引用[^\]]*\]\s*/, "");
    const contextHint = `[你被 @ 为"${subAgentOptions.matchedName}"]\n\n`;
    extractedContent.text = contextHint + cleanText;
  }

  const isDirect = data.conversationType === "1";
  const isGroup = !isDirect;
  const senderOriginalId = (data.senderId || "").trim();
  const senderStaffId = (data.senderStaffId || "").trim();
  const senderId = senderStaffId || senderOriginalId;
  const senderName = data.senderNick || "Unknown";
  const groupId = data.conversationId;
  const groupName = data.conversationTitle || "Group";

  // Register original peer IDs to preserve case-sensitive DingTalk conversation IDs.
  if (groupId) {
    registerPeerId(groupId);
  }

  if (
    shouldSendProactivePermissionHint({
      isDirect,
      accountId,
      senderId,
      senderOriginalId,
      senderStaffId,
      config: dingtalkConfig,
      nowMs: Date.now(),
    })
  ) {
    try {
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        "⚠️ 主动推送可能失败\n\n检测到该用户最近一次主动发送调用返回了权限或目标不可达错误。当前会话回复仍可正常使用，但定时/主动发送可能失败。\n\n建议：\n1) 在钉钉开放平台确认应用已申请并获得主动发送相关权限\n2) 确认目标用户属于当前企业并在应用可见范围内\n3) 使用相同账号进行一次主动发送验证并检查错误码详情",
        { log },
      );
    } catch (err: any) {
      log?.debug?.(`[DingTalk] Failed to send proactive permission hint: ${err.message}`);
      if (err?.response?.data !== undefined) {
        log?.debug?.(
          formatDingTalkErrorPayloadLog("inbound.proactivePermissionHint", err.response.data),
        );
      }
    }
  }
  if (senderId) {
    registerPeerId(senderId);
  }

  // 2) Authorization guard (DM/group policy).
  let commandAuthorized = true;
  if (isDirect) {
    const dmPolicy = dingtalkConfig.dmPolicy || "open";
    const allowFrom = dingtalkConfig.allowFrom || [];

    if (dmPolicy === "allowlist") {
      const normalizedAllowFrom = normalizeAllowFrom(allowFrom);
      const isAllowed = isSenderAllowed({ allow: normalizedAllowFrom, senderId });

      if (!isAllowed) {
        log?.debug?.(
          `[DingTalk] DM blocked: senderId=${senderId} not in allowlist (dmPolicy=allowlist)`,
        );
        try {
          await sendBySession(
            dingtalkConfig,
            sessionWebhook,
            `⛔ 访问受限\n\n您的用户ID：\`${senderId}\`\n\n请联系管理员将此ID添加到允许列表中。`,
            { log },
          );
        } catch (err: any) {
          log?.debug?.(`[DingTalk] Failed to send access denied message: ${err.message}`);
          if (err?.response?.data !== undefined) {
            log?.debug?.(
              formatDingTalkErrorPayloadLog("inbound.accessDeniedReply", err.response.data),
            );
          }
        }

        return;
      }

      log?.debug?.(`[DingTalk] DM authorized: senderId=${senderId} in allowlist`);
    } else if (dmPolicy === "pairing") {
      // SDK pairing flow performs actual authorization checks.
      commandAuthorized = true;
    } else {
      commandAuthorized = true;
    }
  } else {
    const groupAccess = resolveGroupAccess({
      groupPolicy: dingtalkConfig.groupPolicy || "open",
      groupId,
      senderId,
      groups: dingtalkConfig.groups,
      groupAllowFrom: dingtalkConfig.groupAllowFrom,
      allowFrom: dingtalkConfig.allowFrom,
    });

    if (groupAccess.legacyFallback) {
      log?.info?.(
        `[DingTalk] DEPRECATED: groupPolicy=allowlist is using "allowFrom" for group access control. ` +
        `Please migrate to "groups" (group ID allowlist) or "groupAllowFrom" (sender allowlist).`,
      );
    }

    if (!groupAccess.allowed) {
      if (groupAccess.reason === "disabled") {
        log?.debug?.(`[DingTalk] Group disabled: all group messages dropped (groupPolicy=disabled)`);
        return;
      }

      const denyMessage = groupAccess.reason === "sender_not_allowed"
        ? `⛔ 访问受限\n\n您的用户ID：\`${senderId}\`\n\n请联系管理员将此ID添加到群聊允许列表中。`
        : `⛔ 访问受限\n\n您的群聊ID：\`${groupId}\`\n\n请联系管理员将此ID添加到允许列表中。`;

      log?.debug?.(
        `[DingTalk] Group blocked: conversationId=${groupId} senderId=${senderId} reason=${groupAccess.reason}`,
      );

      try {
        await sendBySession(
          dingtalkConfig,
          sessionWebhook,
          denyMessage,
          { log, atUserId: senderId },
        );
      } catch (err: any) {
        log?.debug?.(`[DingTalk] Failed to send group access denied message: ${err.message}`);
        if (err?.response?.data !== undefined) {
          log?.debug?.(
            formatDingTalkErrorPayloadLog("inbound.groupAccessDeniedReply", err.response.data),
          );
        }
      }

      return;
    }

    log?.debug?.(
      `[DingTalk] Group authorized: conversationId=${groupId} senderId=${senderId}`,
    );
  }

  // Calculate account store path and session peer (for session alias feature)
  const accountStorePath = rt.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: accountId,
  });
  try {
    if (!isDirect && groupId) {
      upsertObservedGroupTarget({
        storePath: accountStorePath,
        accountId,
        conversationId: groupId,
        title: groupName,
        seenAt: data.createAt,
      });
    }
    if (senderId || senderOriginalId) {
      upsertObservedUserTarget({
        storePath: accountStorePath,
        accountId,
        senderId: senderOriginalId || senderId,
        staffId: senderStaffId || undefined,
        displayName: senderName,
        conversationId: groupId,
        seenAt: data.createAt,
      });
    }
  } catch (err) {
    log?.warn?.(
      `[DingTalk] Target directory observe failed: accountId=${accountId} groupId=${groupId || "-"} senderId=${senderOriginalId || senderId || "-"} storePath=${accountStorePath || "-"} error=${String(err)}`,
    );
  }
  const currentSessionSourceKind = isDirect ? "direct" : "group";
  const currentSessionSourceId = isDirect ? senderId : groupId;
  const peerIdOverride = getSessionPeerOverride({
    storePath: accountStorePath,
    accountId,
    sourceKind: currentSessionSourceKind,
    sourceId: currentSessionSourceId,
  });
  const sessionPeer = resolveDingTalkSessionPeer({
    isDirect,
    senderId,
    conversationId: groupId,
    peerIdOverride,
    config: dingtalkConfig,
  });

  const route = subAgentOptions
    ? {
        agentId: subAgentOptions.agentId,
        sessionKey: buildAgentSessionKey({
          rt,
          cfg,
          accountId,
          agentId: subAgentOptions.agentId,
          peerKind: sessionPeer.kind,
          peerId: sessionPeer.peerId,
        }),
        mainSessionKey: "",
      }
    : rt.channel.routing.resolveAgentRoute({
        cfg,
        channel: "dingtalk",
        accountId,
        peer: { kind: sessionPeer.kind, id: sessionPeer.peerId },
      });

  // @Sub-Agent routing: resolve @mentions to agents (skip in recursive sub-agent calls)
  if (!subAgentOptions) {
    const subAgentRoute = await resolveSubAgentRoute({
      extractedContent,
      cfg,
      isGroup,
      dingtalkConfig,
      sessionWebhook,
      senderId,
      log,
    });
    if (subAgentRoute) {
      await dispatchSubAgents({
        ...subAgentRoute,
        cfg,
        accountId,
        data,
        dingtalkConfig,
        sessionWebhook,
        extractedContent,
        handleMessage: handleDingTalkMessage,
        downloadMedia,
        log,
      });
      return;
    }
  }

  // Route resolved before media download for session context and routing metadata.
  const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  const to = isDirect ? senderId : groupId;
  const parsedLearnCommand = parseLearnCommand(extractedContent.text);
  const parsedSessionCommand = parseSessionCommand(extractedContent.text);
  const parsedSummaryCommand = parseSummaryCommand(extractedContent.text);
  const isOwner = isLearningOwner({
    cfg,
    config: dingtalkConfig,
    senderId,
    rawSenderId: data.senderId,
  });
  if (isDirect && parsedLearnCommand.scope === "whoami") {
    await sendBySession(
      dingtalkConfig,
      sessionWebhook,
      formatWhoAmIReply({
        senderId,
        rawSenderId: data.senderId,
        senderStaffId: data.senderStaffId,
        isOwner,
      }),
      { log },
    );
    return;
  }
  if (parsedLearnCommand.scope === "whereami") {
    await sendBySession(
      dingtalkConfig,
      sessionWebhook,
      formatWhereAmIReply({
        conversationId: data.conversationId,
        conversationType: isDirect ? "dm" : "group",
        peerId: sessionPeer.peerId,
      }),
      { log },
    );
    return;
  }
  if (isDirect && parsedLearnCommand.scope === "owner-status") {
    await sendBySession(
      dingtalkConfig,
      sessionWebhook,
      formatOwnerStatusReply({
        senderId,
        rawSenderId: data.senderId,
        isOwner,
      }),
      { log },
    );
    return;
  }
  if (parsedLearnCommand.scope === "help") {
    await sendBySession(dingtalkConfig, sessionWebhook, formatLearnCommandHelp(), { log });
    return;
  }
  if (parsedSummaryCommand.scope === "summary" && !isOwner) {
    await sendBySession(dingtalkConfig, sessionWebhook, formatOwnerOnlyDeniedReply(), { log });
    return;
  }
  if (
    (parsedLearnCommand.scope === "global" ||
      parsedLearnCommand.scope === "session" ||
      parsedLearnCommand.scope === "here" ||
      parsedLearnCommand.scope === "target" ||
      parsedLearnCommand.scope === "targets" ||
      parsedLearnCommand.scope === "list" ||
      parsedLearnCommand.scope === "disable" ||
      parsedLearnCommand.scope === "delete" ||
      parsedLearnCommand.scope === "target-set-create" ||
      parsedLearnCommand.scope === "target-set-apply" ||
      parsedSessionCommand.scope === "session-alias-show" ||
      parsedSessionCommand.scope === "session-alias-set" ||
      parsedSessionCommand.scope === "session-alias-clear" ||
      parsedSessionCommand.scope === "session-alias-bind" ||
      parsedSessionCommand.scope === "session-alias-unbind") &&
    !isOwner
  ) {
    await sendBySession(dingtalkConfig, sessionWebhook, formatOwnerOnlyDeniedReply(), { log });
    return;
  }
  if (isOwner) {
    if (isSummaryCommandText(extractedContent.text) && parsedSummaryCommand.scope === "unknown") {
      await sendBySession(dingtalkConfig, sessionWebhook, formatSummaryCommandHelp(), { log });
      return;
    }
    if (parsedSummaryCommand.scope === "summary") {
      const conversationIds = parsedSummaryCommand.useCurrentConversation
        ? [to]
        : parsedSummaryCommand.conversationIds;
      const mentionNames = resolveSummaryMentionNames(parsedSummaryCommand.mentionNames, senderName);
      const summaryReply = await generateSummaryNarrative({
        rt,
        cfg,
        accountId,
        senderId,
        senderName,
        to,
        routeSessionKey: route.sessionKey,
        conversationLabel: isDirect ? `${senderName} (${senderId})` : `${groupName} - ${senderName}`,
        chatType: isDirect ? "direct" : "group",
        storePath: accountStorePath,
        chatTypeFilter: parsedSummaryCommand.chatType,
        conversationIds,
        senderIds: parsedSummaryCommand.senderIds,
        mentionNames,
        sinceTs: parsedSummaryCommand.sinceTs,
        windowLabel: parsedSummaryCommand.windowLabel,
      });
      await sendBySession(dingtalkConfig, sessionWebhook, summaryReply, { log });
      return;
    }
    if (parsedSessionCommand.scope === "session-alias-show") {
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatSessionAliasReply({
          sourceKind: currentSessionSourceKind,
          sourceId: currentSessionSourceId,
          peerId: sessionPeer.peerId,
          aliasSource: peerIdOverride ? "override" : "default",
        }),
        { log },
      );
      return;
    }
    if (parsedSessionCommand.scope === "session-alias-set" && parsedSessionCommand.peerId) {
      const aliasValidationError = validateSessionAlias(parsedSessionCommand.peerId);
      if (aliasValidationError) {
        await sendBySession(
          dingtalkConfig,
          sessionWebhook,
          formatSessionAliasValidationErrorReply(aliasValidationError),
          { log },
        );
        return;
      }
      setSessionPeerOverride({
        storePath: accountStorePath,
        accountId,
        sourceKind: currentSessionSourceKind,
        sourceId: currentSessionSourceId,
        peerId: parsedSessionCommand.peerId,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatSessionAliasSetReply({
          sourceKind: currentSessionSourceKind,
          sourceId: currentSessionSourceId,
          peerId: parsedSessionCommand.peerId,
        }),
        { log },
      );
      return;
    }
    if (parsedSessionCommand.scope === "session-alias-clear") {
      clearSessionPeerOverride({
        storePath: accountStorePath,
        accountId,
        sourceKind: currentSessionSourceKind,
        sourceId: currentSessionSourceId,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatSessionAliasClearedReply({
          sourceKind: currentSessionSourceKind,
          sourceId: currentSessionSourceId,
        }),
        { log },
      );
      return;
    }
    if (
      parsedSessionCommand.scope === "session-alias-bind" &&
      parsedSessionCommand.sourceKind &&
      parsedSessionCommand.sourceId &&
      parsedSessionCommand.peerId
    ) {
      const aliasValidationError = validateSessionAlias(parsedSessionCommand.peerId);
      if (aliasValidationError) {
        await sendBySession(
          dingtalkConfig,
          sessionWebhook,
          formatSessionAliasValidationErrorReply(aliasValidationError),
          { log },
        );
        return;
      }
      setSessionPeerOverride({
        storePath: accountStorePath,
        accountId,
        sourceKind: parsedSessionCommand.sourceKind,
        sourceId: parsedSessionCommand.sourceId,
        peerId: parsedSessionCommand.peerId,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatSessionAliasBoundReply({
          sourceKind: parsedSessionCommand.sourceKind,
          sourceId: parsedSessionCommand.sourceId,
          peerId: parsedSessionCommand.peerId,
        }),
        { log },
      );
      return;
    }
    if (
      parsedSessionCommand.scope === "session-alias-unbind" &&
      parsedSessionCommand.sourceKind &&
      parsedSessionCommand.sourceId
    ) {
      const existed = clearSessionPeerOverride({
        storePath: accountStorePath,
        accountId,
        sourceKind: parsedSessionCommand.sourceKind,
        sourceId: parsedSessionCommand.sourceId,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatSessionAliasUnboundReply({
          sourceKind: parsedSessionCommand.sourceKind,
          sourceId: parsedSessionCommand.sourceId,
          existed,
        }),
        { log },
      );
      return;
    }
    if (parsedLearnCommand.scope === "global" && parsedLearnCommand.instruction) {
      const applied = applyManualGlobalLearningRule({
        storePath: accountStorePath,
        accountId,
        instruction: parsedLearnCommand.instruction,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatLearnAppliedReply({
          scope: "global",
          instruction: parsedLearnCommand.instruction,
          ruleId: applied?.ruleId,
        }),
        { log },
      );
      return;
    }
    if (parsedLearnCommand.scope === "session" && parsedLearnCommand.instruction) {
      applyManualSessionLearningNote({
        storePath: accountStorePath,
        accountId,
        targetId: data.conversationId,
        instruction: parsedLearnCommand.instruction,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatLearnAppliedReply({
          scope: "session",
          instruction: parsedLearnCommand.instruction,
        }),
        { log },
      );
      return;
    }
    if (parsedLearnCommand.scope === "here" && parsedLearnCommand.instruction) {
      const applied = applyManualTargetLearningRule({
        storePath: accountStorePath,
        accountId,
        targetId: data.conversationId,
        instruction: parsedLearnCommand.instruction,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatLearnAppliedReply({
          scope: "target",
          targetId: data.conversationId,
          instruction: parsedLearnCommand.instruction,
          ruleId: applied?.ruleId,
        }),
        { log },
      );
      return;
    }
    if (
      parsedLearnCommand.scope === "target" &&
      parsedLearnCommand.targetId &&
      parsedLearnCommand.instruction
    ) {
      const applied = applyManualTargetLearningRule({
        storePath: accountStorePath,
        accountId,
        targetId: parsedLearnCommand.targetId,
        instruction: parsedLearnCommand.instruction,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatLearnAppliedReply({
          scope: "target",
          targetId: parsedLearnCommand.targetId,
          instruction: parsedLearnCommand.instruction,
          ruleId: applied?.ruleId,
        }),
        { log },
      );
      return;
    }
    if (
      parsedLearnCommand.scope === "targets" &&
      parsedLearnCommand.targetIds?.length &&
      parsedLearnCommand.instruction
    ) {
      const applied = applyManualTargetsLearningRule({
        storePath: accountStorePath,
        accountId,
        targetIds: parsedLearnCommand.targetIds,
        instruction: parsedLearnCommand.instruction,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatLearnAppliedReply({
          scope: "targets",
          targetIds: parsedLearnCommand.targetIds,
          instruction: parsedLearnCommand.instruction,
          ruleId: applied[0]?.ruleId,
        }),
        { log },
      );
      return;
    }
    if (
      parsedLearnCommand.scope === "target-set-create" &&
      parsedLearnCommand.setName &&
      parsedLearnCommand.targetIds?.length
    ) {
      const saved = createOrUpdateTargetSet({
        storePath: accountStorePath,
        accountId,
        name: parsedLearnCommand.setName,
        targetIds: parsedLearnCommand.targetIds,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        saved
          ? formatTargetSetSavedReply({
              setName: parsedLearnCommand.setName,
              targetIds: parsedLearnCommand.targetIds,
            })
          : "目标组保存失败，请检查名称和目标列表。",
        { log },
      );
      return;
    }
    if (
      parsedLearnCommand.scope === "target-set-apply" &&
      parsedLearnCommand.setName &&
      parsedLearnCommand.instruction
    ) {
      const applied = applyTargetSetLearningRule({
        storePath: accountStorePath,
        accountId,
        name: parsedLearnCommand.setName,
        instruction: parsedLearnCommand.instruction,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        applied.length > 0
          ? formatLearnAppliedReply({
              scope: "target-set",
              setName: parsedLearnCommand.setName,
              targetIds: applied.map((item) => item.targetId),
              instruction: parsedLearnCommand.instruction,
              ruleId: applied[0]?.ruleId,
            })
          : `未找到目标组 \`${parsedLearnCommand.setName}\`，或该目标组为空。`,
        { log },
      );
      return;
    }
    if (parsedLearnCommand.scope === "list") {
      const rules = listScopedLearningRules({ storePath: accountStorePath, accountId })
        .slice(0, 20)
        .map((rule) => {
          const scope = rule.scope === "target" ? `target(${rule.targetId})` : "global";
          const status = rule.enabled ? "enabled" : "disabled";
          return `- [${scope}] ${rule.ruleId} (${status}) => ${rule.instruction}`;
        });
      const targetSets = listLearningTargetSets({ storePath: accountStorePath, accountId })
        .slice(0, 10)
        .map(
          (targetSet) => `- [target-set] ${targetSet.name} => ${targetSet.targetIds.join(", ")}`,
        );
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatLearnListReply([...rules, ...targetSets]),
        { log },
      );
      return;
    }
    if (parsedLearnCommand.scope === "disable" && parsedLearnCommand.ruleId) {
      const result = disableManualRule({
        storePath: accountStorePath,
        accountId,
        ruleId: parsedLearnCommand.ruleId,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatLearnDisabledReply({
          ruleId: parsedLearnCommand.ruleId,
          existed: result.existed,
          scope: result.scope,
          targetId: result.targetId,
        }),
        { log },
      );
      return;
    }
    if (parsedLearnCommand.scope === "delete" && parsedLearnCommand.ruleId) {
      const result = deleteManualRule({
        storePath: accountStorePath,
        accountId,
        ruleId: parsedLearnCommand.ruleId,
      });
      await sendBySession(
        dingtalkConfig,
        sessionWebhook,
        formatLearnDeletedReply({
          ruleId: parsedLearnCommand.ruleId,
          existed: result.existed,
          scope: result.scope,
          targetId: result.targetId,
        }),
        { log },
      );
      return;
    }
  }
  const manualForcedReply = resolveManualForcedReply({
    storePath: accountStorePath,
    accountId,
    targetId: data.conversationId,
    content: extractedContent,
  });
  if (manualForcedReply) {
    await sendBySession(dingtalkConfig, sessionWebhook, manualForcedReply, { log });
    return;
  }
  // 3) Select response mode (card vs markdown).
  // Card creation runs BEFORE media download so the user sees immediate visual
  // feedback while large files are still being downloaded.
  let useCardMode = dingtalkConfig.messageType === "card";
  let currentAICard = undefined;

  if (useCardMode) {
    try {
      log?.debug?.(
        `[DingTalk][AICard] conversationType=${data.conversationType}, conversationId=${to}`,
      );
      const aiCard = await createAICard(dingtalkConfig, to, log, {
        accountId,
        storePath: accountStorePath,
        contextConversationId: groupId,
      });
      if (aiCard) {
        currentAICard = aiCard;
      } else {
        useCardMode = false;
        log?.warn?.(
          "[DingTalk] Failed to create AI card (returned null), fallback to text/markdown.",
        );
      }
    } catch (err: any) {
      useCardMode = false;
      log?.warn?.(
        `[DingTalk] Failed to create AI card: ${err.message}, fallback to text/markdown.`,
      );
    }
  }

  const journalTTLDays = dingtalkConfig.journalTTLDays ?? DEFAULT_MESSAGE_CONTEXT_TTL_DAYS;
  const quotedRef = buildInboundQuotedRef(data, extractedContent);
  const replyQuotedRef = createReplyQuotedRef(data.msgId);
  const content = extractedContent;
  const hasLegacyQuoteContent =
    typeof data.content?.quoteContent === "string" && data.content.quoteContent.trim().length > 0;

  if (hasLegacyQuoteContent && !quotedRef) {
    log?.debug?.(
      `[DingTalk] Legacy quoteContent present without resolvable quotedRef: ` +
        `conversationType=${data.conversationType} conversationId=${data.conversationId} ` +
        `msgId=${data.msgId} originalMsgId=${data.originalMsgId || "(none)"}`,
    );
  }
  if (quotedRef) {
    log?.debug?.(
      `[DingTalk][QuotedRef] Built inbound quotedRef msgId=${data.msgId} scope=${groupId} ` +
        `quotedRef=${JSON.stringify(quotedRef)}`,
    );
  } else if (
    data.text?.isReplyMsg ||
    data.originalMsgId ||
    data.originalProcessQueryKey ||
    content.quoted
  ) {
    log?.debug?.(
      `[DingTalk][QuotedRef] Reply metadata present without resolvable quotedRef ` +
        `msgId=${data.msgId} scope=${groupId} originalMsgId=${data.originalMsgId || "(none)"} ` +
        `originalProcessQueryKey=${data.originalProcessQueryKey || "(none)"}`,
    );
  }

  try {
    upsertInboundMessageContext({
      storePath: accountStorePath,
      accountId,
      conversationId: groupId,
      msgId: data.msgId,
      messageType: content.messageType,
      text: content.text,
      quotedRef,
      senderId,
      senderName,
      mentions: content.atMentions?.map((mention) => mention.name),
      chatType: isDirect ? "direct" : "group",
      quotedMessageId: content.quoted?.msgId,
      createdAt: data.createAt,
      ttlMs: ttlDaysToMs(journalTTLDays),
      ttlReferenceMs: data.createAt,
      cleanupCreatedAtTtlDays: journalTTLDays,
      topic: null,
    });
  } catch (err) {
    log?.warn?.(`[DingTalk] Message context inbound append failed: ${String(err)}`);
  }

  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  let attachmentContextMsgId = data.msgId;
  let attachmentContextCreatedAt = data.createAt;
  let attachmentContextMessageType = content.messageType;
  let attachmentContextFileName = data.content?.fileName;

  // Use pre-downloaded media if available (from sub-agent outer call)
  if (preDownloadedMedia?.mediaPath) {
    mediaPath = preDownloadedMedia.mediaPath;
    mediaType = preDownloadedMedia.mediaType;
  } else if (content.mediaPath && dingtalkConfig.robotCode) {
    // Download media only if not pre-downloaded
    const media = await downloadMedia(dingtalkConfig, content.mediaPath, log);
    if (media) {
      mediaPath = media.path;
      mediaType = media.mimeType;
    }
  }

  // Cache downloadCode (+ spaceId/fileId) for quoted file lookups (DM + group).
  if (content.mediaPath && data.msgId) {
    upsertInboundMessageContext({
      storePath: accountStorePath,
      accountId,
      conversationId: data.conversationId,
      msgId: data.msgId,
      createdAt: data.createAt,
      messageType: content.messageType,
      media: {
        downloadCode: content.mediaPath,
        spaceId: data.content?.spaceId,
        fileId: data.content?.fileId,
      },
      ttlMs: DEFAULT_MEDIA_CONTEXT_TTL_MS,
      topic: null,
    });
  }

  // User-sent DingTalk doc / Drive file card: cache msgId -> {spaceId,fileId}
  // during the original message turn, and try downloading immediately in DM.
  if (
    content.messageType === "interactiveCardFile" &&
    data.msgId &&
    content.docSpaceId &&
    content.docFileId
  ) {
    upsertInboundMessageContext({
      storePath: accountStorePath,
      accountId,
      conversationId: data.conversationId,
      msgId: data.msgId,
      createdAt: data.createAt,
      messageType: content.messageType,
      media: {
        spaceId: content.docSpaceId,
        fileId: content.docFileId,
      },
      ttlMs: DEFAULT_MEDIA_CONTEXT_TTL_MS,
      topic: null,
    });

    if (!mediaPath && isDirect && data.senderStaffId) {
      try {
        const unionId = await getUnionIdByStaffId(dingtalkConfig, data.senderStaffId, log);
        const docMedia = await downloadGroupFile(
          dingtalkConfig,
          content.docSpaceId,
          content.docFileId,
          unionId,
          log,
        );
        if (docMedia) {
          mediaPath = docMedia.path;
          mediaType = docMedia.mimeType;
        }
      } catch (err: any) {
        log?.warn?.(`[DingTalk] Doc card download failed: ${err.message}`);
      }
    }
  }

  const quotedRecord = resolveQuotedRecord({
    storePath: accountStorePath,
    accountId,
    conversationId: data.conversationId,
    quotedRef,
    log,
  });
  const quotedRuntimeContext = resolveQuotedRuntimeContext({
    storePath: accountStorePath,
    accountId,
    conversationId: data.conversationId,
    quotedRef,
    firstRecord: quotedRecord,
    firstPreview:
      content.quoted?.previewText ||
      content.quoted?.previewMessageType
        ? {
            text: content.quoted.previewText,
            messageType: content.quoted.previewMessageType,
            senderId: content.quoted.previewSenderId,
          }
        : undefined,
    log,
  });

  // Try downloading a quoted file from cached downloadCode/spaceId+fileId.
  const tryDownloadFromRecord = async (
    record: {
      msgId?: string;
      media?: {
        downloadCode?: string;
        spaceId?: string;
        fileId?: string;
      };
    } | null,
  ): Promise<MediaFile | null> => {
    if (!record?.media) {
      return null;
    }
    let media: MediaFile | null = null;
    if (record.media.downloadCode) {
      media = await downloadMedia(dingtalkConfig, record.media.downloadCode, log);
      if (media) {
        log?.debug?.(
          `[DingTalk][QuotedRef] Recovered quoted media from cached downloadCode ` +
            `recordMsgId=${record.msgId || "(none)"} scope=${data.conversationId}`,
        );
      }
    }
    if (!media && record.media.spaceId && record.media.fileId && data.senderStaffId) {
      try {
        const unionId = await getUnionIdByStaffId(dingtalkConfig, data.senderStaffId, log);
        media = await downloadGroupFile(
          dingtalkConfig,
          record.media.spaceId,
          record.media.fileId,
          unionId,
          log,
        );
        if (media) {
          log?.debug?.(
            `[DingTalk][QuotedRef] Recovered quoted media from cached spaceId/fileId ` +
              `recordMsgId=${record.msgId || "(none)"} scope=${data.conversationId}`,
          );
        }
      } catch (err: any) {
        log?.warn?.(`[DingTalk] spaceId+fileId fallback failed: ${err.message}`);
      }
    }
    return media;
  };

  // Quoted picture: download via existing downloadMedia.
  if (!mediaPath && content.quoted?.mediaDownloadCode && dingtalkConfig.robotCode) {
    const media =
      (await tryDownloadFromRecord(quotedRecord)) ||
      (await downloadMedia(dingtalkConfig, content.quoted.mediaDownloadCode, log));
    if (media) {
      if (!quotedRecord) {
        log?.debug?.(
          `[DingTalk][QuotedRef] Recovered quoted image from inbound downloadCode fallback scope=${data.conversationId}`,
        );
      }
      mediaPath = media.path;
      mediaType = media.mimeType;
      attachmentContextMsgId = quotedRecord?.msgId || content.quoted.msgId || data.msgId;
      attachmentContextCreatedAt = quotedRecord?.createdAt || data.createAt;
      attachmentContextMessageType = quotedRecord?.messageType || content.quoted.previewMessageType || "picture";
      attachmentContextFileName = content.quoted.previewFileName;
    } else {
      content.text = `[引用了一张图片，但下载失败]\n\n${content.text}`;
    }
  }

  // Quoted file/video/audio (unknownMsgType): cache-first, then group file API fallback.
  if (!mediaPath && content.quoted?.isQuotedFile) {
    let fileResolved = false;

    // Step 1: Prefer quotedRef-backed record lookup, then msgId-based cache.
    const cachedMedia = await tryDownloadFromRecord(quotedRecord);
    if (cachedMedia) {
      mediaPath = cachedMedia.path;
      mediaType = cachedMedia.mimeType;
      attachmentContextMsgId = quotedRecord?.msgId || content.quoted.msgId || data.msgId;
      attachmentContextCreatedAt = quotedRecord?.createdAt || content.quoted.fileCreatedAt || data.createAt;
      attachmentContextMessageType = quotedRecord?.messageType || "file";
      attachmentContextFileName = quotedRecord?.attachmentFileName || content.quoted.previewFileName;
      fileResolved = true;
    }

    // Step 2 (group only): Cache miss → fall back to group file API time-based matching.
    if (!fileResolved && !isDirect) {
      const resolved = await resolveQuotedFile(
        dingtalkConfig,
        {
          openConversationId: data.conversationId,
          senderStaffId: data.senderStaffId,
          fileCreatedAt: content.quoted.fileCreatedAt,
        },
        log,
      );
      if (resolved) {
        mediaPath = resolved.media.path;
        mediaType = resolved.media.mimeType;
        attachmentContextMsgId = content.quoted.msgId || data.msgId;
        attachmentContextCreatedAt = content.quoted.fileCreatedAt || data.createAt;
        attachmentContextMessageType = "file";
        attachmentContextFileName = resolved.name || content.quoted.previewFileName;
        fileResolved = true;
        log?.debug?.(
          `[DingTalk][QuotedRef] Recovered quoted file from group file fallback ` +
            `scope=${data.conversationId} quotedMsgId=${content.quoted.msgId || "(none)"}`,
        );
        if (content.quoted.msgId) {
          upsertInboundMessageContext({
            storePath: accountStorePath,
            accountId,
            conversationId: data.conversationId,
            msgId: content.quoted.msgId,
            createdAt: content.quoted.fileCreatedAt || Date.now(),
            messageType: "file",
            media: {
              spaceId: resolved.spaceId,
              fileId: resolved.fileId,
            },
            attachmentFileName: resolved.name,
            ttlMs: DEFAULT_MEDIA_CONTEXT_TTL_MS,
            topic: null,
          });
        }
      }
    }

    if (!fileResolved) {
      log?.warn?.(
        `[DingTalk] Quoted file unresolved: conversationType=${data.conversationType} conversationId=${data.conversationId} quotedMsgId=${content.quoted.msgId || "(none)"}`,
      );
      const hint = isDirect
        ? "[引用了一个文件，内容无法自动获取，请直接发送该文件]\n\n"
        : "[引用了一个文件，但无法获取内容]\n\n";
      content.text = `${hint}${content.text}`;
    }
  }

  // Quoted DingTalk doc / Drive file card:
  // 1) Prefer msgId-based cached metadata captured when the original doc card
  //    message was seen.
  // 2) In group chats, if the bot never saw the original doc card message,
  //    reuse the same group-file fallback chain as ordinary quoted files.
  if (!mediaPath && content.quoted?.isQuotedDocCard) {
    let docResolved = false;

    const cachedDocMedia = await tryDownloadFromRecord(quotedRecord);
    if (cachedDocMedia) {
      mediaPath = cachedDocMedia.path;
      mediaType = cachedDocMedia.mimeType;
      attachmentContextMsgId = quotedRecord?.msgId || content.quoted.msgId || data.msgId;
      attachmentContextCreatedAt = quotedRecord?.createdAt || content.quoted.fileCreatedAt || data.createAt;
      attachmentContextMessageType =
        quotedRecord?.messageType || content.quoted.previewMessageType || "interactiveCardFile";
      attachmentContextFileName = quotedRecord?.attachmentFileName || content.quoted.previewFileName;
      docResolved = true;
    }

    if (!docResolved && !isDirect && content.quoted.fileCreatedAt) {
      const resolved = await resolveQuotedFile(
        dingtalkConfig,
        {
          openConversationId: data.conversationId,
          senderStaffId: data.senderStaffId,
          fileCreatedAt: content.quoted.fileCreatedAt,
        },
        log,
      );
      if (resolved) {
        mediaPath = resolved.media.path;
        mediaType = resolved.media.mimeType;
        attachmentContextMsgId = content.quoted.msgId || data.msgId;
        attachmentContextCreatedAt = content.quoted.fileCreatedAt || data.createAt;
        attachmentContextMessageType = "interactiveCardFile";
        attachmentContextFileName = resolved.name || content.quoted.previewFileName;
        docResolved = true;
        log?.debug?.(
          `[DingTalk][QuotedRef] Recovered quoted doc card from group file fallback ` +
            `scope=${data.conversationId} quotedMsgId=${content.quoted.msgId || "(none)"}`,
        );
        if (content.quoted.msgId) {
          upsertInboundMessageContext({
            storePath: accountStorePath,
            accountId,
            conversationId: data.conversationId,
            msgId: content.quoted.msgId,
            createdAt: content.quoted.fileCreatedAt || Date.now(),
            messageType: "interactiveCardFile",
            media: {
              spaceId: resolved.spaceId,
              fileId: resolved.fileId,
            },
            attachmentFileName: resolved.name,
            ttlMs: DEFAULT_MEDIA_CONTEXT_TTL_MS,
            topic: null,
          });
        }
      }
    }

    if (!docResolved) {
      log?.warn?.(
        `[DingTalk] Quoted doc card unresolved: conversationType=${data.conversationType} conversationId=${data.conversationId} quotedMsgId=${content.quoted.msgId || "(none)"}`,
      );
      const hint = isDirect
        ? "[引用了钉钉文档，内容无法自动获取，请直接发送该文档]\n\n"
        : "[引用了钉钉文档，但无法获取内容]\n\n";
      content.text = `${hint}${content.text}`;
    }
  }

  if (mediaPath) {
    try {
      const extracted = await extractAttachmentText({
        path: mediaPath,
        mimeType: mediaType,
        fileName: attachmentContextFileName || data.content?.fileName,
      });
      if (extracted?.text) {
        upsertInboundMessageContext({
          storePath: accountStorePath,
          accountId,
          conversationId: data.conversationId,
          msgId: attachmentContextMsgId,
          createdAt: attachmentContextCreatedAt,
          messageType: attachmentContextMessageType,
          attachmentText: extracted.text,
          attachmentTextSource: extracted.sourceType,
          attachmentTextTruncated: extracted.truncated,
          attachmentFileName: attachmentContextFileName,
          ttlMs: ttlDaysToMs(journalTTLDays),
          topic: null,
        });
      }
    } catch (err: any) {
      log?.warn?.(`[DingTalk] Failed to extract attachment text: ${err.message}`);
    }
  }

  const inboundBody =
    mediaPath && /<media:[^>]+>/.test(content.text)
      ? `${content.text}\n[media_path: ${mediaPath}]\n[media_type: ${mediaType || "unknown"}]`
      : content.text;
  const inboundText = inboundBody;
  const learningEnabled = isFeedbackLearningEnabled(dingtalkConfig);
  const learningContextBlock = buildLearningContextBlock({
    enabled: learningEnabled,
    storePath: accountStorePath,
    accountId,
    targetId: data.conversationId,
    content,
  });
  const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = rt.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const groupConfig = !isDirect ? resolveGroupConfig(dingtalkConfig, groupId) : undefined;
  // GroupSystemPrompt is injected every turn (not only first-turn intro).
  const groupSystemPromptParts = !isDirect
    ? [
        buildGroupTurnContextPrompt({
          conversationId: groupId,
          senderDingtalkId: senderId,
          senderName,
        }),
        groupConfig?.systemPrompt?.trim(),
      ]
    : [];
  const extraSystemPrompt =
    [...groupSystemPromptParts, learningContextBlock].filter(Boolean).join("\n\n") || undefined;

  if (!isDirect) {
    noteGroupMember(storePath, groupId, senderId, senderName);
  }
  const groupMembers = !isDirect ? formatGroupMembers(storePath, groupId) : undefined;

  const fromLabel = isDirect ? `${senderName} (${senderId})` : `${groupName} - ${senderName}`;
  const body = rt.channel.reply.formatInboundEnvelope({
    channel: "DingTalk",
    from: fromLabel,
    timestamp: data.createAt,
    body: inboundText,
    chatType: isDirect ? "direct" : "group",
    sender: { name: senderName, id: senderId },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: inboundText,
    CommandBody: inboundText,
    QuotedRef: quotedRef,
    QuotedRefJson: quotedRef ? JSON.stringify(quotedRef) : undefined,
    ReplyToId: quotedRuntimeContext?.replyToId,
    ReplyToBody: quotedRuntimeContext?.replyToBody,
    ReplyToSender: quotedRuntimeContext?.replyToSender,
    ReplyToIsQuote: quotedRuntimeContext?.replyToIsQuote,
    UntrustedContext: quotedRuntimeContext?.untrustedContext
      ? [quotedRuntimeContext.untrustedContext]
      : undefined,
    From: to,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: isDirect ? "direct" : "group",
    ConversationLabel: fromLabel,
    GroupSubject: isDirect ? undefined : groupName,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "dingtalk",
    Surface: "dingtalk",
    MessageSid: data.msgId,
    Timestamp: data.createAt,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    GroupMembers: groupMembers,
    GroupSystemPrompt: extraSystemPrompt,
    GroupChannel: isDirect ? undefined : route.sessionKey,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "dingtalk",
    OriginatingTo: to,
  });

  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey || route.sessionKey,
    ctx,
    updateLastRoute: (() => {
      if (!isDirect) {
        return undefined;
      }
      const pinnedMainDmOwner = resolvePinnedMainDmOwner({
        dmScope: cfg.session?.dmScope,
        allowFrom: dingtalkConfig.allowFrom,
      });
      const senderRecipient = (senderOriginalId || senderId || "").trim().toLowerCase();
      if (
        pinnedMainDmOwner
        && senderRecipient
        && pinnedMainDmOwner.trim().toLowerCase() !== senderRecipient
      ) {
        log?.debug?.(
          `[DingTalk] Skipping main-session last route update for ${senderRecipient} (pinned owner ${pinnedMainDmOwner})`,
        );
        return undefined;
      }
      return { sessionKey: route.mainSessionKey, channel: "dingtalk", to, accountId };
    })(),
    onRecordError: (err: unknown) => {
      log?.error?.(`[DingTalk] Failed to record inbound session: ${String(err)}`);
    },
  });

  log?.info?.(`[DingTalk] Inbound: from=${senderName} text="${content.text.slice(0, 50)}..."`);

  const ackReaction =
    typeof dingtalkConfig.ackReaction === "string"
      ? dingtalkConfig.ackReaction.trim()
      : resolveAckReactionSetting({
          cfg,
          accountId,
          agentId: route.agentId,
        });
  const normalizedAckReaction = ackReaction === "off" ? "" : ackReaction;
  const resolvedAckReaction =
    normalizedAckReaction === "kaomoji"
      ? classifyAckReactionEmoji(content.text).emoji
      : normalizedAckReaction === "emoji"
        ? "🤔思考中"
        : normalizedAckReaction;
  const shouldAttachAckReaction = Boolean(resolvedAckReaction);
  let ackReactionAttached = false;
  let ackReactionAttachedAt = 0;

  if (shouldAttachAckReaction) {
    ackReactionAttached = await attachNativeAckReaction(
      dingtalkConfig,
      {
        msgId: data.msgId,
        conversationId: groupId,
        reactionName: resolvedAckReaction,
      },
      log,
    );
    if (ackReactionAttached) {
      ackReactionAttachedAt = Date.now();
      log?.debug?.(
        `[DingTalk] Initial ack reaction attached mode=${normalizedAckReaction || "off"} reaction=${resolvedAckReaction}`,
      );
    }
  }

  // ---- Shared media delivery helper ----
  async function deliverMediaAttachments(urls: string[]) {
    for (const rawMediaUrl of urls) {
      const preparedMedia = await prepareMediaInput(
        rawMediaUrl,
        log,
        dingtalkConfig.mediaUrlAllowlist,
      );
      try {
        const actualMediaPath = preparedMedia.path;
        const outMediaType = resolveOutboundMediaType({
          mediaPath: actualMediaPath,
          asVoice: false,
        });
        if (sessionWebhook) {
          const sendResult = await sendMessage(dingtalkConfig, to, "", {
            sessionWebhook,
            mediaPath: actualMediaPath,
            mediaType: outMediaType,
            log,
            accountId,
            storePath: accountStorePath,
            conversationId: groupId,
            quotedRef: replyQuotedRef,
          });
          if (!sendResult.ok) {
            throw new Error(sendResult.error || "Media reply send failed");
          }
        } else {
          const sendResult = await sendProactiveMedia(
            dingtalkConfig,
            to,
            actualMediaPath,
            outMediaType,
            {
              accountId,
              log,
              storePath: accountStorePath,
              conversationId: groupId,
              chatType: isDirect ? "direct" : "group",
              quotedRef: replyQuotedRef,
            },
          );
          if (!sendResult.ok) {
            throw new Error(sendResult.error || "Media reply send failed");
          }
        }
      } finally {
        await preparedMedia.cleanup?.();
      }
    }
  }

  // ---- Extract mediaUrls from runtime payload ----
  function extractMediaUrls(payload: ReplyStreamPayload): string[] {
    const richPayload = payload as typeof payload & {
      mediaUrl?: string;
      mediaUrls?: string[];
    };
    return Array.isArray(richPayload.mediaUrls)
      ? richPayload.mediaUrls.filter((entry: unknown) => typeof entry === "string" && entry.trim())
      : richPayload.mediaUrl &&
          typeof richPayload.mediaUrl === "string" &&
          richPayload.mediaUrl.trim()
        ? [richPayload.mediaUrl]
        : [];
  }

  // Serialize dispatchReply + card finalize per session to prevent the runtime
  // from receiving concurrent dispatch calls on the same session key, which
  // causes empty replies for all but the first caller.
  // Each sub-agent call acquires its own lock since sub-agent sessions have
  // different session keys (different agentId), so no deadlock risk.
  const shouldTrackDynamicAckReaction =
    (normalizedAckReaction === "emoji" || normalizedAckReaction === "kaomoji")
    && shouldAttachAckReaction;
  const runtimeEvents = (rt as typeof rt & {
    events?: {
      onAgentEvent?: (listener: (event: unknown) => void) => (() => void);
    };
  }).events;
  const releaseSessionLock = await acquireSessionLock(route.sessionKey);
  const dynamicAckReactionController = createDynamicAckReactionController({
    enabled: shouldTrackDynamicAckReaction,
    initialReaction: resolvedAckReaction || "",
    initialAttached: ackReactionAttached,
    initialAttachedAt: ackReactionAttachedAt,
    dingtalkConfig,
    msgId: data.msgId,
    conversationId: groupId,
    sessionKey: route.sessionKey,
    log,
    runtimeEvents,
    onReactionDisposed: () => {
      ackReactionAttached = false;
    },
  });
  try {
    if (!ackReactionAttached && shouldAttachAckReaction) {
      log?.debug?.("[DingTalk] Native ack reaction unavailable; skipping fallback.");
    }

    // ---- Create reply strategy (card or markdown) ----
    const strategy = createReplyStrategy({
      config: dingtalkConfig,
      card: currentAICard,
      useCardMode: useCardMode && !!currentAICard,
      to,
      sessionWebhook,
      senderId,
      isDirect,
      accountId,
      storePath: accountStorePath,
      groupId,
      log,
      replyQuotedRef,
      deliverMedia: deliverMediaAttachments,
    });

    try {
      await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg,
        dispatcherOptions: {
          responsePrefix: subAgentOptions?.responsePrefix || "",
          deliver: async (payload: ReplyStreamPayload, info?: ReplyChunkInfo) => {
            try {
              const mediaUrls = extractMediaUrls(payload);
              await strategy.deliver({
                text: payload.text,
                mediaUrls,
                kind: (info?.kind as DeliverPayload["kind"]) || "block",
              });
            } catch (err: unknown) {
              log?.error?.(`[DingTalk] Reply failed: ${getErrorMessage(err)}`);
              const responseData = getErrorResponseData(err);
              if (responseData !== undefined) {
                log?.error?.(formatDingTalkErrorPayloadLog("inbound.replyDeliver", responseData));
              }
              throw err;
            }
          },
        },
        replyOptions: strategy.getReplyOptions(),
      });
    } catch (dispatchErr: unknown) {
      const error = dispatchErr instanceof Error ? dispatchErr : new Error(getErrorMessage(dispatchErr));
      await strategy.abort(error);
      throw dispatchErr;
    }

    await strategy.finalize();
  } finally {
    await waitForDynamicAckDispose({
      dispose: () => dynamicAckReactionController.dispose(MIN_THINKING_REACTION_VISIBLE_MS),
      log,
      sessionKey: route.sessionKey,
    });
    releaseSessionLock();
  }
}
