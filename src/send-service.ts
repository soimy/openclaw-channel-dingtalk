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
  const token = await getAccessToken(config, options.log);
  const log = options.log || getLogger();

  // Support group:/user: prefix and restore original case-sensitive conversationId.
  const { targetId, isExplicitUser } = stripTargetPrefix(target);
  const resolvedTarget = resolveOriginalPeerId(targetId);
  const isGroup = !isExplicitUser && resolvedTarget.startsWith("cid");

  const url = isGroup
    ? "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
    : "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";

  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, "OpenClaw 提醒");

  log?.debug?.(
    `[DingTalk] Sending proactive message to ${isGroup ? "group" : "user"} ${resolvedTarget} with title "${title}"`,
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

  const result = await axios({
    url,
    method: "POST",
    data: payload,
    headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
  });
  return result.data;
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
    });

    const messageId = result.data?.processQueryKey || result.data?.messageId;
    return { ok: true, data: result.data, messageId };
  } catch (err: any) {
    log?.error?.(`[DingTalk] Failed to send proactive media: ${err.message}`);
    if (axios.isAxiosError(err) && err.response) {
      log?.error?.(`[DingTalk] Response: ${JSON.stringify(err.response.data)}`);
    }
    return { ok: false, error: err.message };
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
        });
        return result.data;
      }
    } else {
      log?.warn?.("[DingTalk] Media upload failed, falling back to text description");
    }
  }

  // Fallback to text/markdown reply payload.
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, "Clawdbot 消息");

  let body: SessionWebhookResponse;
  if (useMarkdown) {
    let finalText = text;
    if (options.atUserId) {
      finalText = `${finalText} @${options.atUserId}`;
    }
    body = { msgtype: "markdown", markdown: { title, text: finalText } };
  } else {
    body = { msgtype: "text", text: { content: text } };
  }

  if (options.atUserId) {
    body.at = { atUserIds: [options.atUserId], isAtAll: false };
  }

  const result = await axios({
    url: sessionWebhook,
    method: "POST",
    data: body,
    headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
  });
  return result.data;
}

export async function sendMessage(
  config: DingTalkConfig,
  conversationId: string,
  text: string,
  options: SendMessageOptions & { sessionWebhook?: string; accountId?: string } = {},
): Promise<{ ok: boolean; error?: string; data?: AxiosResponse }> {
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
      await sendBySession(config, options.sessionWebhook, text, options);
      return { ok: true };
    }

    const result = await sendProactiveTextOrMarkdown(config, conversationId, text, options);
    return { ok: true, data: result };
  } catch (err: any) {
    options.log?.error?.(`[DingTalk] Send message failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
