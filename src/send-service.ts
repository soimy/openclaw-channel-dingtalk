import * as path from "node:path";
import axios from "axios";
import { getAccessToken } from "./auth";
import {
  deleteActiveCardByTarget,
  getActiveCardIdByTarget,
  getCardById,
  isCardInTerminalState,
  streamAICard,
} from "./card-service";
import { stripTargetPrefix } from "./config";
import { getLogger } from "./logger-context";
import { uploadMedia as uploadMediaUtil } from "./media-utils";
import { detectMarkdownAndExtractTitle } from "./message-utils";
import { resolveOriginalPeerId } from "./peer-id-registry";
import { appendOutboundToQuoteJournal, appendProactiveOutboundJournal } from "./quote-journal";
import {
  deleteProactiveRiskObservation,
  getProactiveRiskObservation,
  recordProactiveRiskObservation,
} from "./proactive-risk-registry";
import { formatDingTalkErrorPayloadLog } from "./utils";
import type {
  AxiosResponse,
  DingTalkConfig,
  Logger,
  ProactiveMessagePayload,
  SendMessageOptions,
  SessionWebhookResponse,
} from "./types";
import { AICardStatus } from "./types";

export { detectMediaTypeFromExtension } from "./media-utils";

const DINGTALK_TEXT_CHUNK_LIMIT = 3800;

function splitMarkdownChunks(text: string, limit = DINGTALK_TEXT_CHUNK_LIMIT): string[] {
  if (!text || text.length <= limit) return [text];
  const chunks: string[] = [];
  let buf = "";
  const lines = text.split("\n");
  let inCode = false;

  for (const line of lines) {
    const fenceCount = (line.match(/```/g) || []).length;
    if (buf.length + line.length + 1 > limit && buf.length > 0) {
      if (inCode) buf += "\n```";
      chunks.push(buf);
      buf = inCode ? "```\n" : "";
    }
    buf += (buf ? "\n" : "") + line;
    if (fenceCount % 2 === 1) inCode = !inCode;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function getProxyBypassOption(config: DingTalkConfig): { proxy: false } | Record<string, never> {
  return config.bypassProxyForSend ? { proxy: false } : {};
}

function extractOutboundMessageId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const data = payload as Record<string, unknown>;
  const value = data.processQueryKey ?? data.messageId ?? data.msgid;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
): Promise<string | null> {
  return uploadMediaUtil(config, mediaPath, mediaType, getAccessToken, log);
}

export async function sendProactiveTextOrMarkdown(
  config: DingTalkConfig,
  target: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<AxiosResponse> {
  const log = options.log || getLogger();
  const token = await getAccessToken(config, log);

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

  const url = isGroup
    ? "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
    : "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";

  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, "OpenClaw 提醒");

  log?.debug?.(
    `[DingTalk] Sending proactive message to ${isGroup ? "group" : "user"} ${resolvedTarget} with title "${title}"${proactiveRiskTag}`,
  );

  // DingTalk proactive API uses message templates (sampleMarkdown / sampleText).
  const msgKey = useMarkdown ? "sampleMarkdown" : "sampleText";
  const msgParam = useMarkdown
    ? JSON.stringify({ title, text })
    : JSON.stringify({ content: text });

  const payload: ProactiveMessagePayload = {
    robotCode: config.robotCode || config.clientId,
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
    const mediaId = await uploadMedia(config, mediaPath, mediaType, log);
    if (!mediaId) {
      return { ok: false, error: "Failed to upload media" };
    }

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
      msgParam = JSON.stringify({ mediaId, duration: "0" });
    } else {
      // sampleVideo requires picMediaId; fallback to sampleFile for broader compatibility.
      const filename = path.basename(mediaPath);
      const defaultExt = mediaType === "video" ? "mp4" : "file";
      const ext = path.extname(mediaPath).slice(1) || defaultExt;
      msgKey = "sampleFile";
      msgParam = JSON.stringify({ mediaId, fileName: filename, fileType: ext });
    }

    const payload: ProactiveMessagePayload = {
      robotCode: config.robotCode || config.clientId,
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

    const messageId = extractOutboundMessageId(result.data);
    if (options.storePath && options.accountId) {
      await appendProactiveOutboundJournal({
        storePath: options.storePath,
        accountId: options.accountId,
        conversationId: resolvedTarget,
        messageId,
        text: `[media:${mediaType}] ${mediaPath}`,
        messageType: "outbound-proactive-media",
        log,
      });
    }
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

    const fallback = await sendProactiveTextOrMarkdown(
      config,
      target,
      `📎 媒体发送失败，兜底链接/路径：${mediaPath}`,
      options,
    ).catch((fallbackErr: any) => ({ __fallbackError: fallbackErr }));

    if ((fallback as any)?.__fallbackError) {
      return {
        ok: false,
        error: `${err.message}; fallback failed: ${(fallback as any).__fallbackError?.message || "unknown"}`,
      };
    }

    return {
      ok: true,
      data: fallback,
      messageId: (fallback as any)?.processQueryKey || (fallback as any)?.messageId,
    };
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
    const mediaId = await uploadMedia(config, options.mediaPath, options.mediaType, log);
    if (mediaId) {
      let body: any;

      if (options.mediaType === "image") {
        body = { msgtype: "image", image: { media_id: mediaId } };
      } else if (options.mediaType === "voice") {
        body = { msgtype: "voice", voice: { media_id: mediaId } };
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
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, "Clawdbot 消息");
  const chunks = splitMarkdownChunks(text, DINGTALK_TEXT_CHUNK_LIMIT);

  let lastResult: any = null;
  for (const [idx, chunk] of chunks.entries()) {
    let body: SessionWebhookResponse;
    if (useMarkdown) {
      let finalText = chunk;
      if (options.atUserId && idx === chunks.length - 1) {
        finalText = `${finalText} @${options.atUserId}`;
      }
      body = {
        msgtype: "markdown",
        markdown: {
          title: chunks.length > 1 ? `${title} (${idx + 1}/${chunks.length})` : title,
          text: finalText,
        },
      };
    } else {
      body = { msgtype: "text", text: { content: chunk } };
    }

    if (options.atUserId && idx === chunks.length - 1) {
      body.at = { atUserIds: [options.atUserId], isAtAll: false };
    }

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
  options: SendMessageOptions & { sessionWebhook?: string; accountId?: string } = {},
): Promise<{ ok: boolean; error?: string; data?: AxiosResponse; messageId?: string }> {
  try {
    const messageType = config.messageType || "markdown";
    const log = options.log || getLogger();

    // Card mode: stream into active card if exists; otherwise fallback to markdown/session send.
    if (messageType === "card" && options.accountId) {
      const targetKey = `${options.accountId}:${conversationId}`;
      const activeCardId = getActiveCardIdByTarget(targetKey);
      if (activeCardId) {
        const activeCard = getCardById(activeCardId);
        if (activeCard && !isCardInTerminalState(activeCard.state)) {
          try {
            await streamAICard(activeCard, text, false, log);
            return { ok: true };
          } catch (err: any) {
            // Mark failed and continue to markdown fallback to avoid message loss.
            log?.warn?.(
              `[DingTalk] AI Card streaming failed, fallback to markdown: ${err.message}`,
            );
            activeCard.state = AICardStatus.FAILED;
            activeCard.lastUpdated = Date.now();
          }
        } else {
          deleteActiveCardByTarget(targetKey);
        }
      }
    }

    if (options.sessionWebhook) {
      const data = await sendBySession(config, options.sessionWebhook, text, options);
      const messageId = extractOutboundMessageId(data);
      if (options.storePath && options.accountId) {
        await appendOutboundToQuoteJournal({
          storePath: options.storePath,
          accountId: options.accountId,
          conversationId,
          messageId,
          messageType: "outbound",
          text,
          log,
        });
      }
      return { ok: true, data, messageId };
    }

    const result = await sendProactiveTextOrMarkdown(config, conversationId, text, options);
    const messageId = extractOutboundMessageId(result);
    if (options.storePath && options.accountId) {
      await appendProactiveOutboundJournal({
        storePath: options.storePath,
        accountId: options.accountId,
        conversationId,
        messageId,
        text,
        messageType: "outbound-proactive",
        log,
      });
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
