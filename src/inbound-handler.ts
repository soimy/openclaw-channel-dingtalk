import * as fs from "node:fs";
import * as path from "node:path";
import axios from "axios";
import { normalizeAllowFrom, isSenderAllowed, isSenderGroupAllowed } from "./access-control";
import { getAccessToken } from "./auth";
import {
  cleanupCardCache,
  createAICard,
  finishAICard,
  formatContentForCard,
  getActiveCardIdByTarget,
  getCardById,
  isCardInTerminalState,
  streamAICard,
} from "./card-service";
import { resolveGroupConfig } from "./config";
import { setCurrentLogger } from "./logger-context";
import { extractMessageContent } from "./message-utils";
import { registerPeerId } from "./peer-id-registry";
import { getDingTalkRuntime } from "./runtime";
import { sendBySession, sendMessage } from "./send-service";
import type { DingTalkConfig, HandleDingTalkMessageParams, MediaFile } from "./types";
import { AICardStatus } from "./types";
import { maskSensitiveData } from "./utils";

// ============ Group Members Persistence ============

function groupMembersFilePath(storePath: string, groupId: string): string {
  const dir = path.join(path.dirname(storePath), "dingtalk-members");
  const safeId = groupId.replace(/\+/g, "-").replace(/\//g, "_");
  return path.join(dir, `${safeId}.json`);
}

function noteGroupMember(storePath: string, groupId: string, userId: string, name: string): void {
  if (!userId || !name) {
    return;
  }
  const filePath = groupMembersFilePath(storePath, groupId);
  let roster: Record<string, string> = {};
  try {
    roster = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {}
  if (roster[userId] === name) {
    return;
  }
  roster[userId] = name;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(roster, null, 2));
}

function formatGroupMembers(storePath: string, groupId: string): string | undefined {
  const filePath = groupMembersFilePath(storePath, groupId);
  let roster: Record<string, string> = {};
  try {
    roster = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
  const entries = Object.entries(roster);
  if (entries.length === 0) {
    return undefined;
  }
  return entries.map(([id, name]) => `${name} (${id})`).join(", ");
}

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
      return String(value);
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

    // Keep inbound media handling consistent with other channels.
    const saved = await rt.channel.media.saveMediaBuffer(buffer, contentType, "inbound");
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
        if (dataDetail) {
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
  const { cfg, accountId, data, sessionWebhook, log, dingtalkConfig } = params;
  const rt = getDingTalkRuntime();

  // Save logger globally so shared services can log consistently without threading log everywhere.
  setCurrentLogger(log);

  log?.debug?.("[DingTalk] Full Inbound Data:", JSON.stringify(maskSensitiveData(data)));

  // Clean up old terminal cards opportunistically on inbound traffic.
  cleanupCardCache();

  // 1) Ignore self messages from bot.
  if (data.senderId === data.chatbotUserId || data.senderStaffId === data.chatbotUserId) {
    log?.debug?.("[DingTalk] Ignoring robot self-message");
    return;
  }

  const content = extractMessageContent(data);
  if (!content.text) {
    return;
  }

  const isDirect = data.conversationType === "1";
  const senderId = data.senderStaffId || data.senderId;
  const senderName = data.senderNick || "Unknown";
  const groupId = data.conversationId;
  const groupName = data.conversationTitle || "Group";

  // Register original peer IDs to preserve case-sensitive DingTalk conversation IDs.
  if (groupId) {
    registerPeerId(groupId);
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
    const groupPolicy = dingtalkConfig.groupPolicy || "open";
    const allowFrom = dingtalkConfig.allowFrom || [];

    if (groupPolicy === "allowlist") {
      const normalizedAllowFrom = normalizeAllowFrom(allowFrom);
      const isAllowed = isSenderGroupAllowed({ allow: normalizedAllowFrom, groupId });

      if (!isAllowed) {
        log?.debug?.(
          `[DingTalk] Group blocked: conversationId=${groupId} senderId=${senderId} not in allowlist (groupPolicy=allowlist)`,
        );

        try {
          await sendBySession(
            dingtalkConfig,
            sessionWebhook,
            `⛔ 访问受限\n\n您的群聊ID：\`${groupId}\`\n\n请联系管理员将此ID添加到允许列表中。`,
            { log, atUserId: senderId },
          );
        } catch (err: any) {
          log?.debug?.(`[DingTalk] Failed to send group access denied message: ${err.message}`);
        }

        return;
      }

      log?.debug?.(
        `[DingTalk] Group authorized: conversationId=${groupId} senderId=${senderId} in allowlist`,
      );
    }
  }

  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: "dingtalk",
    accountId,
    peer: { kind: isDirect ? "direct" : "group", id: isDirect ? senderId : groupId },
  });

  // Route resolved before media download for session context and routing metadata.
  const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (content.mediaPath && dingtalkConfig.robotCode) {
    const media = await downloadMedia(dingtalkConfig, content.mediaPath, log);
    if (media) {
      mediaPath = media.path;
      mediaType = media.mimeType;
    }
  }
  const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = rt.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const groupConfig = !isDirect ? resolveGroupConfig(dingtalkConfig, groupId) : undefined;
  // GroupSystemPrompt is injected every turn (not only first-turn intro).
  const groupSystemPrompt = !isDirect
    ? [`DingTalk group context: conversationId=${groupId}`, groupConfig?.systemPrompt?.trim()]
        .filter(Boolean)
        .join("\n")
    : undefined;

  if (!isDirect) {
    noteGroupMember(storePath, groupId, senderId, senderName);
  }
  const groupMembers = !isDirect ? formatGroupMembers(storePath, groupId) : undefined;

  const fromLabel = isDirect ? `${senderName} (${senderId})` : `${groupName} - ${senderName}`;
  const body = rt.channel.reply.formatInboundEnvelope({
    channel: "DingTalk",
    from: fromLabel,
    timestamp: data.createAt,
    body: content.text,
    chatType: isDirect ? "direct" : "group",
    sender: { name: senderName, id: senderId },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const to = isDirect ? senderId : groupId;
  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: content.text,
    CommandBody: content.text,
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
    GroupSystemPrompt: groupSystemPrompt,
    GroupChannel: isDirect ? undefined : route.sessionKey,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "dingtalk",
    OriginatingTo: to,
  });

  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey || route.sessionKey,
    ctx,
    updateLastRoute: { sessionKey: route.mainSessionKey, channel: "dingtalk", to, accountId },
    onRecordError: (err: unknown) => {
      log?.error?.(`[DingTalk] Failed to record inbound session: ${String(err)}`);
    },
  });

  log?.info?.(`[DingTalk] Inbound: from=${senderName} text="${content.text.slice(0, 50)}..."`);

  // 3) Select response mode (card vs markdown).
  const useCardMode = dingtalkConfig.messageType === "card";
  let currentAICard = undefined;
  let lastCardContent = "";

  if (useCardMode) {
    const targetKey = `${accountId}:${to}`;
    const existingCardId = getActiveCardIdByTarget(targetKey);
    const existingCard = existingCardId ? getCardById(existingCardId) : undefined;

    // Reuse active non-terminal card to keep one card per conversation.
    if (existingCard && !isCardInTerminalState(existingCard.state)) {
      currentAICard = existingCard;
      log?.debug?.("[DingTalk] Reusing existing active AI card for this conversation.");
    } else {
      try {
        const aiCard = await createAICard(dingtalkConfig, to, data, accountId, log);
        if (aiCard) {
          currentAICard = aiCard;
        } else {
          log?.warn?.(
            "[DingTalk] Failed to create AI card (returned null), fallback to text/markdown.",
          );
        }
      } catch (err: any) {
        log?.warn?.(
          `[DingTalk] Failed to create AI card: ${err.message}, fallback to text/markdown.`,
        );
      }
    }
  }

  // 4) Optional "thinking..." feedback for non-card mode.
  if (dingtalkConfig.showThinking !== false) {
    try {
      const thinkingText = "🤔 思考中，请稍候...";
      if (useCardMode && currentAICard) {
        log?.debug?.("[DingTalk] AI Card in thinking state, skipping thinking message send.");
      } else {
        lastCardContent = thinkingText;
        await sendMessage(dingtalkConfig, to, thinkingText, {
          sessionWebhook,
          atUserId: !isDirect ? senderId : null,
          log,
          accountId,
        });
      }
    } catch (err: any) {
      log?.debug?.(`[DingTalk] Thinking message failed: ${err.message}`);
    }
  }

  const { queuedFinal } = await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      responsePrefix: "",
      deliver: async (payload: any, info?: { kind: string }) => {
        try {
          const textToSend = payload.markdown || payload.text;
          if (!textToSend) {
            return;
          }

          // Tool outputs are rendered into card stream as a separate formatted block.
          if (useCardMode && currentAICard && info?.kind === "tool") {
            log?.info?.(
              `[DingTalk] Tool result received, streaming to AI Card: ${textToSend.slice(0, 100)}`,
            );
            const toolText = formatContentForCard(textToSend, "tool");
            if (toolText) {
              await streamAICard(currentAICard, toolText, false, log);
              return;
            }
          }

          lastCardContent = textToSend;
          await sendMessage(dingtalkConfig, to, textToSend, {
            sessionWebhook,
            atUserId: !isDirect ? senderId : null,
            log,
            accountId,
          });
        } catch (err: any) {
          log?.error?.(`[DingTalk] Reply failed: ${err.message}`);
          throw err;
        }
      },
    },
    replyOptions: {
      // Real-time reasoning stream support for card mode.
      onReasoningStream: async (payload: any) => {
        if (!useCardMode || !currentAICard) {
          return;
        }
        const thinkingText = formatContentForCard(payload.text, "thinking");
        if (!thinkingText) {
          return;
        }
        try {
          await streamAICard(currentAICard, thinkingText, false, log);
        } catch (err: any) {
          log?.debug?.(`[DingTalk] Thinking stream update failed: ${err.message}`);
        }
      },
    },
  });

  // 5) Finalize card stream if card mode is active.
  if (useCardMode && currentAICard) {
    try {
      const isNonEmptyString = (value: any): boolean =>
        typeof value === "string" && value.trim().length > 0;

      const hasLastCardContent = isNonEmptyString(lastCardContent);
      const hasQueuedFinalString = isNonEmptyString(queuedFinal);

      if (hasLastCardContent || hasQueuedFinalString) {
        const finalContent =
          hasLastCardContent && typeof lastCardContent === "string"
            ? lastCardContent
            : typeof queuedFinal === "string"
              ? queuedFinal
              : "";
        await finishAICard(currentAICard, finalContent, log);
      } else {
        log?.debug?.(
          "[DingTalk] Skipping AI Card finalization because no textual content was produced.",
        );
        currentAICard.state = AICardStatus.FINISHED;
        currentAICard.lastUpdated = Date.now();
      }
    } catch (err: any) {
      log?.debug?.(`[DingTalk] AI Card finalization failed: ${err.message}`);
      try {
        if (currentAICard.state !== AICardStatus.FINISHED) {
          currentAICard.state = AICardStatus.FAILED;
          currentAICard.lastUpdated = Date.now();
        }
      } catch (stateErr: any) {
        log?.debug?.(`[DingTalk] Failed to update card state to FAILED: ${stateErr.message}`);
      }
    }
  }
}
