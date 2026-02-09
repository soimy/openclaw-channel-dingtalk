import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import axios from 'axios';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { buildChannelConfigSchema } from 'openclaw/plugin-sdk';
import { maskSensitiveData, cleanupOrphanedTempFiles, retryWithBackoff } from '../utils';
import { getDingTalkRuntime } from './runtime';
import { DingTalkConfigSchema } from './config-schema.js';
import { registerPeerId, resolveOriginalPeerId } from './peer-id-registry';
import { ConnectionManager } from './connection-manager';
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
  ConnectionManagerConfig,
} from './types';
import { AICardStatus } from './types';
import { detectMediaTypeFromExtension, uploadMedia as uploadMediaUtil } from './media-utils';

/**
 * Get current timestamp in ISO 8601 format for status tracking
 */
function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

// Access Token cache - keyed by clientId for multi-account support
interface TokenCache {
  accessToken: string;
  expiry: number;
}
const accessTokenCache = new Map<string, TokenCache>();

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

// ============ Message Deduplication ============
// Prevents duplicate message processing when DingTalk retries delivery
// Uses pure in-memory storage with short TTL and lazy cleanup during processing

const processedMessages = new Map<string, number>(); // Map<dedupKey, expiresAt>
const MESSAGE_DEDUP_TTL = 60000; // 60 seconds
const MESSAGE_DEDUP_MAX_SIZE = 1000; // Hard cap to prevent memory pressure during bursts
let messageCounter = 0; // Counter for deterministic cleanup triggering (safe due to Node.js single-threaded event loop)

// Check if message was already processed (with lazy cleanup of expired entries)
function isMessageProcessed(dedupKey: string): boolean {
  const now = Date.now();
  const expiresAt = processedMessages.get(dedupKey);
  
  if (expiresAt === undefined) {
    return false;
  }
  
  // Lazy cleanup: remove expired entry if found
  if (now >= expiresAt) {
    processedMessages.delete(dedupKey);
    return false;
  }
  
  return true;
}

// Mark message as processed with bot-scoped key
function markMessageProcessed(dedupKey: string): void {
  const expiresAt = Date.now() + MESSAGE_DEDUP_TTL;
  processedMessages.set(dedupKey, expiresAt);
  
  // Hard cap: if Map exceeds max size, force immediate cleanup
  if (processedMessages.size > MESSAGE_DEDUP_MAX_SIZE) {
    const now = Date.now();
    for (const [key, expiry] of processedMessages.entries()) {
      if (now >= expiry) {
        processedMessages.delete(key);
      }
    }
    // If still over limit after cleanup, clear oldest entries (safety valve)
    // Maps maintain insertion order, so we can delete early entries
    if (processedMessages.size > MESSAGE_DEDUP_MAX_SIZE) {
      const removeCount = processedMessages.size - MESSAGE_DEDUP_MAX_SIZE;
      let removed = 0;
      for (const key of processedMessages.keys()) {
        processedMessages.delete(key);
        if (++removed >= removeCount) break;
      }
    }
    return; // Skip regular cleanup since we just did a full sweep
  }
  
  // Lazy cleanup: remove expired entries deterministically every 10 messages
  // With 60s TTL, Map stays small under normal load, but we avoid cleanup on every message for performance
  messageCounter++;
  if (messageCounter >= 10) {
    messageCounter = 0;
    const now = Date.now();
    for (const [key, expiry] of processedMessages.entries()) {
      if (now >= expiry) {
        processedMessages.delete(key);
      }
    }
  }
}

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
function isSenderAllowed(params: { allow: NormalizedAllowFrom; senderId?: string }): boolean {
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

// ============ Group Members Persistence ============

function groupMembersFilePath(storePath: string, groupId: string): string {
  const dir = path.join(path.dirname(storePath), 'dingtalk-members');
  const safeId = groupId.replace(/\+/g, '-').replace(/\//g, '_');
  return path.join(dir, `${safeId}.json`);
}

function noteGroupMember(storePath: string, groupId: string, userId: string, name: string): void {
  if (!userId || !name) return;
  const filePath = groupMembersFilePath(storePath, groupId);
  let roster: Record<string, string> = {};
  try {
    roster = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {}
  if (roster[userId] === name) return;
  roster[userId] = name;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(roster, null, 2));
}

function formatGroupMembers(storePath: string, groupId: string): string | undefined {
  const filePath = groupMembersFilePath(storePath, groupId);
  let roster: Record<string, string> = {};
  try {
    roster = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
  const entries = Object.entries(roster);
  if (entries.length === 0) return undefined;
  return entries.map(([id, name]) => `${name} (${id})`).join(', ');
}

// ============ Group Config Resolution ============

function resolveGroupConfig(cfg: DingTalkConfig, groupId: string): { systemPrompt?: string } | undefined {
  const groups = cfg.groups;
  if (!groups) return undefined;
  return groups[groupId] || groups['*'] || undefined;
}

// ============ Target Prefix Helpers ============

/**
 * Strip group: or user: prefix from target ID
 * Returns the raw targetId and whether it was explicitly marked as a user
 */
function stripTargetPrefix(target: string): { targetId: string; isExplicitUser: boolean } {
  if (target.startsWith('group:')) {
    return { targetId: target.slice(6), isExplicitUser: false };
  }
  if (target.startsWith('user:')) {
    return { targetId: target.slice(5), isExplicitUser: true };
  }
  return { targetId: target, isExplicitUser: false };
}

// ============ Config Helpers ============

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

const DEFAULT_AGENT_ID = 'main';
const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_AGENT_ID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return DEFAULT_AGENT_ID;
  if (VALID_AGENT_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_AGENT_ID_CHARS_RE, '-')
      .replace(LEADING_DASH_RE, '')
      .replace(TRAILING_DASH_RE, '')
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('~')) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

function resolveDefaultAgentWorkspaceDir(): string {
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== 'default') {
    return path.join(os.homedir(), '.openclaw', `workspace-${profile}`);
  }
  return path.join(os.homedir(), '.openclaw', 'workspace');
}

interface AgentConfig {
  id?: string;
  default?: boolean;
  workspace?: string;
}

function resolveDefaultAgentId(cfg: OpenClawConfig): string {
  const agents: AgentConfig[] = cfg.agents?.list ?? [];
  if (agents.length === 0) return DEFAULT_AGENT_ID;
  const defaults = agents.filter((agent: AgentConfig) => agent?.default);
  const chosen = (defaults[0] ?? agents[0])?.id?.trim();
  return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}

function resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string): string {
  const id = normalizeAgentId(agentId);
  const agents: AgentConfig[] = cfg.agents?.list ?? [];
  const agent = agents.find((entry: AgentConfig) => normalizeAgentId(entry?.id) === id);
  const configured = agent?.workspace?.trim();
  if (configured) return resolveUserPath(configured);
  const defaultAgentId = resolveDefaultAgentId(cfg);
  if (id === defaultAgentId) {
    const fallback = cfg.agents?.defaults?.workspace?.trim();
    if (fallback) return resolveUserPath(fallback);
    return resolveDefaultAgentWorkspaceDir();
  }
  return path.join(os.homedir(), '.openclaw', `workspace-${id}`);
}

// Get Access Token with retry logic - uses clientId-based cache for multi-account support
async function getAccessToken(config: DingTalkConfig, log?: Logger): Promise<string> {
  const cacheKey = config.clientId;
  const now = Date.now();
  const cached = accessTokenCache.get(cacheKey);

  if (cached && cached.expiry > now + 60000) {
    return cached.accessToken;
  }

  const token = await retryWithBackoff(
    async () => {
      const response = await axios.post<TokenInfo>('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        appKey: config.clientId,
        appSecret: config.clientSecret,
      });

      // Store in cache with clientId as key
      accessTokenCache.set(cacheKey, {
        accessToken: response.data.accessToken,
        expiry: now + response.data.expireIn * 1000,
      });

      return response.data.accessToken;
    },
    { maxRetries: 3, log }
  );

  return token;
}

// Wrapper function to upload media via uploadMediaUtil with getAccessToken bound
async function uploadMedia(
  config: DingTalkConfig,
  mediaPath: string,
  mediaType: 'image' | 'voice' | 'video' | 'file',
  log?: Logger
): Promise<string | null> {
  return uploadMediaUtil(config, mediaPath, mediaType, getAccessToken, log);
}

// Send text/markdown proactive message via DingTalk OpenAPI
async function sendProactiveTextOrMarkdown(
  config: DingTalkConfig,
  target: string,
  text: string,
  options: SendMessageOptions = {}
): Promise<AxiosResponse> {
  const token = await getAccessToken(config, options.log);
  const log = options.log || getLogger();

  // Support group: and user: prefixes, and resolve case-sensitive conversationId
  const { targetId, isExplicitUser } = stripTargetPrefix(target);
  const resolvedTarget = resolveOriginalPeerId(targetId);
  const isGroup = !isExplicitUser && resolvedTarget.startsWith('cid');

  const url = isGroup
    ? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
    : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';

  // Use shared helper function for markdown detection and title extraction
  const { useMarkdown, title } = detectMarkdownAndExtractTitle(text, options, 'OpenClaw 提醒');

  log?.debug?.(
    `[DingTalk] Sending proactive message to ${isGroup ? 'group' : 'user'} ${resolvedTarget} with title "${title}"`
  );

  // Choose msgKey based on whether we're sending markdown or plain text
  // Note: DingTalk's proactive message API uses predefined message templates
  // sampleMarkdown supports markdown formatting, sampleText for plain text
  const msgKey = useMarkdown ? 'sampleMarkdown' : 'sampleText';
  const msgParam = useMarkdown ? JSON.stringify({ title, text }) : JSON.stringify({ content: text });

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
    method: 'POST',
    data: payload,
    headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
  });
  return result.data;
}

// Send proactive media message via DingTalk OpenAPI
async function sendProactiveMedia(
  config: DingTalkConfig,
  target: string,
  mediaPath: string,
  mediaType: 'image' | 'voice' | 'video' | 'file',
  options: SendMessageOptions & { accountId?: string } = {}
): Promise<{ ok: boolean; error?: string; data?: any; messageId?: string }> {
  const log = options.log || getLogger();

  try {
    // Upload media first to get media_id
    const mediaId = await uploadMedia(config, mediaPath, mediaType, log);
    if (!mediaId) {
      return { ok: false, error: 'Failed to upload media' };
    }

    const token = await getAccessToken(config, log);
    const { targetId, isExplicitUser } = stripTargetPrefix(target);
    const resolvedTarget = resolveOriginalPeerId(targetId);
    const isGroup = !isExplicitUser && resolvedTarget.startsWith('cid');

    const DINGTALK_API = 'https://api.dingtalk.com';
    const url = isGroup
      ? `${DINGTALK_API}/v1.0/robot/groupMessages/send`
      : `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;

    // Build payload based on media type
    // For personal messages (oToMessages), use native media message types
    // For group messages (groupMessages), use sampleImageMsg/sampleAudio/etc.
    let msgKey: string;
    let msgParam: string;

    if (mediaType === 'image') {
      msgKey = 'sampleImageMsg';
      msgParam = JSON.stringify({ photoURL: mediaId });
    } else if (mediaType === 'voice') {
      msgKey = 'sampleAudio';
      msgParam = JSON.stringify({ mediaId, duration: '0' });
    } else {
      // File-like media (including video)
      // Note: sampleVideo requires a cover image (picMediaId) which we don't have,
      // so we fall back to sampleFile for video to avoid .octet-stream issues.
      const filename = path.basename(mediaPath);
      const defaultExt = mediaType === 'video' ? 'mp4' : 'file';
      const ext = path.extname(mediaPath).slice(1) || defaultExt;
      msgKey = 'sampleFile';
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
      `[DingTalk] Sending proactive ${mediaType} message to ${isGroup ? 'group' : 'user'} ${resolvedTarget}`
    );

    const result = await axios({
      url,
      method: 'POST',
      data: payload,
      headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
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

// Download media file to agent workspace (sandbox-compatible)
// workspacePath: the agent's workspace directory (e.g., /home/node/.openclaw/workspace)
async function downloadMedia(
  config: DingTalkConfig,
  downloadCode: string,
  workspacePath: string,
  log?: Logger
): Promise<MediaFile | null> {
  const formatAxiosErrorData = (value: unknown): string | undefined => {
    if (value === null || value === undefined) return undefined;
    if (Buffer.isBuffer(value)) return `<buffer ${value.length} bytes>`;
    if (value instanceof ArrayBuffer) return `<arraybuffer ${value.byteLength} bytes>`;
    if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
    try {
      return JSON.stringify(maskSensitiveData(value));
    } catch {
      return String(value);
    }
  };

  if (!downloadCode) {
    log?.error?.('[DingTalk] downloadMedia requires downloadCode to be provided.');
    return null;
  }
  if (!config.robotCode) {
    if (log?.error) {
      log.error('[DingTalk] downloadMedia requires robotCode to be configured.');
    }
    return null;
  }
  try {
    const token = await getAccessToken(config, log);
    const response = await axios.post(
      'https://api.dingtalk.com/v1.0/robot/messageFiles/download',
      { downloadCode, robotCode: config.robotCode },
      { headers: { 'x-acs-dingtalk-access-token': token } }
    );
    const payload = response.data as Record<string, any>;
    const downloadUrl = payload?.downloadUrl ?? payload?.data?.downloadUrl;
    if (!downloadUrl) {
      const payloadDetail = formatAxiosErrorData(payload);
      log?.error?.(`[DingTalk] downloadMedia missing downloadUrl. payload=${payloadDetail ?? 'unknown'}`);
      return null;
    }
    const mediaResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    const contentType = mediaResponse.headers['content-type'] || 'application/octet-stream';
    const buffer = Buffer.from(mediaResponse.data as ArrayBuffer);

    // Save to agent workspace's media/inbound/ directory (sandbox-compatible)
    // This ensures the file is accessible within the sandbox
    const mediaDir = path.join(workspacePath, 'media', 'inbound');
    fs.mkdirSync(mediaDir, { recursive: true });

    const ext = contentType.split('/')[1]?.split(';')[0] || 'bin';
    const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const mediaPath = path.join(mediaDir, filename);

    fs.writeFileSync(mediaPath, buffer);
    log?.debug?.(`[DingTalk] Media saved to workspace: ${mediaPath}`);
    return { path: mediaPath, mimeType: contentType };
  } catch (err: any) {
    if (log?.error) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const statusText = err.response?.statusText;
        const dataDetail = formatAxiosErrorData(err.response?.data);
        const code = err.code ? ` code=${err.code}` : '';
        const statusLabel = status ? ` status=${status}${statusText ? ` ${statusText}` : ''}` : '';
        log.error(`[DingTalk] Failed to download media:${statusLabel}${code} message=${err.message}`);
        if (dataDetail) {
          log.error(`[DingTalk] downloadMedia response data: ${dataDetail}`);
        }
      } else {
        log.error('[DingTalk] Failed to download media:', err.message);
      }
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

  // Improved richText parsing: join all text/at components and extract first picture
  if (msgtype === 'richText') {
    const richTextParts = data.content?.richText || [];
    let text = '';
    let pictureDownloadCode: string | undefined;
    for (const part of richTextParts) {
      // Handle text content: include explicit text type or undefined type field (DingTalk may omit type)
      if (part.text && (part.type === 'text' || part.type === undefined)) text += part.text;
      if (part.type === 'at' && part.atName) text += `@${part.atName} `;
      // Extract first picture's downloadCode from richText
      if (part.type === 'picture' && part.downloadCode && !pictureDownloadCode) {
        pictureDownloadCode = part.downloadCode;
      }
    }
    return {
      text: text.trim() || (pictureDownloadCode ? '<media:image>' : '[富文本消息]'),
      mediaPath: pictureDownloadCode,
      mediaType: pictureDownloadCode ? 'image' : undefined,
      messageType: 'richText',
    };
  }

  if (msgtype === 'picture') {
    return { text: '<media:image>', mediaPath: data.content?.downloadCode, mediaType: 'image', messageType: 'picture' };
  }

  if (msgtype === 'audio') {
    return {
      text: data.content?.recognition || '<media:voice>',
      mediaPath: data.content?.downloadCode,
      mediaType: 'audio',
      messageType: 'audio',
    };
  }

  if (msgtype === 'video') {
    return { text: '<media:video>', mediaPath: data.content?.downloadCode, mediaType: 'video', messageType: 'video' };
  }

  if (msgtype === 'file') {
    return {
      text: `<media:file> (${data.content?.fileName || '文件'})`,
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
  const log = options.log || getLogger();

  // If mediaPath is provided, upload media and send as native media message
  if (options.mediaPath && options.mediaType) {
    const mediaId = await uploadMedia(config, options.mediaPath, options.mediaType, log);
    if (mediaId) {
      let body: any;

      // Construct message body based on media type
      if (options.mediaType === 'image') {
        body = { msgtype: 'image', image: { media_id: mediaId } };
      } else if (options.mediaType === 'voice') {
        body = { msgtype: 'voice', voice: { media_id: mediaId } };
      } else if (options.mediaType === 'video') {
        body = { msgtype: 'video', video: { media_id: mediaId } };
      } else if (options.mediaType === 'file') {
        body = { msgtype: 'file', file: { media_id: mediaId } };
      }

      if (body) {
        const result = await axios({
          url: sessionWebhook,
          method: 'POST',
          data: body,
          headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
        });
        return result.data;
      }
    } else {
      log?.warn?.('[DingTalk] Media upload failed, falling back to text description');
    }
  }

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

    if (!config.cardTemplateId) {
      throw new Error('DingTalk cardTemplateId is not configured.');
    }

    // Build the createAndDeliver request body
    const createAndDeliverBody = {
      cardTemplateId: config.cardTemplateId,
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
    key: card.config?.cardTemplateKey || 'content',
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
    // Handle 500 unknownError - likely cardTemplateKey mismatch with card template variables
    if (err.response?.status === 500 && err.response?.data?.code === 'unknownError') {
      const usedKey = streamBody.key;
      const cardTemplateId = card.config?.cardTemplateId || '(unknown)';
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
          `Verify that "cardTemplateKey" matches the content field variable name in your card template.`
      );

      card.state = AICardStatus.FAILED;
      card.lastUpdated = Date.now();

      if (card.config) {
        // Send notification directly to user via Markdown fallback
        // We don't pass accountId here to ensure it doesn't try to use AI Card recursion
        try {
          await sendMessage(card.config, card.conversationId, errorMsg, { log });
        } catch (sendErr: any) {
          log?.warn?.(`[DingTalk][AICard] Failed to send error notification to user: ${sendErr.message}`);
        }
      }

      throw err;
    }

    // Handle 401 errors specifically - try to refresh token once
    if (err.response?.status === 401 && card.config) {
      log?.warn?.('[DingTalk][AICard] Received 401 error, attempting token refresh and retry...');
      try {
        card.accessToken = await getAccessToken(card.config, log);
        // Retry the streaming request with refreshed token
        const retryResp = await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, streamBody, {
          headers: { 'x-acs-dingtalk-access-token': card.accessToken, 'Content-Type': 'application/json' },
        });
        log?.debug?.(`[DingTalk][AICard] Retry after token refresh succeeded: status=${retryResp.status}`);
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

  // Register original peer IDs to preserve case-sensitive conversationId (base64)
  if (groupId) registerPeerId(groupId);
  if (senderId) registerPeerId(senderId);

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

  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: 'dingtalk',
    accountId,
    peer: { kind: isDirect ? 'dm' : 'group', id: isDirect ? senderId : groupId },
  });

  const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });
  const workspacePath = resolveAgentWorkspaceDir(cfg, route.agentId);

  // Download media to agent workspace (must be after route is resolved for correct workspace)
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (content.mediaPath && dingtalkConfig.robotCode) {
    const media = await downloadMedia(dingtalkConfig, content.mediaPath, workspacePath, log);
    if (media) {
      mediaPath = media.path;
      mediaType = media.mimeType;
    }
  }
  const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = rt.channel.session.readSessionUpdatedAt({ storePath, sessionKey: route.sessionKey });

  // Group-specific: resolve config, track members, format member list
  const groupConfig = !isDirect ? resolveGroupConfig(dingtalkConfig, groupId) : undefined;
  // GroupSystemPrompt is injected into the system prompt on every turn (unlike
  // group intro which only fires on the first turn). Embed DingTalk IDs here so
  // the AI always has access to conversationId.
  const groupSystemPrompt = !isDirect
    ? [`DingTalk group context: conversationId=${groupId}`, groupConfig?.systemPrompt?.trim()]
        .filter(Boolean)
        .join('\n')
    : undefined;

  if (!isDirect) {
    noteGroupMember(storePath, groupId, senderId, senderName);
  }
  const groupMembers = !isDirect ? formatGroupMembers(storePath, groupId) : undefined;

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
    GroupMembers: groupMembers,
    GroupSystemPrompt: groupSystemPrompt,
    GroupChannel: isDirect ? undefined : route.sessionKey,
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
      try {
        const aiCard = await createAICard(dingtalkConfig, to, data, accountId, log);
        if (aiCard) {
          currentAICard = aiCard;
        } else {
          log?.warn?.('[DingTalk] Failed to create AI card (returned null), fallback to text/markdown.');
        }
      } catch (err: any) {
        log?.warn?.(`[DingTalk] Failed to create AI card: ${err.message}, fallback to text/markdown.`);
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

  // Finalize AI card
  if (useCardMode && currentAICard) {
    try {
      // Helper function to check if a value is a non-empty string
      const isNonEmptyString = (value: any): boolean => typeof value === 'string' && value.trim().length > 0;

      // Validate that we have actual content before finalization
      const hasLastCardContent = isNonEmptyString(lastCardContent);
      const hasQueuedFinalString = isNonEmptyString(queuedFinal);

      if (hasLastCardContent || hasQueuedFinalString) {
        const finalContent = hasLastCardContent ? lastCardContent : (queuedFinal as string);
        await finishAICard(currentAICard, finalContent, log);
      } else {
        // No textual content was produced; skip finalization with empty content
        log?.debug?.('[DingTalk] Skipping AI Card finalization because no textual content was produced.');
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
  // Note: Media cleanup is handled by openclaw's media storage mechanism
  // Files saved via rt.channel.media.saveMediaBuffer are managed automatically
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
      return config.accounts && Object.keys(config.accounts).length > 0
        ? Object.keys(config.accounts)
        : isConfigured(cfg)
          ? ['default']
          : [];
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
    resolveGroupIntroHint: ({ groupId, groupChannel }: any): string | undefined => {
      const parts = [`conversationId=${groupId}`];
      if (groupChannel) parts.push(`sessionKey=${groupChannel}`);
      return `DingTalk IDs: ${parts.join(', ')}.`;
    },
  },
  messaging: {
    normalizeTarget: ({ target }: any) => (target ? { targetId: target.replace(/^(dingtalk|dd|ding):/i, '') } : null),
    targetResolver: { looksLikeId: (id: string): boolean => /^[\w-/=]+$/.test(id), hint: '<conversationId>' },
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
      // Strip group: or user: prefix and resolve original case-sensitive conversationId
      const { targetId } = stripTargetPrefix(trimmed);
      const resolved = resolveOriginalPeerId(targetId);
      return { ok: true, to: resolved };
    },
    sendText: async ({ cfg, to, text, accountId, log }: any) => {
      const config = getConfig(cfg, accountId);
      try {
        const result = await sendMessage(config, to, text, { log, accountId });
        getLogger()?.debug?.(`[DingTalk] sendText: "${text}" result: ${JSON.stringify(result)}`);
        if (result.ok) {
          const data = result.data as any;
          const messageId = data?.processQueryKey || data?.messageId;
          return { ok: true, via: 'dingtalk', messageId, data: result.data };
        }
        return { ok: false, error: result.error };
      } catch (err: any) {
        return { ok: false, error: err.response?.data || err.message };
      }
    },
    sendMedia: async ({
      cfg,
      to,
      mediaPath,
      filePath,
      mediaUrl,
      mediaType: providedMediaType,
      accountId,
      log,
    }: any) => {
      const config = getConfig(cfg, accountId);
      if (!config.clientId) {
        return { ok: false, error: 'DingTalk not configured' };
      }

      // Support mediaPath, filePath, and mediaUrl parameter names
      const actualMediaPath = mediaPath || filePath || mediaUrl;

      getLogger()?.debug?.(
        `[DingTalk] sendMedia called: to=${to}, mediaPath=${mediaPath}, filePath=${filePath}, mediaUrl=${mediaUrl}, actualMediaPath=${actualMediaPath}`
      );

      if (!actualMediaPath) {
        return {
          ok: false,
          error: `mediaPath, filePath, or mediaUrl is required. Received: ${JSON.stringify({
            to,
            mediaPath,
            filePath,
            mediaUrl,
          })}`,
        };
      }

      try {
        // Detect media type from file extension if not provided
        const mediaType = providedMediaType || detectMediaTypeFromExtension(actualMediaPath);

        // Send as native media via proactive API
        const result = await sendProactiveMedia(config, to, actualMediaPath, mediaType, { log, accountId });
        getLogger()?.debug?.(
          `[DingTalk] sendMedia: ${mediaType} file=${actualMediaPath} result: ${JSON.stringify(result)}`
        );

        if (result.ok) {
          // Extract messageId from DingTalk response for CLI display
          const data = result.data;
          const messageId = result.messageId || data?.processQueryKey || data?.messageId;
          return { ok: true, via: 'dingtalk', messageId, data: result.data };
        }
        return { ok: false, error: result.error };
      } catch (err: any) {
        return { ok: false, error: err.response?.data || err.message };
      }
    },
  },
  gateway: {
    startAccount: async (ctx: GatewayStartContext): Promise<GatewayStopResult> => {
      const { account, cfg, abortSignal } = ctx;
      const config = account.config;
      if (!config.clientId || !config.clientSecret) {
        throw new Error('DingTalk clientId and clientSecret are required');
      }

      ctx.log?.info?.(`[${account.accountId}] Initializing DingTalk Stream client...`);

      // Cleanup orphaned temp files from previous sessions
      cleanupOrphanedTempFiles(ctx.log);

      // Create DWClient with autoReconnect disabled (we'll manage reconnection ourselves)
      const client = new DWClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        debug: config.debug || false,
        keepAlive: true,
      });

      // Disable DWClient's built-in autoReconnect to use our robust ConnectionManager
      // Access private config to override autoReconnect
      (client as any).config.autoReconnect = false;

      // Register message callback listener
      client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
        const messageId = res.headers?.messageId;
        try {
          if (messageId) {
            client.socketCallBackResponse(messageId, { success: true });
          }
          const data = JSON.parse(res.data) as DingTalkInboundMessage;

          // Message deduplication: use bot-scoped key (robotKey:msgId) to prevent cross-bot conflicts
          // robotKey priority: robotCode (DingTalk's bot identifier) > clientId (app key) > accountId (local ID)
          // This ensures consistent keys per bot instance (config values remain stable during runtime)
          const robotKey = config.robotCode || config.clientId || account.accountId;
          const msgId = data.msgId || messageId;
          
          // Skip dedup if we don't have a message ID (extremely rare edge case)
          if (!msgId) {
            ctx.log?.warn?.(`[${account.accountId}] No message ID available for deduplication`);
          } else {
            const dedupKey = `${robotKey}:${msgId}`;
            if (isMessageProcessed(dedupKey)) {
              ctx.log?.debug?.(`[${account.accountId}] Skipping duplicate message: ${dedupKey}`);
              return;
            }
            markMessageProcessed(dedupKey);
          }

          await handleDingTalkMessage({
            cfg,
            accountId: account.accountId,
            data,
            sessionWebhook: data.sessionWebhook,
            log: ctx.log,
            dingtalkConfig: config,
          });
        } catch (error: any) {
          ctx.log?.error?.(`[${account.accountId}] Error processing message: ${error.message}`);
        }
      });

      // Create connection manager configuration
      const connectionConfig: ConnectionManagerConfig = {
        maxAttempts: config.maxConnectionAttempts ?? 10,
        initialDelay: config.initialReconnectDelay ?? 1000,
        maxDelay: config.maxReconnectDelay ?? 60000,
        jitter: config.reconnectJitter ?? 0.3,
      };

      ctx.log?.debug?.(
        `[${account.accountId}] Connection config: maxAttempts=${connectionConfig.maxAttempts}, ` +
          `initialDelay=${connectionConfig.initialDelay}ms, maxDelay=${connectionConfig.maxDelay}ms, ` +
          `jitter=${connectionConfig.jitter}`
      );

      // Create connection manager
      const connectionManager = new ConnectionManager(client, account.accountId, connectionConfig, ctx.log);

      // Track stopped state to prevent duplicate stop operations
      // The 'stopped' flag guards against multiple termination paths (abort signal, explicit stop)
      // from executing concurrently and ensures each lifecycle transition updates snapshot only once
      let stopped = false;

      // Setup abort signal handler BEFORE connecting
      // This allows the abort signal to cancel in-flight connection attempts
      if (abortSignal) {
        // Check if already aborted before we even start
        if (abortSignal.aborted) {
          ctx.log?.warn?.(`[${account.accountId}] Abort signal already active, skipping connection`);
          
          // Update snapshot: channel aborted before start
          ctx.updateSnapshot?.({
            running: false,
            lastStopAt: getCurrentTimestamp(),
            lastError: 'Connection aborted before start',
          });
          
          throw new Error('Connection aborted before start');
        }

        abortSignal.addEventListener('abort', () => {
          if (stopped) return;
          stopped = true;
          ctx.log?.info?.(`[${account.accountId}] Abort signal received, stopping DingTalk Stream client...`);
          connectionManager.stop();
          
          // Update snapshot: channel stopped by abort signal
          ctx.updateSnapshot?.({
            running: false,
            lastStopAt: getCurrentTimestamp(),
          });
        });
      }

      // Connect with robust retry logic
      try {
        await connectionManager.connect();
        
        // Only mark as running if we weren't stopped and the connection is actually established
        if (!stopped && connectionManager.isConnected()) {
          // Update snapshot: connection successful, channel is now running
          ctx.updateSnapshot?.({
            running: true,
            lastStartAt: getCurrentTimestamp(),
            lastError: null,
          });
          ctx.log?.info?.(
            `[${account.accountId}] DingTalk Stream client connected successfully`
          );
        } else {
          // Startup was cancelled or connection is not established; do not overwrite stopped snapshot.
          ctx.log?.info?.(
            `[${account.accountId}] DingTalk Stream client connect() completed but channel is ` +
            `not running (stopped=${stopped}, connected=${connectionManager.isConnected()})`
          );
        }
      } catch (err: any) {
        ctx.log?.error?.(
          `[${account.accountId}] Failed to establish connection: ${err.message}`
        );

        // Update snapshot: connection failed
        ctx.updateSnapshot?.({
          running: false,
          lastError: err.message || 'Connection failed',
        });
        throw err;
      }

      // Return stop handler
      return {
        stop: () => {
          if (stopped) return;
          stopped = true;
          ctx.log?.info?.(`[${account.accountId}] Stopping DingTalk Stream client...`);
          connectionManager.stop();
          
          // Update snapshot: channel stopped
          ctx.updateSnapshot?.({
            running: false,
            lastStopAt: getCurrentTimestamp(),
          });
          
          ctx.log?.info?.(`[${account.accountId}] DingTalk Stream client stopped`);
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
 * - {@link uploadMedia} uploads a local media file to DingTalk media server
 *   and returns the media_id for use in messages.
 * - {@link getAccessToken} retrieves (and caches) the DingTalk access token
 *   for the configured application/runtime.
 * - {@link getLogger} retrieves the current global logger instance
 *   (set by handleDingTalkMessage during inbound message processing).
 *
 * These exports are intended to be used by external integrations that need
 * direct programmatic access to DingTalk messaging and authentication.
 */
export {
  sendBySession,
  createAICard,
  streamAICard,
  finishAICard,
  sendMessage,
  uploadMedia,
  sendProactiveMedia,
  getAccessToken,
  getLogger,
};
export { detectMediaTypeFromExtension } from './media-utils';
