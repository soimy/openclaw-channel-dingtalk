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
  InteractiveCardData,
  InteractiveCardSendRequest,
  InteractiveCardUpdateRequest,
  CardInstance,
} from './types';

// Access Token cache
let accessToken: string | null = null;
let accessTokenExpiry = 0;

// Card instance cache for streaming updates
const cardInstances = new Map<string, CardInstance>();

// Card update throttling - track last update time per card
const cardUpdateTimestamps = new Map<string, number>();
const CARD_UPDATE_MIN_INTERVAL = 500; // Minimum 500ms between updates

// Card update timeout tracking - auto-finalize if no updates for a while
const cardUpdateTimeouts = new Map<string, NodeJS.Timeout>();
const CARD_UPDATE_TIMEOUT = 60000; // 60 seconds of inactivity = finalized

// Card cache TTL (1 hour)
const CARD_CACHE_TTL = 60 * 60 * 1000; // 1 hour

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

// Clean up old card instances from cache
function cleanupCardCache() {
  const now = Date.now();
  for (const [cardBizId, instance] of cardInstances.entries()) {
    if (now - instance.lastUpdated > CARD_CACHE_TTL) {
      cardInstances.delete(cardBizId);
      cardUpdateTimestamps.delete(cardBizId);
      const timeout = cardUpdateTimeouts.get(cardBizId);
      if (timeout) {
        clearTimeout(timeout);
        cardUpdateTimeouts.delete(cardBizId);
      }
    }
  }
}

// Run cleanup periodically (every 30 minutes)
let cleanupIntervalId: NodeJS.Timeout | null = setInterval(cleanupCardCache, 30 * 60 * 1000);

// Cleanup function to stop the interval
function stopCardCacheCleanup() {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
  // Clear all pending timeouts
  for (const timeout of cardUpdateTimeouts.values()) {
    clearTimeout(timeout);
  }
  cardUpdateTimeouts.clear();
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
  const dingtalkCfg = cfg?.channels?.dingtalk;
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

// Send proactive message via DingTalk OpenAPI
async function sendProactiveMessage(
  config: DingTalkConfig,
  target: string,
  text: string,
  log?: Logger
): Promise<AxiosResponse>;
async function sendProactiveMessage(
  config: DingTalkConfig,
  target: string,
  text: string,
  options?: SendMessageOptions
): Promise<AxiosResponse>;
async function sendProactiveMessage(
  config: DingTalkConfig,
  target: string,
  text: string,
  optionsOrLog: SendMessageOptions | Logger | undefined = {} as SendMessageOptions
): Promise<AxiosResponse> {
  // Handle backward compatibility: support both Logger and SendMessageOptions
  let options: SendMessageOptions;
  if (!optionsOrLog) {
    options = {};
  } else if (
    typeof optionsOrLog === 'object' &&
    optionsOrLog !== null &&
    ('log' in optionsOrLog || 'useMarkdown' in optionsOrLog || 'title' in optionsOrLog || 'atUserId' in optionsOrLog)
  ) {
    options = optionsOrLog;
  } else {
    // Assume it's a Logger object
    options = { log: optionsOrLog as Logger };
  }

  const token = await getAccessToken(config, options.log);
  const isGroup = target.startsWith('cid');

  const url = isGroup
    ? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
    : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';

  // Use shared helper function for markdown detection and title extraction
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, 'Clawdbot 提醒');

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

// Send interactive card (for initial card creation)
async function sendInteractiveCard(
  config: DingTalkConfig,
  conversationId: string,
  text: string,
  options: SendMessageOptions = {}
): Promise<{ cardBizId: string; response: any }> {
  // Validate robotCode is configured
  const robotCode = config.robotCode || config.clientId;
  if (!robotCode) {
    throw new Error('[DingTalk] robotCode or clientId is required for sending interactive cards');
  }

  const token = await getAccessToken(config, options.log);
  const isGroup = conversationId.startsWith('cid');
  
  // Generate unique card business ID using crypto.randomUUID
  const cardBizId = `card_${randomUUID()}`;
  
  // Extract title and detect markdown
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, 'Clawdbot 消息');
  
  // Build card data structure with markdown support
  const cardData: InteractiveCardData = {
    config: {
      autoLayout: true,
      enableForward: true,
    },
    header: {
      title: {
        type: 'text',
        text: title,
      },
    },
    contents: [
      {
        type: useMarkdown ? 'markdown' : 'text',
        text: text,
      },
    ],
  };
  
  // Build request payload
  const payload: InteractiveCardSendRequest = {
    cardTemplateId: config.cardTemplateId || 'StandardCard',
    cardBizId,
    robotCode,
    cardData: JSON.stringify(cardData),
  };
  
  if (isGroup) {
    payload.openConversationId = conversationId;
  } else {
    payload.singleChatReceiver = JSON.stringify({ userId: conversationId });
  }
  
  // Use configurable API URL with retry logic
  const apiUrl =
    config.cardSendApiUrl || 'https://api.dingtalk.com/v1.0/im/v1.0/robot/interactiveCards/send';
  
  const result = await retryWithBackoff(
    async () => {
      return await axios({
        url: apiUrl,
        method: 'POST',
        data: payload,
        headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
      });
    },
    { maxRetries: 3, log: options.log }
  );
  
  // Cache card instance for future updates
  cardInstances.set(cardBizId, {
    cardBizId,
    conversationId,
    createdAt: Date.now(),
    lastUpdated: Date.now(),
  });
  
  return { cardBizId, response: result.data };
}

// Update existing interactive card (for streaming updates)
async function updateInteractiveCard(
  config: DingTalkConfig,
  cardBizId: string,
  text: string,
  options: SendMessageOptions = {}
): Promise<any> {
  const token = await getAccessToken(config, options.log);
  
  // Extract title and detect markdown
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, 'Clawdbot 消息');
  
  // Build updated card data with markdown support
  const cardData: InteractiveCardData = {
    config: {
      autoLayout: true,
      enableForward: true,
    },
    header: {
      title: {
        type: 'text',
        text: title,
      },
    },
    contents: [
      {
        type: useMarkdown ? 'markdown' : 'text',
        text: text,
      },
    ],
  };
  
  // Build update request
  const payload: InteractiveCardUpdateRequest = {
    cardBizId,
    cardData: JSON.stringify(cardData),
    updateOptions: {
      updateCardDataByKey: false,
    },
  };
  
  // Use configurable API URL with retry logic
  const apiUrl = config.cardUpdateApiUrl || 'https://api.dingtalk.com/v1.0/im/robots/interactiveCards';
  
  try {
    const result = await retryWithBackoff(
      async () => {
        return await axios({
          url: apiUrl,
          method: 'PUT',
          data: payload,
          headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
        });
      },
      { maxRetries: 3, log: options.log }
    );
    
    // Update cache on success
    const instance = cardInstances.get(cardBizId);
    if (instance) {
      instance.lastUpdated = Date.now();
    }
    
    return result.data;
  } catch (err: any) {
    // Remove card from cache on terminal errors (404, 410, etc.)
    const statusCode = err.response?.status;
    if (statusCode === 404 || statusCode === 410 || statusCode === 403) {
      options.log?.debug?.(
        `[DingTalk] Removing card ${cardBizId} from cache due to error ${statusCode}`
      );
      cardInstances.delete(cardBizId);
    }
    throw err;
  }
}

// Throttled card update wrapper with timeout mechanism
async function updateInteractiveCardThrottled(
  config: DingTalkConfig,
  cardBizId: string,
  text: string,
  options: SendMessageOptions = {}
): Promise<any> {
  const now = Date.now();
  const lastUpdate = cardUpdateTimestamps.get(cardBizId) || 0;
  const timeSinceLastUpdate = now - lastUpdate;
  
  // Clear any existing timeout for this card
  const existingTimeout = cardUpdateTimeouts.get(cardBizId);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }
  
  // If enough time has passed, update immediately
  if (timeSinceLastUpdate >= CARD_UPDATE_MIN_INTERVAL) {
    cardUpdateTimestamps.set(cardBizId, now);
    const result = await updateInteractiveCard(config, cardBizId, text, options);
    
    // Set timeout to detect when updates are complete
    const timeout = setTimeout(() => {
      cardUpdateTimeouts.delete(cardBizId);
      options.log?.debug?.(`[DingTalk] Card ${cardBizId} finalized after inactivity timeout`);
    }, CARD_UPDATE_TIMEOUT);
    
    cardUpdateTimeouts.set(cardBizId, timeout);
    return result;
  } else {
    // Schedule update after the minimum interval
    return new Promise((resolve, reject) => {
      const delay = CARD_UPDATE_MIN_INTERVAL - timeSinceLastUpdate;
      const timeout = setTimeout(async () => {
        try {
          cardUpdateTimestamps.set(cardBizId, Date.now());
          const result = await updateInteractiveCard(config, cardBizId, text, options);
          
          // Set inactivity timeout
          const inactivityTimeout = setTimeout(() => {
            cardUpdateTimeouts.delete(cardBizId);
            options.log?.debug?.(`[DingTalk] Card ${cardBizId} finalized after inactivity timeout`);
          }, CARD_UPDATE_TIMEOUT);
          
          cardUpdateTimeouts.set(cardBizId, inactivityTimeout);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }, delay);
      
      cardUpdateTimeouts.set(cardBizId, timeout);
    });
  }
}

// Send message with automatic mode selection (text/markdown/card)
async function sendMessage(
  config: DingTalkConfig,
  conversationId: string,
  text: string,
  options: SendMessageOptions & { cardBizId?: string; sessionWebhook?: string } = {}
): Promise<{ ok: boolean; cardBizId?: string; error?: string }> {
  try {
    const messageType = config.messageType || 'markdown';
    
    // If sessionWebhook is provided, use session-based sending (for replies during conversation)
    if (options.sessionWebhook) {
      await sendBySession(config, options.sessionWebhook, text, options);
      return { ok: true };
    }
    
    // For card mode with streaming
    if (messageType === 'card') {
      if (options.cardBizId) {
        // Update existing card
        await updateInteractiveCard(config, options.cardBizId, text, options);
        return { ok: true, cardBizId: options.cardBizId };
      } else {
        // Create new card
        const { cardBizId } = await sendInteractiveCard(config, conversationId, text, options);
        return { ok: true, cardBizId };
      }
    }
    
    // For text/markdown mode (backward compatibility)
    await sendProactiveMessage(config, conversationId, text, options);
    return { ok: true };
  } catch (err: any) {
    options.log?.error?.(`[DingTalk] Send message failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Message handler
async function handleDingTalkMessage(params: HandleDingTalkMessageParams): Promise<void> {
  const { cfg, accountId, data, sessionWebhook, log, dingtalkConfig } = params;
  const rt = getDingTalkRuntime();

  log?.debug?.('[DingTalk] Full Inbound Data:', JSON.stringify(maskSensitiveData(data)));

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
          await sendBySession(dingtalkConfig, sessionWebhook, 
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
  });

  log?.info?.(`[DingTalk] Inbound: from=${senderName} text="${content.text.slice(0, 50)}..."`);

  // Feedback: Thinking...
  let currentCardBizId: string | undefined;
  const useCardMode = dingtalkConfig.messageType === 'card';
  
  if (dingtalkConfig.showThinking !== false) {
    try {
      if (useCardMode) {
        // For card mode, send initial card with thinking message
        const result = await sendInteractiveCard(dingtalkConfig, to, '🤔 思考中，请稍候...', { log });
        currentCardBizId = result.cardBizId;
      } else {
        // For text/markdown mode, send via session webhook
        await sendBySession(dingtalkConfig, sessionWebhook, '🤔 思考中，请稍候...', {
          atUserId: !isDirect ? senderId : null,
          log,
        });
      }
    } catch (err: any) {
      log?.debug?.(`[DingTalk] Thinking message failed: ${err.message}`);
    }
  }

  const { dispatcher, replyOptions, markDispatchIdle } = rt.channel.reply.createReplyDispatcherWithTyping({
    responsePrefix: '',
    deliver: async (payload: any) => {
      try {
        const textToSend = payload.markdown || payload.text;
        if (!textToSend) return { ok: true };
        
        if (useCardMode) {
          // Card mode: update existing card or create new one (throttled)
          if (currentCardBizId) {
            await updateInteractiveCard(dingtalkConfig, currentCardBizId, textToSend, { log });
          } else {
            const result = await sendInteractiveCard(dingtalkConfig, to, textToSend, { log });
            currentCardBizId = result.cardBizId;
          }
        } else {
          // Text/markdown mode: send via session webhook
          await sendBySession(dingtalkConfig, sessionWebhook, textToSend, {
            atUserId: !isDirect ? senderId : null,
            log,
          });
        }
        return { ok: true };
      } catch (err: any) {
        log?.error?.(`[DingTalk] Reply failed: ${err.message}`);
        return { ok: false, error: err.message };
      }
    },
  });

  try {
    await rt.channel.reply.dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyOptions });
  } finally {
    markDispatchIdle();
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
        const result = await sendProactiveMessage(config, to, text, { log });
        return { ok: true, data: result };
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
        const mediaDescription = `[媒体消息: ${mediaPath}]`;
        const result = await sendProactiveMessage(config, to, mediaDescription, { log });
        return { ok: true, data: result };
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
      const rt = getDingTalkRuntime();
      rt.channel.activity.record('dingtalk', account.accountId, 'start');
      let stopped = false;
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          if (stopped) return;
          stopped = true;
          if (ctx.log?.info) {
            ctx.log.info(`[${account.accountId}] Stopping DingTalk Stream client...`);
          }
          rt.channel.activity.record('dingtalk', account.accountId, 'stop');
        });
      }
      return {
        stop: () => {
          if (stopped) return;
          stopped = true;
          if (ctx.log?.info) {
            ctx.log.info(`[${account.accountId}] DingTalk provider stopped`);
          }
          rt.channel.activity.record('dingtalk', account.accountId, 'stop');
          // Clean up card cache cleanup interval
          stopCardCacheCleanup();
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
 * - {@link sendProactiveMessage} sends a proactive/outbound message to DingTalk
 *   without requiring an existing inbound session.
 * - {@link sendInteractiveCard} sends an interactive card to DingTalk
 *   (returns cardBizId for streaming updates).
 * - {@link updateInteractiveCard} updates an existing interactive card
 *   (for streaming message updates).
 * - {@link updateInteractiveCardThrottled} throttled version of updateInteractiveCard
 *   with rate limiting and auto-finalization timeout (recommended for streaming).
 * - {@link sendMessage} sends a message with automatic mode selection
 *   (text/markdown/card based on config).
 * - {@link getAccessToken} retrieves (and caches) the DingTalk access token
 *   for the configured application/runtime.
 *
 * These exports are intended to be used by external integrations that need
 * direct programmatic access to DingTalk messaging and authentication.
 */
export {
  sendBySession,
  sendProactiveMessage,
  sendInteractiveCard,
  updateInteractiveCard,
  updateInteractiveCardThrottled,
  sendMessage,
  getAccessToken,
};
