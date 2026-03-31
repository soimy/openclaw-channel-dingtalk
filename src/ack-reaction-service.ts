import axios from "./http-client";
import { getAccessToken } from "./auth";
import type { DingTalkConfig } from "./types";
import { formatDingTalkErrorPayloadLog, getErrorMessage, getProxyBypassOption } from "./utils";

// DingTalk currently exposes a dedicated native "thinking" reaction flow rather than
// a generic arbitrary-emoji reaction API for this plugin path.
const DINGTALK_NATIVE_ACK_REACTION = "🤔思考中";
const THINKING_EMOTION_ID = "2659900";
const THINKING_EMOTION_BACKGROUND_ID = "im_bg_1";
// DingTalk `emotion/reply` occasionally races with just-arrived inbound
// messages or returns transient 5xx responses. Keep the first attempt
// immediate, then retry twice with short backoff windows before giving up.
const THINKING_REACTION_ATTACH_DELAYS_MS = [0, 400, 1200] as const;
const THINKING_REACTION_RECALL_DELAYS_MS = [0, 1500, 5000] as const;

type AckReactionLogger = {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

type AckReactionTarget = {
  msgId: string;
  conversationId: string;
  reactionName?: string;
};

type ResolvedAckReactionRequest = {
  msgId: string;
  conversationId: string;
  robotCode: string;
  reactionName: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function formatAckReactionTarget(data: {
  msgId: string;
  conversationId: string;
  reactionName: string;
}): string {
  return `msgId=${data.msgId || "-"} conversationId=${data.conversationId || "-"} reactionName=${data.reactionName || DINGTALK_NATIVE_ACK_REACTION}`;
}

function resolveAckReactionRequest(
  config: DingTalkConfig,
  data: AckReactionTarget,
): ResolvedAckReactionRequest | null {
  const robotCode = (config.clientId || "").trim();
  const reactionName =
    (data.reactionName || DINGTALK_NATIVE_ACK_REACTION).trim() || DINGTALK_NATIVE_ACK_REACTION;
  if (!robotCode || !data.msgId || !data.conversationId) {
    return null;
  }
  return {
    msgId: data.msgId,
    conversationId: data.conversationId,
    robotCode,
    reactionName,
  };
}

async function callEmotionApi(
  config: DingTalkConfig,
  request: ResolvedAckReactionRequest,
  endpoint: "reply" | "recall",
  successLog: string,
  errorLogPrefix: string,
  errorPayloadKey: "inbound.ackReactionAttach" | "inbound.ackReactionRecall",
  log?: AckReactionLogger,
): Promise<{ ok: boolean; error?: unknown }> {
  try {
    const token = await getAccessToken(config, log as any);
    await axios.post(
      `https://api.dingtalk.com/v1.0/robot/emotion/${endpoint}`,
      {
        robotCode: request.robotCode,
        openMsgId: request.msgId,
        openConversationId: request.conversationId,
        emotionType: 2,
        emotionName: request.reactionName,
        textEmotion: {
          emotionId: THINKING_EMOTION_ID,
          emotionName: request.reactionName,
          text: request.reactionName,
          backgroundId: THINKING_EMOTION_BACKGROUND_ID,
        },
      },
      {
        headers: {
          "x-acs-dingtalk-access-token": token,
          "Content-Type": "application/json",
        },
        timeout: 5000,
        ...getProxyBypassOption(config),
      },
    );
    log?.info?.(successLog);
    return { ok: true };
  } catch (err: unknown) {
    const response = asRecord(asRecord(err)?.response);
    log?.warn?.(`${errorLogPrefix}: ${getErrorMessage(err)}`);
    if (response?.data !== undefined) {
      log?.warn?.(formatDingTalkErrorPayloadLog(errorPayloadKey, response.data));
    }
    return { ok: false, error: err };
  }
}

function isRetryableEmotionApiError(err: unknown): boolean {
  const response = asRecord(asRecord(err)?.response);
  const data = asRecord(response?.data);
  const status = Number(response?.status ?? 0);
  const errorCode = String(data?.code || "").trim().toLowerCase();
  if (!response) {
    return true;
  }
  if (status >= 500) {
    return true;
  }
  return errorCode === "system.err";
}

export async function attachNativeAckReaction(
  config: DingTalkConfig,
  data: AckReactionTarget,
  log?: AckReactionLogger,
): Promise<boolean> {
  const request = resolveAckReactionRequest(config, data);
  if (!request) {
    return false;
  }
  for (let index = 0; index < THINKING_REACTION_ATTACH_DELAYS_MS.length; index += 1) {
    const delayMs = THINKING_REACTION_ATTACH_DELAYS_MS[index];
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    const attempt = index + 1;
    const attemptLabel = `${attempt}/${THINKING_REACTION_ATTACH_DELAYS_MS.length}`;
    const result = await callEmotionApi(
      config,
      request,
      "reply",
      `[DingTalk] Native ack reaction attach succeeded (${formatAckReactionTarget(request)} attempt=${attemptLabel})`,
      `[DingTalk] Native ack reaction attach failed (${formatAckReactionTarget(request)} attempt=${attemptLabel})`,
      "inbound.ackReactionAttach",
      log,
    );
    if (result.ok) {
      return true;
    }
    const shouldRetry = isRetryableEmotionApiError(result.error);
    if (!shouldRetry || attempt === THINKING_REACTION_ATTACH_DELAYS_MS.length) {
      break;
    }
    log?.debug?.(
      `[DingTalk] Retrying native ack reaction attach (${formatAckReactionTarget(request)} nextAttempt=${attempt + 1}/${THINKING_REACTION_ATTACH_DELAYS_MS.length})`,
    );
  }
  return false;
}

async function recallNativeAckReaction(
  config: DingTalkConfig,
  request: ResolvedAckReactionRequest,
  log?: AckReactionLogger,
): Promise<boolean> {
  const result = await callEmotionApi(
    config,
    request,
    "recall",
    "[DingTalk] Native ack reaction recall succeeded",
    "[DingTalk] Native ack reaction recall failed",
    "inbound.ackReactionRecall",
    log,
  );
  return result.ok;
}

export async function recallNativeAckReactionWithRetry(
  config: DingTalkConfig,
  data: AckReactionTarget,
  log?: AckReactionLogger,
): Promise<void> {
  const request = resolveAckReactionRequest(config, data);
  if (!request) {
    return;
  }
  for (const delayMs of THINKING_REACTION_RECALL_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    if (await recallNativeAckReaction(config, request, log)) {
      return;
    }
  }
}
