import axios from "axios";
import { getAccessToken } from "./auth";
import type { DingTalkConfig } from "./types";
import { formatDingTalkErrorPayloadLog, getProxyBypassOption } from "./utils";

// DingTalk currently exposes a dedicated native "thinking" reaction flow rather than
// a generic arbitrary-emoji reaction API for this plugin path.
export const DINGTALK_NATIVE_ACK_REACTION = "🤔思考中";
const THINKING_EMOTION_ID = "2659900";
const THINKING_EMOTION_BACKGROUND_ID = "im_bg_1";
const THINKING_REACTION_RECALL_DELAYS_MS = [0, 1500, 5000] as const;

type AckReactionLogger = {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

type AckReactionTarget = {
  msgId: string;
  conversationId: string;
  robotCode?: string;
  reactionName?: string;
};

export async function attachNativeAckReaction(
  config: DingTalkConfig,
  data: AckReactionTarget,
  log?: AckReactionLogger,
): Promise<boolean> {
  const robotCode = (data.robotCode || config.robotCode || config.clientId || "").trim();
  const reactionName =
    (data.reactionName || DINGTALK_NATIVE_ACK_REACTION).trim() || DINGTALK_NATIVE_ACK_REACTION;
  if (!robotCode || !data.msgId || !data.conversationId) {
    return false;
  }

  try {
    const token = await getAccessToken(config, log as any);
    await axios.post(
      "https://api.dingtalk.com/v1.0/robot/emotion/reply",
      {
        robotCode,
        openMsgId: data.msgId,
        openConversationId: data.conversationId,
        emotionType: 2,
        emotionName: reactionName,
        textEmotion: {
          emotionId: THINKING_EMOTION_ID,
          emotionName: reactionName,
          text: reactionName,
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
    log?.info?.("[DingTalk] Native ack reaction attach succeeded");
    return true;
  } catch (err: any) {
    log?.warn?.(`[DingTalk] Native ack reaction attach failed: ${err.message}`);
    if (err?.response?.data !== undefined) {
      log?.warn?.(formatDingTalkErrorPayloadLog("inbound.ackReactionAttach", err.response.data));
    }
    return false;
  }
}

async function recallNativeAckReaction(
  config: DingTalkConfig,
  data: AckReactionTarget,
  log?: AckReactionLogger,
): Promise<boolean> {
  const robotCode = (data.robotCode || config.robotCode || config.clientId || "").trim();
  const reactionName =
    (data.reactionName || DINGTALK_NATIVE_ACK_REACTION).trim() || DINGTALK_NATIVE_ACK_REACTION;
  if (!robotCode || !data.msgId || !data.conversationId) {
    return false;
  }

  try {
    const token = await getAccessToken(config, log as any);
    await axios.post(
      "https://api.dingtalk.com/v1.0/robot/emotion/recall",
      {
        robotCode,
        openMsgId: data.msgId,
        openConversationId: data.conversationId,
        emotionType: 2,
        emotionName: reactionName,
        textEmotion: {
          emotionId: THINKING_EMOTION_ID,
          emotionName: reactionName,
          text: reactionName,
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
    log?.info?.("[DingTalk] Native ack reaction recall succeeded");
    return true;
  } catch (err: any) {
    log?.warn?.(`[DingTalk] Native ack reaction recall failed: ${err.message}`);
    if (err?.response?.data !== undefined) {
      log?.warn?.(formatDingTalkErrorPayloadLog("inbound.ackReactionRecall", err.response.data));
    }
    return false;
  }
}

export async function recallNativeAckReactionWithRetry(
  config: DingTalkConfig,
  data: AckReactionTarget,
  log?: AckReactionLogger,
): Promise<void> {
  for (const delayMs of THINKING_REACTION_RECALL_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    if (await recallNativeAckReaction(config, data, log)) {
      return;
    }
  }
}
