import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import axios from 'axios';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { buildChannelConfigSchema } from 'openclaw/plugin-sdk';
import { maskSensitiveData, cleanupOrphanedTempFiles, retryWithBackoff } from '../utils';
import { getDingTalkRuntime } from './runtime';
import { DingTalkConfigSchema } from './config-schema.js';
import type {
  DingTalkConfig,
  TokenInfo,
  DingTalkInboundMessage,
  MessageContent,
  SendMessageOptions,
  MediaFile,
  HandleDingTalkMessageParams,
  ProactiveMessagePayload,
  SessionWebhookResponse,
  AxiosResponse,
  Logger,
  GatewayStartContext,
  GatewayStopResult,
  AICardInstance,
  AICardStreamingRequest,
} from './types';
import { AICardStatus } from './types';

// Access Token cache
let accessToken: string | null = null;
let accessTokenExpiry = 0;

// Global logger reference for use across module methods
let currentLogger: Logger | undefined;

// AI Card instance cache for streaming updates
const aiCardInstances = new Map<string, AICardInstance>();

// Target to active AI Card instance ID mapping (accountId:conversationId -> cardInstanceId)
// Used to quickly lookup existing active cards for a target
const activeCardsByTarget = new Map<string, string>();

// Card cache TTL (1 hour)
const CARD_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// DingTalk API base URL
const DINGTALK_API = 'https://api.dingtalk.com';

// Authorization helpers
type NormalizedAllowFrom = {
  entries: string[];
  entriesLower: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
};

/**
 * Normalize allowFrom list to standardized format
 */
function normalizeAllowFrom(list?: Array<string>): NormalizedAllowFrom {
  const entries = (list ?? []).map((value) => String(value).trim()).filter(Boolean);
  const hasWildcard = entries.includes('*');
  const normalized = entries
    .filter((value) => value !== '*')
    .map((value) => value.replace(/^(dingtalk|dd|ding):/i, ''));
  const normalizedLower = normalized.map((value) => value.toLowerCase());
  return {
    entries: normalized,
    entriesLower: normalizedLower,
    hasWildcard,
    hasEntries: entries.length > 0,
  };
}

/**
 * Check if sender is allowed based on allowFrom list
 */
function isSenderAllowed(params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
}): boolean {
  const { allow, senderId } = params;
  if (!allow.hasEntries) return true;
  if (allow.hasWildcard) return true;
  if (senderId && allow.entriesLower.includes(senderId.toLowerCase())) return true;
  return false;
}

// Helper function to check if a card is in a terminal state
function isCardInTerminalState(state: string): boolean {
  return state === AICardStatus.FINISHED || state === AICardStatus.FAILED;
}

// Clean up old AI card instances from cache
function cleanupCardCache() {
  const now = Date.now();
  
  // Clean up AI card instances that are in FINISHED or FAILED state
  // Active cards (PROCESSING, INPUTING) are not cleaned up even if they exceed TTL
  for (const [cardInstanceId, instance] of aiCardInstances.entries()) {
    if (isCardInTerminalState(instance.state) && now - instance.lastUpdated > CARD_CACHE_TTL) {
      // Remove from aiCardInstances
      aiCardInstances.delete(cardInstanceId);

      // Remove from activeCardsByTarget mapping (break after first match for efficiency)
      for (const [targetKey, mappedCardId] of activeCardsByTarget.entries()) {
        if (mappedCardId === cardInstanceId) {
          activeCardsByTarget.delete(targetKey);
          break; // Each card should only have one target mapping
        }
      }
    }
  }
}

/**
 * Get the current logger instance
 * Useful for methods that don't receive log as a parameter
 */
function getLogger(): Logger | undefined {
  return currentLogger;
}

// Helper function to detect markdown and extract title
function detectMarkdownAndExtractTitle(
  text: string,
  options: SendMessageOptions,
  defaultTitle: string
): { useMarkdown: boolean; title: string } {
  const hasMarkdown = /^[#*>-]|[*_`#[\]]/.test(text) || text.includes('\n');
  const useMarkdown = options.useMarkdown !== false && (options.useMarkdown || hasMarkdown);

  const title =
    options.title ||
    (useMarkdown
      ? text
          .split('\n')[0]
          .replace(/^[#*\s\->]+/, '')
          .slice(0, 20) || defaultTitle
      : defaultTitle);

  return { useMarkdown, title };
}

function getConfig(cfg: OpenClawConfig, accountId?: string): DingTalkConfig {
  const dingtalkCfg = cfg?.channels?.dingtalk as DingTalkConfig | undefined;
  if (!dingtalkCfg) return {} as DingTalkConfig;

  if (accountId && dingtalkCfg.accounts?.[accountId]) {
    return dingtalkCfg.accounts[accountId];
  }

  return dingtalkCfg;
}

function isConfigured(cfg: OpenClawConfig, accountId?: string): boolean {
  const config = getConfig(cfg, accountId);
  return Boolean(config.clientId && config.clientSecret);
}

// Get Access Token with retry logic
async function getAccessToken(config: DingTalkConfig, log?: Logger): Promise<string> {
  const now = Date.now();
  if (accessToken && accessTokenExpiry > now + 60000) {
    return accessToken;
  }

  const token = await retryWithBackoff(
    async () => {
      const response = await axios.post<TokenInfo>('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        appKey: config.clientId,
        appSecret: config.clientSecret,
      });

      accessToken = response.data.accessToken;
      accessTokenExpiry = now + response.data.expireIn * 1000;
      return accessToken;
    },
    { maxRetries: 3, log }
  );

  return token;
}

// Send text/markdown proactive message via DingTalk OpenAPI
async function sendProactiveTextOrMarkdown(
  config: DingTalkConfig,
  target: string,
  text: string,
  options: SendMessageOptions = {}
): Promise<AxiosResponse> {
  const token = await getAccessToken(config, options.log);
  const isGroup = target.startsWith('cid');
  const log = options.log || getLogger();

  const url = isGroup
    ? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
    : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';

  // Use shared helper function for markdown detection and title extraction
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, 'OpenClaw 提醒');

  log?.debug?.(`[DingTalk] Sending proactive message to ${isGroup ? 'group' : 'user'} ${target} with title "${title}"`);

  // Choose msgKey based on whether we're sending markdown or plain text
  // Note: DingTalk's proactive message API uses predefined message templates
  // sampleMarkdown supports markdown formatting, sampleText for plain text
  const msgKey = useMarkdown ? 'sampleMarkdown' : 'sampleText';

  const payload: ProactiveMessagePayload = {
    robotCode: config.robotCode || config.clientId,
    msgKey,
    msgParam: JSON.stringify({
      title,
      text,
    }),
  };

  if (isGroup) {
    payload.openConversationId = target;
  } else {
    payload.userIds = [target];
  }

  const result = await axios({
    url,
    method: 'POST',
    data: payload,
    headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
  });
  return result.data;
}

// Download media file
async function downloadMedia(config: DingTalkConfig, downloadCode: string, log?: Logger): Promise<MediaFile | null> {
  if (!config.robotCode) {
    if (log?.error) {
      log.error('[DingTalk] downloadMedia requires robotCode to be configured.');
    }
    return null;
  }
  try {
    const token = await getAccessToken(config, log);
    const response = await axios.post<{ downloadUrl?: string }>(
      'https://api.dingtalk.com/v1.0/robot/messageFiles/download',
      { downloadCode, robotCode: config.robotCode },
      { headers: { 'x-acs-dingtalk-access-token': token } }
    );
    const downloadUrl = response.data?.downloadUrl;
    if (!downloadUrl) return null;
    const mediaResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    const contentType = mediaResponse.headers['content-type'] || 'application/octet-stream';
    const ext = contentType.split('/')[1]?.split(';')[0] || 'bin';
    const tempPath = path.join(os.tmpdir(), `dingtalk_${Date.now()}.${ext}`);
    fs.writeFileSync(tempPath, Buffer.from(mediaResponse.data as ArrayBuffer));
    return { path: tempPath, mimeType: contentType };
  } catch (err: any) {
    if (log?.error) {
      log.error('[DingTalk] Failed to download media:', err.message);
    }
    return null;
  }
}

function extractMessageContent(data: DingTalkInboundMessage): MessageContent {
  const msgtype = data.msgtype || 'text';

  // Logic for different message types
  if (msgtype === 'text') {
    return { text: data.text?.content?.trim() || '', messageType: 'text' };
  }

  // Improved richText parsing: join all text/at components
  if (msgtype === 'richText') {
    const richTextParts = data.content?.richText || [];
    let text = '';
    for (const part of richTextParts) {
      if (part.type === 'text' && part.text) text += part.text;
      if (part.type === 'at' && part.atName) text += `@${part.atName} `;
    }
    return { text: text.trim() || '[富文本消息]', messageType: 'richText' };
  }

  if (msgtype === 'picture') {
    return { text: '[图片]', mediaPath: data.content?.downloadCode, mediaType: 'image', messageType: 'picture' };
  }

  if (msgtype === 'audio') {
    return {
      text: data.content?.recognition || '[语音消息]',
      mediaPath: data.content?.downloadCode,
      mediaType: 'audio',
      messageType: 'audio',
    };
  }

  if (msgtype === 'video') {
    return { text: '[视频]', mediaPath: data.content?.downloadCode, mediaType: 'video', messageType: 'video' };
  }

  if (msgtype === 'file') {
    return {
      text: `[文件: ${data.content?.fileName || '文件'}]`,
      mediaPath: data.content?.downloadCode,
      mediaType: 'file',
      messageType: 'file',
    };
  }

  // Fallback
  return { text: data.text?.content?.trim() || `[${msgtype}消息]`, messageType: msgtype };
}

// Send message via sessionWebhook
async function sendBySession(
  config: DingTalkConfig,
  sessionWebhook: string,
  text: string,
  options: SendMessageOptions = {}
): Promise<AxiosResponse> {
  const token = await getAccessToken(config, options.log);
  
  // Use shared helper function for markdown detection and title extraction
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, 'Clawdbot 消息');

  let body: SessionWebhookResponse;
  if (useMarkdown) {
    let finalText = text;
    if (options.atUserId) finalText = `${finalText} @${options.atUserId}`;
    body = { msgtype: 'markdown', markdown: { title, text: finalText } };
  } else {
    body = { msgtype: 'text', text: { content: text } };
  }

  if (options.atUserId) body.at = { atUserIds: [options.atUserId], isAtAll: false };

  const result = await axios({
    url: sessionWebhook,
    method: 'POST',
    data: body,
    headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
  });
  return result.data;
}

// ============ AI Card API Functions ============

/**
 * Create and deliver an AI Card using the new DingTalk API (createAndDeliver)
 * @param config DingTalk configuration
 * @param conversationId Conversation ID (starts with 'cid' for groups, user ID for DM)
 * @param data Original message data for context
 * @param accountId Account ID for multi-account support
 * @param log Logger instance
 * @returns AI Card instance or null on failure
 */
async function createAICard(
  config: DingTalkConfig,
  conversationId: string,
  data: DingTalkInboundMessage,
  accountId: string,
  log?: Logger
): Promise<AICardInstance | null> {
  try {
    const token = await getAccessToken(config, log);
    // Use crypto.randomUUID() for robust GUID generation instead of Date.now() + random
    const cardInstanceId = `card_${randomUUID()}`;

    log?.info?.(`[DingTalk][AICard] Creating and delivering card outTrackId=${cardInstanceId}`);
    log?.debug?.(`[DingTalk][AICard] conversationType=${data.conversationType}, conversationId=${conversationId}`);

    const isGroup = conversationId.startsWith('cid');

    // Build the createAndDeliver request body
    const createAndDeliverBody = {
      cardTemplateId: config.cardTemplateId || '382e4302-551d-4880-bf29-a30acfab2e71.schema',
      outTrackId: cardInstanceId,
      cardData: {
        cardParamMap: {},
      },
      callbackType: 'STREAM',
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
      openSpaceId: isGroup ? `dtv1.card//IM_GROUP.${conversationId}` : `dtv1.card//IM_ROBOT.${conversationId}`,
      userIdType: 1,
      imGroupOpenDeliverModel: isGroup ? { robotCode: config.robotCode || config.clientId } : undefined,
      imRobotOpenDeliverModel: !isGroup ? { spaceType: 'IM_ROBOT' } : undefined,
    };

    if (isGroup && !config.robotCode) {
      log?.warn?.(
        '[DingTalk][AICard] robotCode not configured, using clientId as fallback. ' +
          'For best compatibility, set robotCode explicitly in config.'
      );
    }

    log?.debug?.(
      `[DingTalk][AICard] POST /v1.0/card/instances/createAndDeliver body=${JSON.stringify(createAndDeliverBody)}`
    );
    const resp = await axios.post(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, createAndDeliverBody, {
      headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
    });
    log?.debug?.(
      `[DingTalk][AICard] CreateAndDeliver response: status=${resp.status} data=${JSON.stringify(resp.data)}`
    );

    // Cache the AI card instance with config reference for token refresh
    const aiCardInstance: AICardInstance = {
      cardInstanceId,
      accessToken: token,
      conversationId,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      state: AICardStatus.PROCESSING, // Initial state after creation
      config, // Store config reference for token refresh
    };
    aiCardInstances.set(cardInstanceId, aiCardInstance);

    // Add mapping from target to active card ID (accountId:conversationId -> cardInstanceId)
    const targetKey = `${accountId}:${conversationId}`;
    activeCardsByTarget.set(targetKey, cardInstanceId);
    log?.debug?.(`[DingTalk][AICard] Registered active card mapping: ${targetKey} -> ${cardInstanceId}`);

    return aiCardInstance;
  } catch (err: any) {
    log?.error?.(`[DingTalk][AICard] Create failed: ${err.message}`);
    if (err.response) {
      log?.error?.(
        `[DingTalk][AICard] Error response: status=${err.response.status} data=${JSON.stringify(err.response.data)}`
      );
    }
    return null;
  }
}

/**
 * Stream update AI Card content using the new DingTalk API
 * Always use isFull=true to fully replace the Markdown content
 * @param card AI Card instance
 * @param content Content to stream
 * @param finished Whether this is the final update (isFinalize=true)
 * @param log Logger instance
 */
async function streamAICard(
  card: AICardInstance,
  content: string,
  finished: boolean = false,
  log?: Logger
): Promise<void> {
  // Refresh token if it's been more than 1.5 hours since card creation (tokens expire after 2 hours)
  const tokenAge = Date.now() - card.createdAt;
  const TOKEN_REFRESH_THRESHOLD = 90 * 60 * 1000; // 1.5 hours in milliseconds
  
  if (tokenAge > TOKEN_REFRESH_THRESHOLD && card.config) {
    log?.debug?.('[DingTalk][AICard] Token age exceeds threshold, refreshing...');
    try {
      card.accessToken = await getAccessToken(card.config, log);
      log?.debug?.('[DingTalk][AICard] Token refreshed successfully');
    } catch (err: any) {
      log?.warn?.(`[DingTalk][AICard] Failed to refresh token: ${err.message}`);
      // Continue with old token, let the API call fail if token is invalid
    }
  }

  // Call streaming API to update content with full replacement
  const streamBody: AICardStreamingRequest = {
    outTrackId: card.cardInstanceId,
    guid: randomUUID(), // Use crypto.randomUUID() for robust GUID generation
    key: 'content',
    content: content,
    isFull: true, // Always full replacement for Markdown content
    isFinalize: finished, // Set to true on final update to close the streaming channel
    isError: false,
  };

  log?.debug?.(
    `[DingTalk][AICard] PUT /v1.0/card/streaming contentLen=${content.length} isFull=true isFinalize=${finished} guid=${streamBody.guid} payload=${JSON.stringify(streamBody)}`
  );

  try {
    const streamResp = await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, streamBody, {
      headers: { 'x-acs-dingtalk-access-token': card.accessToken, 'Content-Type': 'application/json' },
    });
    log?.debug?.(
      `[DingTalk][AICard] Streaming response: status=${streamResp.status}, data=${JSON.stringify(streamResp.data)}`
    );

    // Update last updated time and state
    card.lastUpdated = Date.now();
    if (finished) {
      card.state = AICardStatus.FINISHED;
    } else if (card.state === AICardStatus.PROCESSING) {
      card.state = AICardStatus.INPUTING;
    }
  } catch (err: any) {
    // Handle 401 errors specifically - try to refresh token once
    if (err.response?.status === 401 && card.config) {
      log?.warn?.('[DingTalk][AICard] Received 401 error, attempting token refresh and retry...');
      try {
        card.accessToken = await getAccessToken(card.config, log);
        // Retry the streaming request with refreshed token
        const retryResp = await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, streamBody, {
          headers: { 'x-acs-dingtalk-access-token': card.accessToken, 'Content-Type': 'application/json' },
        });
        log?.debug?.(
          `[DingTalk][AICard] Retry after token refresh succeeded: status=${retryResp.status}`
        );
        // Update state on successful retry
        card.lastUpdated = Date.now();
        if (finished) {
          card.state = AICardStatus.FINISHED;
        } else if (card.state === AICardStatus.PROCESSING) {
          card.state = AICardStatus.INPUTING;
        }
        return; // Success, exit function
      } catch (retryErr: any) {
        log?.error?.(`[DingTalk][AICard] Retry after token refresh failed: ${retryErr.message}`);
        // Fall through to mark as failed and throw
      }
    }
    
    // Ensure card state reflects the failure to prevent retry loops
    card.state = AICardStatus.FAILED;
    card.lastUpdated = Date.now();
    log?.error?.(
      `[DingTalk][AICard] Streaming update failed: ${err.message}, resp=${JSON.stringify(err.response?.data)}`
    );
    throw err;
  }
}

/**
 * Finalize AI Card: close streaming channel and update to FINISHED state
 * @param card AI Card instance
 * @param content Final content
 * @param log Logger instance
 */
async function finishAICard(card: AICardInstance, content: string, log?: Logger): Promise<void> {
  log?.debug?.(`[DingTalk][AICard] Starting finish, final content length=${content.length}`);

  // Send final content with isFull=true and isFinalize=true to close streaming
  // No separate state update needed - the streaming API handles everything
  await streamAICard(card, content, true, log);
}

// ============ End of New AI Card API Functions ============

// Send message with automatic mode selection (card/markdown)
// Card mode: if an active AI Card exists for the target, stream updates; otherwise fall back to markdown.
async function sendMessage(
  config: DingTalkConfig,
  conversationId: string,
  text: string,
  options: SendMessageOptions & { sessionWebhook?: string; accountId?: string } = {}
): Promise<{ ok: boolean; error?: string; data?: AxiosResponse }> {
  try {
    const messageType = config.messageType || 'markdown';
    const log = options.log || getLogger();

    if (messageType === 'card' && options.accountId) {
      const targetKey = `${options.accountId}:${conversationId}`;
      const activeCardId = activeCardsByTarget.get(targetKey);
      if (activeCardId) {
        const activeCard = aiCardInstances.get(activeCardId);
        if (activeCard && !isCardInTerminalState(activeCard.state)) {
          try {
            await streamAICard(activeCard, text, false, log);
            return { ok: true };
          } catch (err: any) {
            log?.warn?.(`[DingTalk] AI Card streaming failed, fallback to markdown: ${err.message}`);
            activeCard.state = AICardStatus.FAILED;
            activeCard.lastUpdated = Date.now();
          }
        } else {
          activeCardsByTarget.delete(targetKey);
        }
      }
    }

    // Fallback to markdown mode
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

// Message handler
async function handleDingTalkMessage(params: HandleDingTalkMessageParams): Promise<void> {
  const { cfg, accountId, data, sessionWebhook, log, dingtalkConfig } = params;
  const rt = getDingTalkRuntime();

  // Save logger reference globally for use by other methods
  currentLogger = log;

  log?.debug?.('[DingTalk] Full Inbound Data:', JSON.stringify(maskSensitiveData(data)));

  // 0. 清理过期的卡片缓存
  cleanupCardCache();

  // 1. 过滤机器人自身消息
  if (data.senderId === data.chatbotUserId || data.senderStaffId === data.chatbotUserId) {
    log?.debug?.('[DingTalk] Ignoring robot self-message');
    return;
  }

  const content = extractMessageContent(data);
  if (!content.text) return;

  const isDirect = data.conversationType === '1';
  const senderId = data.senderStaffId || data.senderId;
  const senderName = data.senderNick || 'Unknown';
  const groupId = data.conversationId;
  const groupName = data.conversationTitle || 'Group';

  // 2. Check authorization for direct messages based on dmPolicy
  let commandAuthorized = true;
  if (isDirect) {
    const dmPolicy = dingtalkConfig.dmPolicy || 'open';
    const allowFrom = dingtalkConfig.allowFrom || [];

    if (dmPolicy === 'allowlist') {
      const normalizedAllowFrom = normalizeAllowFrom(allowFrom);
      const isAllowed = isSenderAllowed({ allow: normalizedAllowFrom, senderId });

      if (!isAllowed) {
        log?.debug?.(`[DingTalk] DM blocked: senderId=${senderId} not in allowlist (dmPolicy=allowlist)`);

        // Notify user with their sender ID so they can request access
        try {
          await sendBySession(
            dingtalkConfig,
            sessionWebhook,
            `⛔ 访问受限\n\n您的用户ID：\`${senderId}\`\n\n请联系管理员将此ID添加到允许列表中。`,
            { log }
          );
        } catch (err: any) {
          log?.debug?.(`[DingTalk] Failed to send access denied message: ${err.message}`);
        }

        return;
      }

      log?.debug?.(`[DingTalk] DM authorized: senderId=${senderId} in allowlist`);
    } else if (dmPolicy === 'pairing') {
      // For pairing mode, SDK will handle the authorization
      // Set commandAuthorized to true to let SDK check pairing status
      commandAuthorized = true;
    } else {
      // 'open' policy - allow all
      commandAuthorized = true;
    }
  }

  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (content.mediaPath && dingtalkConfig.robotCode) {
    const media = await downloadMedia(dingtalkConfig, content.mediaPath, log);
    if (media) {
      mediaPath = media.path;
      mediaType = media.mimeType;
    }
  }

  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: 'dingtalk',
    accountId,
    peer: { kind: isDirect ? 'dm' : 'group', id: isDirect ? senderId : groupId },
  });

  const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
  const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = rt.channel.session.readSessionUpdatedAt({ storePath, sessionKey: route.sessionKey });

  const fromLabel = isDirect ? `${senderName} (${senderId})` : `${groupName} - ${senderName}`;
  const body = rt.channel.reply.formatInboundEnvelope({
    channel: 'DingTalk',
    from: fromLabel,
    timestamp: data.createAt,
    body: content.text,
    chatType: isDirect ? 'direct' : 'group',
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
    ChatType: isDirect ? 'direct' : 'group',
    ConversationLabel: fromLabel,
    GroupSubject: isDirect ? undefined : groupName,
    SenderName: senderName,
    SenderId: senderId,
    Provider: 'dingtalk',
    Surface: 'dingtalk',
    MessageSid: data.msgId,
    Timestamp: data.createAt,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: 'dingtalk',
    OriginatingTo: to,
  });

  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey || route.sessionKey,
    ctx,
    updateLastRoute: { sessionKey: route.mainSessionKey, channel: 'dingtalk', to, accountId },
    onRecordError: (err: unknown) => {
      log?.error?.(`[DingTalk] Failed to record inbound session: ${String(err)}`);
    },
  });

  log?.info?.(`[DingTalk] Inbound: from=${senderName} text="${content.text.slice(0, 50)}..."`);

  // Determine if we are in card mode, if so, create or reuse card instance first
  const useCardMode = dingtalkConfig.messageType === 'card';
  let currentAICard: AICardInstance | undefined;
  let lastCardContent = '';

  if (useCardMode) {
    // Try to reuse an existing active AI card for this target, if available
    const targetKey = `${accountId}:${to}`;
    const existingCardId = activeCardsByTarget.get(targetKey);
    const existingCard = existingCardId ? aiCardInstances.get(existingCardId) : undefined;

    // Only reuse cards that are not in terminal states
    if (existingCard && !isCardInTerminalState(existingCard.state)) {
      currentAICard = existingCard;
      log?.debug?.('[DingTalk] Reusing existing active AI card for this conversation.');
    } else {
      // Create a new AI card
      const aiCard = await createAICard(dingtalkConfig, to, data, accountId, log);
      if (aiCard) {
        currentAICard = aiCard;
      } else {
        log?.warn?.('[DingTalk] Failed to create AI card, fallback to text/markdown.');
      }
    }
  }

  // Feedback: Thinking...
  if (dingtalkConfig.showThinking !== false) {
    try {
      const thinkingText = '🤔 思考中，请稍候...';
      // AI card already has thinking state visually, so we only send thinking message for non-card modes
      if (useCardMode && currentAICard) {
        log?.debug?.('[DingTalk] AI Card in thinking state, skipping thinking message send.');
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
      responsePrefix: '',
      deliver: async (payload: any) => {
        try {
          const textToSend = payload.markdown || payload.text;
          if (!textToSend) return;

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
  });

  try {
    // Finalize AI card
    if (useCardMode && currentAICard) {
      try {
        // Helper function to check if a value is a non-empty string
        const isNonEmptyString = (value: any): boolean =>
          typeof value === 'string' && value.trim().length > 0;

        // Validate that we have actual content before finalization
        const hasLastCardContent = isNonEmptyString(lastCardContent);
        const hasQueuedFinalString = isNonEmptyString(queuedFinal);

        if (hasLastCardContent || hasQueuedFinalString) {
          const finalContent = hasLastCardContent ? lastCardContent : (queuedFinal as string);
          await finishAICard(currentAICard, finalContent, log);
        } else {
          // No textual content was produced; skip finalization with empty content
          log?.debug?.(
            '[DingTalk] Skipping AI Card finalization because no textual content was produced.'
          );
          // Still mark the card as finished to allow cleanup
          currentAICard.state = AICardStatus.FINISHED;
          currentAICard.lastUpdated = Date.now();
        }
      } catch (err: any) {
        log?.debug?.(`[DingTalk] AI Card finalization failed: ${err.message}`);
        // Ensure the AI card transitions to a terminal error state
        try {
          if (currentAICard.state !== AICardStatus.FINISHED) {
            currentAICard.state = AICardStatus.FAILED;
            currentAICard.lastUpdated = Date.now();
          }
        } catch (stateErr: any) {
          // Log state update failure at debug level to aid production debugging
          log?.debug?.(`[DingTalk] Failed to update card state to FAILED: ${stateErr.message}`);
        }
      }
    }
  } finally {
    if (mediaPath && fs.existsSync(mediaPath)) {
      try {
        fs.unlinkSync(mediaPath);
      } catch (_err) {
        // Ignore cleanup errors
      }
    }
  }
}

// DingTalk Channel Definition
export const dingtalkPlugin = {
  id: 'dingtalk',
  meta: {
    id: 'dingtalk',
    label: 'DingTalk',
    selectionLabel: 'DingTalk (钉钉)',
    docsPath: '/channels/dingtalk',
    blurb: '钉钉企业内部机器人，使用 Stream 模式，无需公网 IP。',
    aliases: ['dd', 'ding'],
  },
  configSchema: buildChannelConfigSchema(DingTalkConfigSchema),
  capabilities: {
    chatTypes: ['direct', 'group'],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
    outbound: true,
  },
  reload: { configPrefixes: ['channels.dingtalk'] },
  config: {
    listAccountIds: (cfg: OpenClawConfig): string[] => {
      const config = getConfig(cfg);
      return config.accounts ? Object.keys(config.accounts) : isConfigured(cfg) ? ['default'] : [];
    },
    resolveAccount: (cfg: OpenClawConfig, accountId?: string) => {
      const config = getConfig(cfg);
      const id = accountId || 'default';
      const account = config.accounts?.[id];
      return account
        ? { accountId: id, config: account, enabled: account.enabled !== false }
        : { accountId: 'default', config, enabled: config.enabled !== false };
    },
    defaultAccountId: (): string => 'default',
    isConfigured: (account: any): boolean => Boolean(account.config?.clientId && account.config?.clientSecret),
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      name: account.config?.name || 'DingTalk',
      enabled: account.enabled,
      configured: Boolean(account.config?.clientId),
    }),
  },
  security: {
    resolveDmPolicy: ({ account }: any) => ({
      policy: account.config?.dmPolicy || 'open',
      allowFrom: account.config?.allowFrom || [],
      policyPath: 'channels.dingtalk.dmPolicy',
      allowFromPath: 'channels.dingtalk.allowFrom',
      approveHint: '使用 /allow dingtalk:<userId> 批准用户',
      normalizeEntry: (raw: string) => raw.replace(/^(dingtalk|dd|ding):/i, ''),
    }),
  },
  groups: {
    resolveRequireMention: ({ cfg }: any): boolean => getConfig(cfg).groupPolicy !== 'open',
  },
  messaging: {
    normalizeTarget: ({ target }: any) => (target ? { targetId: target.replace(/^(dingtalk|dd|ding):/i, '') } : null),
    targetResolver: { looksLikeId: (id: string): boolean => /^[\w-]+$/.test(id), hint: '<conversationId>' },
  },
  outbound: {
    deliveryMode: 'direct',
    resolveTarget: ({ to }: any) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error('DingTalk message requires --to <conversationId>'),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ cfg, to, text, accountId, log }: any) => {
      const config = getConfig(cfg, accountId);
      try {
        const result = await sendMessage(config, to, text, { log, accountId });
        getLogger()?.debug?.(`[DingTalk] sendText: "${text}" result: ${JSON.stringify(result)}`);
        return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
      } catch (err: any) {
        return { ok: false, error: err.response?.data || err.message };
      }
    },
    sendMedia: async ({ cfg, to, mediaPath, accountId, log }: any) => {
      const config = getConfig(cfg, accountId);
      if (!config.clientId) {
        return { ok: false, error: 'DingTalk not configured' };
      }
      try {
        const mediaDescription = `[媒体消息（暂不支持直发）: ${mediaPath}]`;
        const result = await sendMessage(config, to, mediaDescription, { log, accountId });
        getLogger()?.debug?.(`[DingTalk] sendMedia: "${mediaDescription}" result: ${JSON.stringify(result)}`);
        return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
      } catch (err: any) {
        return { ok: false, error: err.response?.data || err.message };
      }
    },
  },
  gateway: {
    startAccount: async (ctx: GatewayStartContext): Promise<GatewayStopResult> => {
      const { account, cfg, abortSignal } = ctx;
      const config = account.config;
      if (!config.clientId || !config.clientSecret) throw new Error('DingTalk clientId and clientSecret are required');
      if (ctx.log?.info) {
        ctx.log.info(`[${account.accountId}] Starting DingTalk Stream client...`);
      }

      cleanupOrphanedTempFiles(ctx.log);

      const client = new DWClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        debug: config.debug || false,
        keepAlive: true,
      });

      client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
        const messageId = res.headers?.messageId;
        try {
          if (messageId) {
            client.socketCallBackResponse(messageId, { success: true });
          }
          const data = JSON.parse(res.data) as DingTalkInboundMessage;
          await handleDingTalkMessage({
            cfg,
            accountId: account.accountId,
            data,
            sessionWebhook: data.sessionWebhook,
            log: ctx.log,
            dingtalkConfig: config,
          });
        } catch (error: any) {
          if (ctx.log?.error) {
            ctx.log.error(`[DingTalk] Error processing message: ${error.message}`);
          }
        }
      });

      await client.connect();
      if (ctx.log?.info) {
        ctx.log.info(`[${account.accountId}] DingTalk Stream client connected`);
      }
      let stopped = false;
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          if (stopped) return;
          stopped = true;
          if (ctx.log?.info) {
            ctx.log.info(`[${account.accountId}] Stopping DingTalk Stream client...`);
          }
        });
      }
      return {
        stop: () => {
          if (stopped) return;
          stopped = true;
          if (ctx.log?.info) {
            ctx.log.info(`[${account.accountId}] DingTalk provider stopped`);
          }
        },
      };
    },
  },
  status: {
    defaultRuntime: { accountId: 'default', running: false, lastStartAt: null, lastStopAt: null, lastError: null },
    probe: async ({ cfg }: any) => {
      if (!isConfigured(cfg)) return { ok: false, error: 'Not configured' };
      try {
        const config = getConfig(cfg);
        await getAccessToken(config);
        return { ok: true, details: { clientId: config.clientId } };
      } catch (error: any) {
        return { ok: false, error: error.message };
      }
    },
    buildChannelSummary: ({ snapshot }: any) => ({
      configured: snapshot?.configured ?? false,
      running: snapshot?.running ?? false,
      lastStartAt: snapshot?.lastStartAt ?? null,
      lastStopAt: snapshot?.lastStopAt ?? null,
      lastError: snapshot?.lastError ?? null,
    }),
  },
};

/**
 * Public low-level API exports for the DingTalk channel plugin.
 *
 * - {@link sendBySession} sends a message to DingTalk using a session/webhook
 *   (e.g. replies within an existing conversation).
 * - {@link createAICard} creates and delivers an AI Card using the DingTalk API
 *   (returns AICardInstance for streaming updates). Automatically registers the card
 *   in activeCardsByTarget mapping (accountId:conversationId -> cardInstanceId).
 * - {@link streamAICard} streams content updates to an AI Card
 *   (for real-time streaming message updates).
 * - {@link finishAICard} finalizes an AI Card and sets state to FINISHED
 *   (closes streaming channel and updates card state).
 * - {@link sendMessage} sends a message with automatic mode selection
 *   (text/markdown/card based on config).
 * - {@link getAccessToken} retrieves (and caches) the DingTalk access token
 *   for the configured application/runtime.
 * - {@link getLogger} retrieves the current global logger instance
 *   (set by handleDingTalkMessage during inbound message processing).
 *
 * These exports are intended to be used by external integrations that need
 * direct programmatic access to DingTalk messaging and authentication.
 */
export { sendBySession, createAICard, streamAICard, finishAICard, sendMessage, getAccessToken, getLogger };
