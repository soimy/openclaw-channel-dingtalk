/**
 * Type definitions for DingTalk Channel Plugin
 *
 * Provides comprehensive type safety for:
 * - Configuration objects
 * - DingTalk API request/response models
 * - Message content and formats
 * - Media files and streams
 * - Session and token management
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk';

/**
 * DingTalk channel configuration (extends base OpenClaw config)
 */
export interface DingTalkConfig extends OpenClawConfig {
  clientId: string;
  clientSecret: string;
  robotCode?: string;
  corpId?: string;
  agentId?: string;
  name?: string;
  enabled?: boolean;
  dmPolicy?: 'open' | 'pairing' | 'allowlist';
  groupPolicy?: 'open' | 'allowlist';
  allowFrom?: string[];
  showThinking?: boolean;
  debug?: boolean;
  messageType?: 'markdown' | 'card';
  cardTemplateId?: string;
  cardTemplateKey?: string;
  groups?: Record<string, { systemPrompt?: string }>;
  accounts?: Record<string, DingTalkConfig>;
  // Connection robustness configuration
  maxConnectionAttempts?: number;
  initialReconnectDelay?: number;
  maxReconnectDelay?: number;
  reconnectJitter?: number;
}

/**
 * Multi-account DingTalk configuration wrapper
 */
export interface DingTalkChannelConfig {
  enabled?: boolean;
  clientId: string;
  clientSecret: string;
  robotCode?: string;
  corpId?: string;
  agentId?: string;
  dmPolicy?: 'open' | 'pairing' | 'allowlist';
  groupPolicy?: 'open' | 'allowlist';
  allowFrom?: string[];
  showThinking?: boolean;
  debug?: boolean;
  messageType?: 'markdown' | 'card';
  cardTemplateId?: string;
  cardTemplateKey?: string;
  groups?: Record<string, { systemPrompt?: string }>;
  accounts?: Record<string, DingTalkConfig>;
  // Connection robustness configuration
  maxConnectionAttempts?: number;
  initialReconnectDelay?: number;
  maxReconnectDelay?: number;
  reconnectJitter?: number;
}

/**
 * DingTalk token info for caching
 */
export interface TokenInfo {
  accessToken: string;
  expireIn: number;
}

/**
 * DingTalk API token response
 */
export interface TokenResponse {
  accessToken: string;
  expireIn: number;
}

/**
 * DingTalk API generic response wrapper
 */
export interface DingTalkApiResponse<T = unknown> {
  data?: T;
  code?: string;
  message?: string;
  success?: boolean;
}

/**
 * Media download response from DingTalk API
 */
export interface MediaDownloadResponse {
  downloadUrl?: string;
  downloadCode?: string;
}

/**
 * Media file metadata
 */
export interface MediaFile {
  path: string;
  mimeType: string;
}

/**
 * DingTalk incoming message (Stream mode)
 */
export interface DingTalkInboundMessage {
  msgId: string;
  msgtype: string;
  createAt: number;
  text?: {
    content: string;
  };
  content?: {
    downloadCode?: string;
    fileName?: string;
    recognition?: string;
    richText?: Array<{
      type: string;
      text?: string;
      atName?: string;
      downloadCode?: string; // For picture type in richText
    }>;
  };
  conversationType: string;
  conversationId: string;
  conversationTitle?: string;
  senderId: string;
  senderStaffId?: string;
  senderNick?: string;
  chatbotUserId: string;
  sessionWebhook: string;
}

/**
 * Extracted message content for unified processing
 */
export interface MessageContent {
  text: string;
  mediaPath?: string;
  mediaType?: string;
  messageType: string;
}

/**
 * Send message options
 */
export interface SendMessageOptions {
  title?: string;
  useMarkdown?: boolean;
  atUserId?: string | null;
  log?: any;
  mediaPath?: string;
  filePath?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'voice' | 'video' | 'file';
}

/**
 * Session webhook response
 */
export interface SessionWebhookResponse {
  msgtype: string;
  markdown?: {
    title: string;
    text: string;
  };
  text?: {
    content: string;
  };
  at?: {
    atUserIds: string[];
    isAtAll: boolean;
  };
}

/**
 * Message handler parameters
 */
export interface HandleDingTalkMessageParams {
  cfg: OpenClawConfig;
  accountId: string;
  data: DingTalkInboundMessage;
  sessionWebhook: string;
  log?: any;
  dingtalkConfig: DingTalkConfig;
}

/**
 * Proactive message payload
 */
export interface ProactiveMessagePayload {
  robotCode: string;
  msgKey: string;
  msgParam: string;
  openConversationId?: string;
  userIds?: string[];
}

/**
 * Account descriptor
 */
export interface AccountDescriptor {
  accountId: string;
  config?: DingTalkConfig;
  enabled?: boolean;
  name?: string;
  configured?: boolean;
}

/**
 * Account resolver result
 */
export interface ResolvedAccount {
  accountId: string;
  config: DingTalkConfig;
  enabled: boolean;
}

/**
 * HTTP request config for axios
 */
export interface AxiosRequestConfig {
  url?: string;
  method?: string;
  data?: any;
  headers?: Record<string, string>;
  responseType?: 'arraybuffer' | 'json' | 'text';
}

/**
 * HTTP response from axios
 */
export interface AxiosResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

/**
 * DingTalk Stream callback listener types
 */
export interface StreamCallbackResponse {
  headers?: {
    messageId?: string;
  };
  data: string;
}

/**
 * Reply dispatcher context
 */
export interface ReplyDispatchContext {
  responsePrefix?: string;
  deliver: (payload: any) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Reply dispatcher result
 */
export interface ReplyDispatcherResult {
  dispatcher: any;
  replyOptions: any;
  markDispatchIdle: () => void;
}

/**
 * Retry options
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  log?: any;
}

/**
 * Logger interface
 */
export interface Logger {
  debug?: (message: string, ...args: any[]) => void;
  info?: (message: string, ...args: any[]) => void;
  warn?: (message: string, ...args: any[]) => void;
  error?: (message: string, ...args: any[]) => void;
}

/**
 * Channel runtime snapshot
 */
export interface ChannelSnapshot {
  running: boolean;
  lastStartAt: string | null;
  lastStopAt: string | null;
  lastError: string | null;
}

/**
 * Plugin gateway start context
 */
export interface GatewayStartContext {
  account: ResolvedAccount;
  cfg: OpenClawConfig;
  abortSignal?: AbortSignal;
  log?: Logger;
  updateSnapshot?: (snapshot: Partial<ChannelSnapshot>) => void;
}

/**
 * Plugin gateway account stop result
 */
export interface GatewayStopResult {
  stop: () => void;
}

/**
 * DingTalk channel plugin definition
 */
export interface DingTalkChannelPlugin {
  id: string;
  meta: {
    id: string;
    label: string;
    selectionLabel: string;
    docsPath: string;
    blurb: string;
    aliases: string[];
  };
  capabilities: {
    chatTypes: string[];
    reactions: boolean;
    threads: boolean;
    media: boolean;
    nativeCommands: boolean;
    blockStreaming: boolean;
  };
  reload: {
    configPrefixes: string[];
  };
  config: {
    listAccountIds: (cfg: OpenClawConfig) => string[];
    resolveAccount: (cfg: OpenClawConfig, accountId?: string) => ResolvedAccount;
    defaultAccountId: () => string;
    isConfigured: (account: any) => boolean;
    describeAccount: (account: any) => AccountDescriptor;
  };
  security: {
    resolveDmPolicy: (params: any) => any;
  };
  groups: {
    resolveRequireMention: (params: any) => boolean;
  };
  messaging: {
    normalizeTarget: (params: any) => any;
    targetResolver: {
      looksLikeId: (id: string) => boolean;
      hint: string;
    };
  };
  outbound: {
    deliveryMode: string;
    sendText: (params: any) => Promise<{ ok: boolean; data?: any; error?: any }>;
  };
  gateway: {
    startAccount: (ctx: GatewayStartContext) => Promise<GatewayStopResult>;
  };
  status: {
    defaultRuntime: {
      accountId: string;
      running: boolean;
      lastStartAt: null;
      lastStopAt: null;
      lastError: null;
    };
    probe: (params: any) => Promise<{ ok: boolean; error?: string; details?: any }>;
    buildChannelSummary: (params: any) => any;
  };
}

/**
 * Result of target resolution validation
 */
export interface TargetResolutionResult {
  ok: boolean;
  to?: string;
  error?: Error;
}

/**
 * Parameters for resolveTarget validation
 */
export interface ResolveTargetParams {
  to?: string | null;
  [key: string]: any;
}

/**
 * Parameters for sendText delivery
 */
export interface SendTextParams {
  cfg: DingTalkConfig;
  to: string;
  text: string;
  accountId?: string;
  [key: string]: any;
}

/**
 * Parameters for sendMedia delivery
 */
export interface SendMediaParams {
  cfg: DingTalkConfig;
  to: string;
  mediaPath: string;
  accountId?: string;
  [key: string]: any;
}

/**
 * DingTalk outbound handler configuration
 */
export interface DingTalkOutboundHandler {
  deliveryMode: 'direct' | 'queued' | 'batch';
  resolveTarget: (params: ResolveTargetParams) => TargetResolutionResult;
  sendText: (params: SendTextParams) => Promise<{ ok: boolean; data?: any; error?: any }>;
  sendMedia?: (params: SendMediaParams) => Promise<{ ok: boolean; data?: any; error?: any }>;
}

/**
 * AI Card status constants
 */
export const AICardStatus = {
  PROCESSING: '1',
  INPUTING: '2',
  FINISHED: '3',
  FAILED: '5',
} as const;

/**
 * AI Card state type
 */
export type AICardState = (typeof AICardStatus)[keyof typeof AICardStatus];

/**
 * AI Card instance
 */
export interface AICardInstance {
  cardInstanceId: string;
  accessToken: string;
  conversationId: string;
  createdAt: number;
  lastUpdated: number;
  state: AICardState; // Current card state: PROCESSING, INPUTING, FINISHED, FAILED
  config?: DingTalkConfig; // Store config reference for token refresh
}

/**
 * AI Card streaming update request (new API)
 */
export interface AICardStreamingRequest {
  outTrackId: string;
  guid: string;
  key: string;
  content: string;
  isFull: boolean;
  isFinalize: boolean;
  isError: boolean;
}

/**
 * Connection state enum for lifecycle management
 */
export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DISCONNECTING = 'DISCONNECTING',
  FAILED = 'FAILED',
}

/**
 * Connection manager configuration
 */
export interface ConnectionManagerConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  jitter: number;
}

/**
 * Connection attempt result
 */
export interface ConnectionAttemptResult {
  success: boolean;
  attempt: number;
  error?: Error;
  nextDelay?: number;
}
