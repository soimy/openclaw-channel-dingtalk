import * as path from "node:path";
import axios from "axios";
import { getAccessToken } from "./auth";
import {
  isCardInTerminalState,
  sendProactiveCardText,
} from "./card-service";
import { resolveRobotCode, stripTargetPrefix } from "./config";
import { getLogger } from "./logger-context";
import { getVoiceDurationMs, uploadMedia as uploadMediaUtil } from "./media-utils";
import { convertMarkdownTablesToPlainText, detectMarkdownAndExtractTitle } from "./message-utils";
import {
  DEFAULT_MESSAGE_CONTEXT_TTL_DAYS,
  DEFAULT_OUTBOUND_SENDER,
  inferConversationChatType,
  upsertOutboundMessageContext,
} from "./message-context-store";
import { resolveOriginalPeerId } from "./peer-id-registry";
import {
  deleteProactiveRiskObservation,
  getProactiveRiskObservation,
  recordProactiveRiskObservation,
} from "./proactive-risk-registry";
import { formatDingTalkErrorPayloadLog, getProxyBypassOption } from "./utils";
import type { UploadMediaResult } from "./media-utils";
import type {
  AICardInstance,
  AxiosResponse,
  DingTalkConfig,
  DingTalkTrackingMetadata,
  Logger,
  ProactiveMessagePayload,
  QuotedRef,
  SendMessageOptions,
  SessionWebhookResponse,
} from "./types";

export { detectMediaTypeFromExtension } from "./media-utils";

type ProactiveTextSendResult = AxiosResponse | { tracking: DingTalkTrackingMetadata };

function isTrackingResult(result: ProactiveTextSendResult): result is { tracking: DingTalkTrackingMetadata } {
  return "tracking" in result;
}

function firstTrimmedString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function extractOutboundDeliveryMetadata(payload: unknown): {
  messageId?: string;
  processQueryKey?: string;
  outTrackId?: string;
  cardInstanceId?: string;
} {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const data = payload as Record<string, unknown>;
  const tracking =
    data.tracking && typeof data.tracking === "object"
      ? (data.tracking as Record<string, unknown>)
      : undefined;
  const messageId = firstTrimmedString(data.messageId, data.msgid, tracking?.messageId, tracking?.msgid);
  const processQueryKey = firstTrimmedString(data.processQueryKey, tracking?.processQueryKey);
  const outTrackId = firstTrimmedString(data.outTrackId, tracking?.outTrackId);
  const cardInstanceId = firstTrimmedString(data.cardInstanceId, tracking?.cardInstanceId);
  return { messageId, processQueryKey, outTrackId, cardInstanceId };
}

function persistOutboundMessageContext(params: {
  storePath?: string;
  accountId?: string;
  conversationId: string;
  text?: string;
  messageType?: string;
  createdAt?: number;
  quotedRef?: QuotedRef;
  log?: Logger;
  senderId?: string;
  senderName?: string;
  chatType?: "direct" | "group";
  delivery: {
    messageId?: string;
    processQueryKey?: string;
    outTrackId?: string;
    cardInstanceId?: string;
    kind?: "session" | "proactive-text" | "proactive-card" | "proactive-media";
  };
}): void {
  if (!params.storePath || !params.accountId) {
    return;
  }
  params.log?.debug?.(
    `[DingTalk][QuotedRef][Persist] direction=outbound scope=${params.conversationId} ` +
    `messageType=${params.messageType || "(none)"} processQueryKey=${params.delivery.processQueryKey || "(none)"} ` +
    `messageId=${params.delivery.messageId || "(none)"} quotedRef=${params.quotedRef ? JSON.stringify(params.quotedRef) : "(none)"}`,
  );
  upsertOutboundMessageContext({
    storePath: params.storePath,
    accountId: params.accountId,
    conversationId: params.conversationId,
    createdAt: params.createdAt ?? Date.now(),
    text: params.text,
    messageType: params.messageType,
    senderId: params.senderId,
    senderName: params.senderName,
    chatType: params.chatType,
    ttlMs: DEFAULT_MESSAGE_CONTEXT_TTL_DAYS * 24 * 60 * 60 * 1000,
    topic: null,
    quotedRef: params.quotedRef,
    delivery: params.delivery,
  });
}

function buildPersistedOutboundText(text: string, options: SendMessageOptions): string {
  if (text) {
    return text;
  }
  if (options.mediaPath && options.mediaType) {
    return `[media:${options.mediaType}] ${options.mediaPath}`;
  }
  return text;
}

const DINGTALK_TEXT_CHUNK_LIMIT = 3800;

function splitMarkdownChunks(text: string, limit = DINGTALK_TEXT_CHUNK_LIMIT): string[] {
  if (!text || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let buf = "";
  const lines = text.split("\n");
  let inCode = false;

  for (const line of lines) {
    const fenceCount = (line.match(/```/g) || []).length;
    if (buf.length + line.length + 1 > limit && buf.length > 0) {
      if (inCode) {
        buf += "\n```";
      }
      chunks.push(buf);
      buf = inCode ? "```\n" : "";
    }
    buf += (buf ? "\n" : "") + line;
    if (fenceCount % 2 === 1) {
      inCode = !inCode;
    }
  }
  if (buf) {
    chunks.push(buf);
  }
  return chunks;
}

function extractErrorCodeFromResponseData(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const payload = data as Record<string, unknown>;
  const code = payload.code;
  if (typeof code === "string" && code.trim()) {
    return code.trim();
  }

  const subCode = payload.subCode;
  if (typeof subCode === "string" && subCode.trim()) {
    return subCode.trim();
  }

  return null;
}

function isProactivePermissionOrScopeError(code: string | null): boolean {
  if (!code) {
    return false;
  }
  return (
    code.startsWith("Forbidden.AccessDenied") ||
    code === "invalidParameter.userIds.invalid" ||
    code === "invalidParameter.userIds.empty" ||
    code === "invalidParameter.openConversationId.invalid" ||
    code === "invalidParameter.robotCode.empty"
  );
}

/**
 * Wrapper to upload media with shared getAccessToken binding.
 */
export async function uploadMedia(
  config: DingTalkConfig,
  mediaPath: string,
  mediaType: "image" | "voice" | "video" | "file",
  log?: Logger,
  options?: { mediaLocalRoots?: string[] },
): Promise<UploadMediaResult | null> {
  return uploadMediaUtil(config, mediaPath, mediaType, getAccessToken, log, options);
}

export async function sendProactiveTextOrMarkdown(
  config: DingTalkConfig,
  target: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<ProactiveTextSendResult> {
  const log = options.log || getLogger();

  // Support group:/user: prefix and restore original case-sensitive conversationId.
  const { targetId, isExplicitUser } = stripTargetPrefix(target);
  const resolvedTarget = resolveOriginalPeerId(targetId);
  const isGroup = !isExplicitUser && resolvedTarget.startsWith("cid");
  const proactiveRisk = options.accountId
    ? getProactiveRiskObservation(options.accountId, resolvedTarget)
    : null;
  const proactiveRiskTag = proactiveRisk
    ? ` proactiveRisk=${proactiveRisk.level}:${proactiveRisk.reason}`
    : "";

  // In card mode, use card API to avoid oToMessages/batchSend permission requirement.
  const messageType = config.messageType || "markdown";
  if (messageType === "card" && config.cardTemplateId && !options.forceMarkdown) {
    log?.debug?.(
      `[DingTalk] Using card API for proactive message to user ${resolvedTarget}${proactiveRiskTag}`,
    );
    const result = await sendProactiveCardText(config, resolvedTarget, text, log);
    if (result.ok) {
      if (options.accountId) {
        deleteProactiveRiskObservation(options.accountId, resolvedTarget);
      }
      return {
        tracking: {
          processQueryKey: result.processQueryKey,
          outTrackId: result.outTrackId,
          cardInstanceId: result.cardInstanceId,
        },
      };
    }
    log?.warn?.(
      `[DingTalk] Proactive card send failed, fallback to proactive template API: ${result.error || "unknown"}`,
    );
  }

  const token = await getAccessToken(config, log);
  const url = isGroup
    ? "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
    : "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";

  const normalizedText = config.convertMarkdownTables !== false ? convertMarkdownTablesToPlainText(text) : text;
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(normalizedText, options, "OpenClaw 提醒");

  log?.debug?.(
    `[DingTalk] Sending proactive message to ${isGroup ? "group" : "user"} ${resolvedTarget} with title "${title}"${proactiveRiskTag}`,
  );

  // DingTalk proactive API uses message templates (sampleMarkdown / sampleText).
  const msgKey = useMarkdown ? "sampleMarkdown" : "sampleText";
  const msgParam = useMarkdown
    ? JSON.stringify({ title, text: normalizedText })
    : JSON.stringify({ content: normalizedText });

  const payload: ProactiveMessagePayload = {
    robotCode: resolveRobotCode(config),
    msgKey,
    msgParam,
  };

  if (isGroup) {
    payload.openConversationId = resolvedTarget;
  } else {
    payload.userIds = [resolvedTarget];
  }

  try {
    const result = await axios({
      url,
      method: "POST",
      data: payload,
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      ...getProxyBypassOption(config),
    });
    if (options.accountId) {
      deleteProactiveRiskObservation(options.accountId, resolvedTarget);
    }
    return result.data;
  } catch (err: unknown) {
    const maybeAxiosError = err as {
      response?: { status?: number; statusText?: string; data?: unknown };
      message?: string;
    };
    if (maybeAxiosError?.response) {
      const errCode = extractErrorCodeFromResponseData(maybeAxiosError.response.data);
      if (options.accountId && isProactivePermissionOrScopeError(errCode)) {
        recordProactiveRiskObservation({
          accountId: options.accountId,
          targetId: resolvedTarget,
          level: "high",
          reason: errCode || "proactive-permission-error",
          source: "proactive-api",
        });
      }
      const status = maybeAxiosError.response.status;
      const statusText = maybeAxiosError.response.statusText;
      const statusLabel = status ? ` status=${status}${statusText ? ` ${statusText}` : ""}` : "";
      log?.error?.(
        `[DingTalk] Failed to send proactive message:${statusLabel} message=${
          maybeAxiosError.message || String(err)
        }${proactiveRiskTag}`,
      );
      if (maybeAxiosError.response.data !== undefined) {
        log?.error?.(
          formatDingTalkErrorPayloadLog("send.proactiveMessage", maybeAxiosError.response.data),
        );
      }
    } else if (err instanceof Error) {
      log?.error?.(`[DingTalk] Failed to send proactive message: ${err.message}`);
    } else {
      log?.error?.(`[DingTalk] Failed to send proactive message: ${String(err)}`);
    }
    throw err;
  }
}

export async function sendProactiveMedia(
  config: DingTalkConfig,
  target: string,
  mediaPath: string,
  mediaType: "image" | "voice" | "video" | "file",
  options: SendMessageOptions & { accountId?: string } = {},
): Promise<{ ok: boolean; error?: string; data?: any; messageId?: string }> {
  const log = options.log || getLogger();

  try {
    // Upload first, then send by media_id.
    const uploadResult = await uploadMedia(config, mediaPath, mediaType, log, {
      mediaLocalRoots: options.mediaLocalRoots,
    });
    if (!uploadResult) {
      return { ok: false, error: "Failed to upload media" };
    }
    const { mediaId, buffer } = uploadResult;

    const token = await getAccessToken(config, log);
    const { targetId, isExplicitUser } = stripTargetPrefix(target);
    const resolvedTarget = resolveOriginalPeerId(targetId);
    const isGroup = !isExplicitUser && resolvedTarget.startsWith("cid");

    const dingtalkApi = "https://api.dingtalk.com";
    const url = isGroup
      ? `${dingtalkApi}/v1.0/robot/groupMessages/send`
      : `${dingtalkApi}/v1.0/robot/oToMessages/batchSend`;

    // Build DingTalk template payload by media type.
    let msgKey: string;
    let msgParam: string;

    if (mediaType === "image") {
      msgKey = "sampleImageMsg";
      msgParam = JSON.stringify({ photoURL: mediaId });
    } else if (mediaType === "voice") {
      msgKey = "sampleAudio";
      const durationMs = await getVoiceDurationMs(mediaPath, mediaType, log, { preReadBuffer: buffer });
      msgParam = JSON.stringify({ mediaId, duration: String(durationMs) });
    } else {
      // sampleVideo requires picMediaId; fallback to sampleFile for broader compatibility.
      const filename = path.basename(mediaPath);
      const defaultExt = mediaType === "video" ? "mp4" : "file";
      const ext = path.extname(mediaPath).slice(1) || defaultExt;
      msgKey = "sampleFile";
      msgParam = JSON.stringify({ mediaId, fileName: filename, fileType: ext });
    }

    const payload: ProactiveMessagePayload = {
      robotCode: resolveRobotCode(config),
      msgKey,
      msgParam,
    };

    if (isGroup) {
      payload.openConversationId = resolvedTarget;
    } else {
      payload.userIds = [resolvedTarget];
    }

    log?.debug?.(
      `[DingTalk] Sending proactive ${mediaType} message to ${isGroup ? "group" : "user"} ${resolvedTarget}`,
    );

    const result = await axios({
      url,
      method: "POST",
      data: payload,
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      ...getProxyBypassOption(config),
    });
    if (options.accountId) {
      deleteProactiveRiskObservation(options.accountId, resolvedTarget);
    }

    const delivery = extractOutboundDeliveryMetadata(result.data);
    const messageId = delivery.messageId || delivery.processQueryKey || delivery.outTrackId;
    persistOutboundMessageContext({
      storePath: options.storePath,
      accountId: options.accountId,
      conversationId: options.conversationId || resolvedTarget,
      text: `[media:${mediaType}] ${mediaPath}`,
      messageType: "outbound-proactive-media",
      quotedRef: options.quotedRef,
      log,
      ...DEFAULT_OUTBOUND_SENDER,
      chatType: inferConversationChatType(options.conversationId || resolvedTarget),
      delivery: {
        ...delivery,
        kind: "proactive-media",
      },
    });
    return { ok: true, data: result.data, messageId };
  } catch (err: any) {
    log?.error?.(`[DingTalk] Failed to send proactive media: ${err.message}`);
    const normalizedTarget = resolveOriginalPeerId(stripTargetPrefix(target).targetId);
    const proactiveRisk = options.accountId
      ? getProactiveRiskObservation(options.accountId, normalizedTarget)
      : null;
    const proactiveRiskTag = proactiveRisk
      ? ` proactiveRisk=${proactiveRisk.level}:${proactiveRisk.reason}`
      : "";
    if (axios.isAxiosError(err) && err.response) {
      const errCode = extractErrorCodeFromResponseData(err.response.data);
      if (options.accountId && isProactivePermissionOrScopeError(errCode)) {
        recordProactiveRiskObservation({
          accountId: options.accountId,
          targetId: normalizedTarget,
          level: "high",
          reason: errCode || "proactive-permission-error",
          source: "proactive-api",
        });
      }
      const status = err.response.status;
      const statusText = err.response.statusText;
      const statusLabel = status ? ` status=${status}${statusText ? ` ${statusText}` : ""}` : "";
      log?.error?.(`[DingTalk] Proactive media response${statusLabel}${proactiveRiskTag}`);
      log?.error?.(formatDingTalkErrorPayloadLog("send.proactiveMedia", err.response.data));
    }

    // Fallback: ensure user still gets a usable link/path text.
    const fallbackDisplayText = `📎 媒体发送失败，兜底链接/路径：${mediaPath}`;
    const fallbackPersistedText = `媒体发送失败，兜底链接/路径：${mediaPath}`;
    const fallback = await sendProactiveTextOrMarkdown(
      config,
      target,
      fallbackDisplayText,
      options,
    ).catch((fallbackErr: any) => ({ __fallbackError: fallbackErr }));

    if ((fallback as any)?.__fallbackError) {
      return { ok: false, error: `${err.message}; fallback failed: ${(fallback as any).__fallbackError?.message || "unknown"}` };
    }

    const fallbackDelivery = extractOutboundDeliveryMetadata(fallback);
    const fallbackMessageId =
      fallbackDelivery.messageId || fallbackDelivery.processQueryKey || fallbackDelivery.outTrackId;
    persistOutboundMessageContext({
      storePath: options.storePath,
      accountId: options.accountId,
      conversationId: options.conversationId || normalizedTarget,
      text: fallbackPersistedText,
      messageType: "outbound-proactive-fallback",
      quotedRef: options.quotedRef,
      log,
      ...DEFAULT_OUTBOUND_SENDER,
      chatType: inferConversationChatType(options.conversationId || normalizedTarget),
      delivery: {
        ...fallbackDelivery,
        kind: isTrackingResult(fallback as ProactiveTextSendResult) ? "proactive-card" : "proactive-text",
      },
    });
    return { ok: true, data: fallback, messageId: fallbackMessageId };
  }
}

export async function sendBySession(
  config: DingTalkConfig,
  sessionWebhook: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<AxiosResponse> {
  const token = await getAccessToken(config, options.log);
  const log = options.log || getLogger();

  // Session webhook supports native media messages; prefer that when media info is available.
  if (options.mediaPath && options.mediaType) {
    const uploadResult = await uploadMedia(config, options.mediaPath, options.mediaType, log, {
      mediaLocalRoots: options.mediaLocalRoots,
    });
    if (uploadResult) {
      const { mediaId, buffer } = uploadResult;
      let body: any;

      if (options.mediaType === "image") {
        body = { msgtype: "image", image: { media_id: mediaId } };
      } else if (options.mediaType === "voice") {
        const durationMs = await getVoiceDurationMs(options.mediaPath, options.mediaType, log, { preReadBuffer: buffer });
        body = { msgtype: "voice", voice: { media_id: mediaId, duration: String(durationMs) } };
      } else if (options.mediaType === "video") {
        body = { msgtype: "video", video: { media_id: mediaId } };
      } else if (options.mediaType === "file") {
        body = { msgtype: "file", file: { media_id: mediaId } };
      }

      if (body) {
        const result = await axios({
          url: sessionWebhook,
          method: "POST",
          data: body,
          headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
          ...getProxyBypassOption(config),
        });
        return result.data;
      }
    } else {
      const mediaHint = options.mediaUrl || options.mediaPath || options.filePath || "(媒体发送失败)";
      text = `${text}\n\n📎 媒体发送失败，兜底链接/路径：${mediaHint}`.trim();
      log?.warn?.("[DingTalk] Media upload failed, falling back to text description");
    }
  }

  // Fallback to text/markdown reply payload.
  const normalizedText = config.convertMarkdownTables !== false ? convertMarkdownTablesToPlainText(text) : text;
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(normalizedText, options, "Clawdbot 消息");
  const chunks = splitMarkdownChunks(normalizedText, DINGTALK_TEXT_CHUNK_LIMIT);

  let lastResult: any = null;
  for (const [idx, chunk] of chunks.entries()) {
    let body: SessionWebhookResponse;
    if (useMarkdown) {
      let finalText = chunk;
      if (options.atUserId && idx === chunks.length - 1) {
        finalText = `${finalText} @${options.atUserId}`;
      }
      body = { msgtype: "markdown", markdown: { title: chunks.length > 1 ? `${title} (${idx + 1}/${chunks.length})` : title, text: finalText } };
    } else {
      body = { msgtype: "text", text: { content: chunk } };
    }

    if (options.atUserId && idx === chunks.length - 1) {
      body.at = { atUserIds: [options.atUserId], isAtAll: false };
    }

    log?.debug?.(
      `[DingTalk][SessionSend] msgtype=${body.msgtype} chunk=${idx + 1}/${chunks.length} ` +
      `len=${chunk.length} preview=${JSON.stringify(chunk.slice(0, 160))}`,
    );
    const result = await axios({
      url: sessionWebhook,
      method: "POST",
      data: body,
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      ...getProxyBypassOption(config),
    });
    lastResult = result.data;
  }
  return lastResult;
}

export async function sendMessage(
  config: DingTalkConfig,
  conversationId: string,
  text: string,
  options: SendMessageOptions & { sessionWebhook?: string; card?: AICardInstance; accountId?: string } = {},
): Promise<{ ok: boolean; error?: string; data?: AxiosResponse; messageId?: string; tracking?: DingTalkTrackingMetadata }> {
  try {
    const messageType = config.messageType || "markdown";
    const log = options.log || getLogger();

    if (messageType === "card" && options.card && !options.forceMarkdown) {
      const card = options.card;
      if (isCardInTerminalState(card.state)) {
        if (options.sessionWebhook) {
          await sendBySession(config, options.sessionWebhook, text, options);
          return { ok: true };
        }

        if (config.cardTemplateId) {
          const proactiveResult = await sendProactiveCardText(config, conversationId, text, log);
          if (!proactiveResult.ok) {
            return { ok: false, error: proactiveResult.error || "Card send failed" };
          }
          return {
            ok: true,
            tracking: {
              processQueryKey: proactiveResult.processQueryKey,
              outTrackId: proactiveResult.outTrackId,
              cardInstanceId: proactiveResult.cardInstanceId,
            },
          };
        }
      }
    }

    if (options.sessionWebhook) {
      const data = await sendBySession(config, options.sessionWebhook, text, options);
      const delivery = extractOutboundDeliveryMetadata(data);
      const messageId = delivery.messageId || delivery.processQueryKey || delivery.outTrackId;
      const persistedText = buildPersistedOutboundText(text, options);
      persistOutboundMessageContext({
        storePath: options.storePath,
        accountId: options.accountId,
        conversationId: options.conversationId || conversationId,
        text: persistedText,
        messageType: options.mediaPath && options.mediaType ? "outbound-media" : "outbound",
        quotedRef: options.quotedRef,
        log,
        ...DEFAULT_OUTBOUND_SENDER,
        chatType: inferConversationChatType(options.conversationId || conversationId),
        delivery: {
          ...delivery,
          kind: "session",
        },
      });
      return { ok: true, data, messageId };
    }

    const result = await sendProactiveTextOrMarkdown(config, conversationId, text, options);
    const delivery = extractOutboundDeliveryMetadata(result);
    const messageId = delivery.messageId || delivery.processQueryKey || delivery.outTrackId;
    persistOutboundMessageContext({
      storePath: options.storePath,
      accountId: options.accountId,
      conversationId: options.conversationId || conversationId,
      text,
      messageType: "outbound-proactive",
      quotedRef: options.quotedRef,
      log,
      ...DEFAULT_OUTBOUND_SENDER,
      chatType: inferConversationChatType(options.conversationId || conversationId),
      delivery: {
        ...delivery,
        kind: isTrackingResult(result) ? "proactive-card" : "proactive-text",
      },
    });
    if (isTrackingResult(result)) {
      return { ok: true, tracking: result.tracking };
    }
    return { ok: true, data: result, messageId };
  } catch (err: any) {
    options.log?.error?.(`[DingTalk] Send message failed: ${err.message}`);
    if (err?.response?.data !== undefined) {
      options.log?.error?.(formatDingTalkErrorPayloadLog("send.message", err.response.data));
    }
    return { ok: false, error: err.message };
  }
}
