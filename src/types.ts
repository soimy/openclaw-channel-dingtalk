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

import type {
  OpenClawConfig,
  ChannelLogSink as SDKChannelLogSink,
  ChannelAccountSnapshot as SDKChannelAccountSnapshot,
  ChannelGatewayContext as SDKChannelGatewayContext,
  ChannelPlugin as SDKChannelPlugin,
} from "openclaw/plugin-sdk";

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
  dmPolicy?: "open" | "pairing" | "allowlist";
  groupPolicy?: "open" | "allowlist";
  allowFrom?: string[];
  showThinking?: boolean;
  debug?: boolean;
  messageType?: "markdown" | "card";
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
  name?: string;
  dmPolicy?: "open" | "pairing" | "allowlist";
  groupPolicy?: "open" | "allowlist";
  allowFrom?: string[];
  showThinking?: boolean;
  debug?: boolean;
  messageType?: "markdown" | "card";
  cardTemplateId?: string;
  cardTemplateKey?: string;
  groups?: Record<string, { systemPrompt?: string }>;
  accounts?: Record<string, DingTalkConfig>;
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
    isReplyMsg?: boolean;        // 是否是回复消息
    repliedMsg?: {               // 被回复的消息
      content?: {
        text?: string;
        richText?: Array<{
          msgType?: string;
          type?: string;
          content?: string;
          code?: string;
          atName?: string;
        }>;
      };
    };
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
    quoteContent?: string;       // 替代引用格式
  };
  // Legacy 引用格式
  quoteMessage?: {
    msgId?: string;
    msgtype?: string;
    text?: { content: string; };
    senderNick?: string;
    senderId?: string;
  };
  // 富媒体引用，仅有消息ID的情况（包括手机端和PC端）
  originalMsgId?: string;
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
  mediaType?: "image" | "voice" | "video" | "file";
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
  responseType?: "arraybuffer" | "json" | "text";
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
 * Channel log sink
 */
export type ChannelLogSink = SDKChannelLogSink;

/**
 * @deprecated Use ChannelLogSink instead
 */
export type Logger = ChannelLogSink;

/**
 * Channel account snapshot
 */
export type ChannelAccountSnapshot = SDKChannelAccountSnapshot;

/**
 * @deprecated Use ChannelAccountSnapshot instead
 */
export type ChannelSnapshot = ChannelAccountSnapshot;

/**
 * Plugin gateway start context
 */
export type GatewayStartContext = SDKChannelGatewayContext<ResolvedAccount>;

/**
 * Plugin gateway account stop result
 */
export interface GatewayStopResult {
  stop: () => void;
}

/**
 * DingTalk channel plugin definition
 */
export type DingTalkChannelPlugin = SDKChannelPlugin<ResolvedAccount & { configured: boolean }>;

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
  deliveryMode: "direct" | "queued" | "batch";
  resolveTarget: (params: ResolveTargetParams) => TargetResolutionResult;
  sendText: (params: SendTextParams) => Promise<{ ok: boolean; data?: any; error?: any }>;
  sendMedia?: (params: SendMediaParams) => Promise<{ ok: boolean; data?: any; error?: any }>;
}

/**
 * AI Card status constants
 */
export const AICardStatus = {
  PROCESSING: "1",
  INPUTING: "2",
  FINISHED: "3",
  FAILED: "5",
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
  DISCONNECTED = "DISCONNECTED",
  CONNECTING = "CONNECTING",
  CONNECTED = "CONNECTED",
  DISCONNECTING = "DISCONNECTING",
  FAILED = "FAILED",
}

/**
 * Connection manager configuration
 */
export interface ConnectionManagerConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  jitter: number;
  /** Callback invoked when connection state changes */
  onStateChange?: (state: ConnectionState, error?: string) => void;
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

// ============ Onboarding Helper Functions ============

const DEFAULT_ACCOUNT_ID = "default";

/**
 * List all DingTalk account IDs from config
 */
export function listDingTalkAccountIds(cfg: OpenClawConfig): string[] {
  const dingtalk = cfg.channels?.dingtalk as DingTalkChannelConfig | undefined;
  if (!dingtalk) return [];

  const accountIds: string[] = [];

  // Check for direct configuration (default account)
  if (dingtalk.clientId || dingtalk.clientSecret) {
    accountIds.push(DEFAULT_ACCOUNT_ID);
  }

  // Check accounts object
  if (dingtalk.accounts) {
    accountIds.push(...Object.keys(dingtalk.accounts));
  }

  return accountIds;
}

/**
 * Resolved DingTalk account with configuration status
 */
export interface ResolvedDingTalkAccount extends DingTalkConfig {
  accountId: string;
  configured: boolean;
}

/**
 * Resolve a specific DingTalk account configuration
 */
export function resolveDingTalkAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedDingTalkAccount {
  const id = accountId || DEFAULT_ACCOUNT_ID;
  const dingtalk = cfg.channels?.dingtalk as DingTalkChannelConfig | undefined;

  // If default account, return top-level config
  if (id === DEFAULT_ACCOUNT_ID) {
    const config: DingTalkConfig = {
      clientId: dingtalk?.clientId ?? "",
      clientSecret: dingtalk?.clientSecret ?? "",
      robotCode: dingtalk?.robotCode,
      corpId: dingtalk?.corpId,
      agentId: dingtalk?.agentId,
      name: dingtalk?.name,
      enabled: dingtalk?.enabled,
      dmPolicy: dingtalk?.dmPolicy,
      groupPolicy: dingtalk?.groupPolicy,
      allowFrom: dingtalk?.allowFrom,
      showThinking: dingtalk?.showThinking,
      debug: dingtalk?.debug,
      messageType: dingtalk?.messageType,
      cardTemplateId: dingtalk?.cardTemplateId,
      cardTemplateKey: dingtalk?.cardTemplateKey,
      groups: dingtalk?.groups,
      accounts: dingtalk?.accounts,
      maxConnectionAttempts: dingtalk?.maxConnectionAttempts,
      initialReconnectDelay: dingtalk?.initialReconnectDelay,
      maxReconnectDelay: dingtalk?.maxReconnectDelay,
      reconnectJitter: dingtalk?.reconnectJitter,
    };
    return {
      ...config,
      accountId: id,
      configured: Boolean(config.clientId && config.clientSecret),
    };
  }

  // If named account, get from accounts object
  const accountConfig = dingtalk?.accounts?.[id];
  if (accountConfig) {
    return {
      ...accountConfig,
      accountId: id,
      configured: Boolean(accountConfig.clientId && accountConfig.clientSecret),
    };
  }

  // Account doesn't exist, return empty config
  return {
    clientId: "",
    clientSecret: "",
    accountId: id,
    configured: false,
  };
}
