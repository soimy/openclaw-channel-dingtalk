import { randomUUID } from "node:crypto";
import axios from "axios";
import { getAccessToken } from "./auth";
import { stripTargetPrefix } from "./config";
import { resolveOriginalPeerId } from "./peer-id-registry";
import { formatDingTalkErrorPayloadLog } from "./utils";
import type {
  AICardInstance,
  AICardStreamingRequest,
  DingTalkConfig,
  DingTalkInboundMessage,
  Logger,
} from "./types";
import { AICardStatus } from "./types";

const DINGTALK_API = "https://api.dingtalk.com";
// Card cache TTL (1 hour) for terminal states.
const CARD_CACHE_TTL = 60 * 60 * 1000;
// Thinking/tool stream snippets are truncated to keep card updates compact.
const THINKING_TRUNCATE_LENGTH = 500;

// AI Card instance cache for streaming updates.
const aiCardInstances = new Map<string, AICardInstance>();
// accountId:conversationId -> cardInstanceId
const activeCardsByTarget = new Map<string, string>();

// Helper to identify card terminal states.
export function isCardInTerminalState(state: string): boolean {
  return state === AICardStatus.FINISHED || state === AICardStatus.FAILED;
}

export function getCardById(cardId: string): AICardInstance | undefined {
  return aiCardInstances.get(cardId);
}

export function getActiveCardIdByTarget(targetKey: string): string | undefined {
  return activeCardsByTarget.get(targetKey);
}

export function deleteActiveCardByTarget(targetKey: string): void {
  activeCardsByTarget.delete(targetKey);
}

export function cleanupCardCache(): void {
  const now = Date.now();
  // Clean terminal cards only; active cards stay in cache to support streaming continuity.
  for (const [cardInstanceId, instance] of aiCardInstances.entries()) {
    if (isCardInTerminalState(instance.state) && now - instance.lastUpdated > CARD_CACHE_TTL) {
      aiCardInstances.delete(cardInstanceId);
      for (const [targetKey, mappedCardId] of activeCardsByTarget.entries()) {
        if (mappedCardId === cardInstanceId) {
          activeCardsByTarget.delete(targetKey);
          break;
        }
      }
    }
  }
}

export function formatContentForCard(content: string, type: "thinking" | "tool"): string {
  if (!content) {
    return "";
  }

  // Truncate to configured length and keep a visual ellipsis when truncated.
  const truncated =
    content.slice(0, THINKING_TRUNCATE_LENGTH) +
    (content.length > THINKING_TRUNCATE_LENGTH ? "…" : "");

  // Quote each line to improve readability in markdown card content.
  const quotedLines = truncated
    .split("\n")
    .map((line) => line.replace(/^_(?=[^ ])/, "*").replace(/(?<=[^ ])_(?=$)/, "*"))
    .map((line) => `> ${line}`)
    .join("\n");

  const emoji = type === "thinking" ? "🤔" : "🛠️";
  const label = type === "thinking" ? "思考中" : "工具执行";

  return `${emoji} **${label}**\n${quotedLines}`;
}

async function sendTemplateMismatchNotification(
  card: AICardInstance,
  text: string,
  log?: Logger,
): Promise<void> {
  const config = card.config;
  if (!config) {
    return;
  }
  try {
    const token = await getAccessToken(config, log);
    const { targetId, isExplicitUser } = stripTargetPrefix(card.conversationId);
    const resolvedTarget = resolveOriginalPeerId(targetId);
    const isGroup = !isExplicitUser && resolvedTarget.startsWith("cid");
    const url = isGroup
      ? "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
      : "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";

    // Direct markdown fallback notification to user/group, without re-entering sendMessage card flow.
    const payload: Record<string, unknown> = {
      robotCode: config.robotCode || config.clientId,
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({ title: "OpenClaw 提醒", text }),
    };

    if (isGroup) {
      payload.openConversationId = resolvedTarget;
    } else {
      payload.userIds = [resolvedTarget];
    }

    await axios({
      url,
      method: "POST",
      data: payload,
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
    });
  } catch (sendErr: any) {
    log?.warn?.(`[DingTalk][AICard] Failed to send error notification to user: ${sendErr.message}`);
  }
}

export async function createAICard(
  config: DingTalkConfig,
  conversationId: string,
  data: DingTalkInboundMessage,
  accountId: string,
  log?: Logger,
): Promise<AICardInstance | null> {
  try {
    const token = await getAccessToken(config, log);
    // Use randomUUID to avoid collisions across workers/restarts.
    const cardInstanceId = `card_${randomUUID()}`;

    log?.info?.(`[DingTalk][AICard] Creating and delivering card outTrackId=${cardInstanceId}`);
    log?.debug?.(
      `[DingTalk][AICard] conversationType=${data.conversationType}, conversationId=${conversationId}`,
    );

    const isGroup = conversationId.startsWith("cid");
    // For IM_ROBOT single chat, the openSpaceId must use the sender's userId, not conversationId.
    const spaceId = isGroup ? conversationId : (data.senderStaffId || data.senderId);

    if (!config.cardTemplateId) {
      throw new Error("DingTalk cardTemplateId is not configured.");
    }

    // DingTalk createAndDeliver API payload.
    const createAndDeliverBody = {
      cardTemplateId: config.cardTemplateId,
      outTrackId: cardInstanceId,
      cardData: {
        // DingTalk streaming API requires at least one field in cardParamMap to accept subsequent
        // PUT /v1.0/card/streaming updates; an empty map causes param.empty errors.
        cardParamMap: { content: "" },
      },
      callbackType: "STREAM",
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
      openSpaceId: isGroup
        ? `dtv1.card//IM_GROUP.${spaceId}`
        : `dtv1.card//IM_ROBOT.${spaceId}`,
      userIdType: 1,
      imGroupOpenDeliverModel: isGroup
        ? { robotCode: config.robotCode || config.clientId }
        : undefined,
      imRobotOpenDeliverModel: !isGroup
        ? { spaceType: "IM_ROBOT", robotCode: config.robotCode || config.clientId }
        : undefined,
    };

    if (isGroup && !config.robotCode) {
      log?.warn?.(
        "[DingTalk][AICard] robotCode not configured, using clientId as fallback. " +
          "For best compatibility, set robotCode explicitly in config.",
      );
    }

    log?.debug?.(
      `[DingTalk][AICard] POST /v1.0/card/instances/createAndDeliver body=${JSON.stringify(createAndDeliverBody)}`,
    );
    const resp = await axios.post(
      `${DINGTALK_API}/v1.0/card/instances/createAndDeliver`,
      createAndDeliverBody,
      {
        headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      },
    );
    log?.debug?.(
      `[DingTalk][AICard] CreateAndDeliver response: status=${resp.status} data=${JSON.stringify(resp.data)}`,
    );

    // Cache the AI card instance with config reference for token refresh/recovery.
    const aiCardInstance: AICardInstance = {
      cardInstanceId,
      accessToken: token,
      conversationId,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      state: AICardStatus.PROCESSING,
      config,
    };
    aiCardInstances.set(cardInstanceId, aiCardInstance);

    const targetKey = `${accountId}:${conversationId}`;
    activeCardsByTarget.set(targetKey, cardInstanceId);
    log?.debug?.(
      `[DingTalk][AICard] Registered active card mapping: ${targetKey} -> ${cardInstanceId}`,
    );

    return aiCardInstance;
  } catch (err: any) {
    log?.error?.(`[DingTalk][AICard] Create failed: ${err.message}`);
    if (err.response) {
      const status = err.response.status;
      const statusText = err.response.statusText;
      const statusLabel = status ? ` status=${status}${statusText ? ` ${statusText}` : ""}` : "";
      log?.error?.(`[DingTalk][AICard] Create error response${statusLabel}`);
      log?.error?.(
        formatDingTalkErrorPayloadLog("card.create", err.response.data, "[DingTalk][AICard]"),
      );
    }
    return null;
  }
}

export async function streamAICard(
  card: AICardInstance,
  content: string,
  finished: boolean = false,
  log?: Logger,
): Promise<void> {
  if (card.state === AICardStatus.FINISHED) {
    log?.debug?.(
      `[DingTalk][AICard] Skip stream update because card already finalized: outTrackId=${card.cardInstanceId}`,
    );
    return;
  }

  // Refresh token defensively before DingTalk 2h token horizon.
  const tokenAge = Date.now() - card.createdAt;
  const tokenRefreshThreshold = 90 * 60 * 1000;

  if (tokenAge > tokenRefreshThreshold && card.config) {
    log?.debug?.("[DingTalk][AICard] Token age exceeds threshold, refreshing...");
    try {
      card.accessToken = await getAccessToken(card.config, log);
      log?.debug?.("[DingTalk][AICard] Token refreshed successfully");
    } catch (err: any) {
      log?.warn?.(`[DingTalk][AICard] Failed to refresh token: ${err.message}`);
    }
  }

  // Always use full replacement to make client rendering deterministic.
  const streamBody: AICardStreamingRequest = {
    outTrackId: card.cardInstanceId,
    guid: randomUUID(),
    key: card.config?.cardTemplateKey || "content",
    content: content,
    isFull: true,
    isFinalize: finished,
    isError: false,
  };

  log?.debug?.(
    `[DingTalk][AICard] PUT /v1.0/card/streaming contentLen=${content.length} isFull=true isFinalize=${finished} guid=${streamBody.guid} payload=${JSON.stringify(streamBody)}`,
  );

  try {
    const streamResp = await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, streamBody, {
      headers: {
        "x-acs-dingtalk-access-token": card.accessToken,
        "Content-Type": "application/json",
      },
    });
    log?.debug?.(
      `[DingTalk][AICard] Streaming response: status=${streamResp.status}, data=${JSON.stringify(streamResp.data)}`,
    );

    card.lastUpdated = Date.now();
    card.lastStreamedContent = content;
    if (finished) {
      card.state = AICardStatus.FINISHED;
    } else if (card.state === AICardStatus.PROCESSING) {
      card.state = AICardStatus.INPUTING;
    }
  } catch (err: any) {
    // 500 unknownError usually means cardTemplateKey mismatch with template variable names.
    if (err.response?.status === 500 && err.response?.data?.code === "unknownError") {
      const usedKey = streamBody.key;
      const cardTemplateId = card.config?.cardTemplateId || "(unknown)";
      const errorMsg =
        `⚠️ **[DingTalk] AI Card 串流更新失败 (500 unknownError)**\n\n` +
        `这通常是因为 \`cardTemplateKey\` (当前值: \`${usedKey}\`) 与钉钉卡片模板 \`${cardTemplateId}\` 中定义的正文变量名不匹配。\n\n` +
        `**建议操作**：\n` +
        `1. 前往钉钉开发者后台检查该模板的“变量管理”\n` +
        `2. 确保配置中的 \`cardTemplateKey\` 与模板中用于显示内容的字段变量名完全一致\n\n` +
        `*注意：当前及后续消息将自动转为 Markdown 发送，直到问题修复。*\n` +
        `*参考文档: https://github.com/soimy/openclaw-channel-dingtalk/blob/main/README.md#3-%E5%BB%BA%E7%AB%8B%E5%8D%A1%E7%89%87%E6%A8%A1%E6%9D%BF%E5%8F%AF%E9%80%89`;

      log?.error?.(
        `[DingTalk][AICard] Streaming failed with 500 unknownError. Key: ${usedKey}, Template: ${cardTemplateId}. ` +
          `Verify that "cardTemplateKey" matches the content field variable name in your card template.`,
      );

      card.state = AICardStatus.FAILED;
      card.lastUpdated = Date.now();
      await sendTemplateMismatchNotification(card, errorMsg, log);
      throw err;
    }

    // Retry once on 401 with refreshed token.
    if (err.response?.status === 401 && card.config) {
      log?.warn?.("[DingTalk][AICard] Received 401 error, attempting token refresh and retry...");
      try {
        card.accessToken = await getAccessToken(card.config, log);
        const retryResp = await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, streamBody, {
          headers: {
            "x-acs-dingtalk-access-token": card.accessToken,
            "Content-Type": "application/json",
          },
        });
        log?.debug?.(
          `[DingTalk][AICard] Retry after token refresh succeeded: status=${retryResp.status}`,
        );
        card.lastUpdated = Date.now();
        if (finished) {
          card.state = AICardStatus.FINISHED;
        } else if (card.state === AICardStatus.PROCESSING) {
          card.state = AICardStatus.INPUTING;
        }
        return;
      } catch (retryErr: any) {
        log?.error?.(`[DingTalk][AICard] Retry after token refresh failed: ${retryErr.message}`);
        if (retryErr.response?.data !== undefined) {
          log?.error?.(
            formatDingTalkErrorPayloadLog(
              "card.stream.retryAfterRefresh",
              retryErr.response.data,
              "[DingTalk][AICard]",
            ),
          );
        }
      }
    }

    card.state = AICardStatus.FAILED;
    card.lastUpdated = Date.now();
    log?.error?.(
      `[DingTalk][AICard] Streaming update failed: ${err.message}`,
    );
    if (err.response?.data !== undefined) {
      log?.error?.(
        formatDingTalkErrorPayloadLog("card.stream", err.response.data, "[DingTalk][AICard]"),
      );
    }
    throw err;
  }
}

export async function finishAICard(
  card: AICardInstance,
  content: string,
  log?: Logger,
): Promise<void> {
  log?.debug?.(`[DingTalk][AICard] Starting finish, final content length=${content.length}`);
  // Finalize by streaming one last full payload with isFinalize=true.
  await streamAICard(card, content, true, log);
}
