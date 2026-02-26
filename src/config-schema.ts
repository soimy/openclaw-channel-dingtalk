import { z } from "zod";

const DingTalkAccountConfigSchema = z.object({
  /** Account name (optional display name) */
  name: z.string().optional(),

  /** Whether this channel is enabled */
  enabled: z.boolean().optional().default(true),

  /** DingTalk App Key (Client ID) - required for authentication */
  clientId: z.string().optional(),

  /** DingTalk App Secret (Client Secret) - required for authentication */
  clientSecret: z.string().optional(),

  /** DingTalk Robot Code for media download */
  robotCode: z.string().optional(),

  /** DingTalk Corporation ID */
  corpId: z.string().optional(),

  /** DingTalk Application ID (Agent ID) */
  agentId: z.union([z.string(), z.number()]).optional(),

  /** Direct message policy: open, pairing, or allowlist */
  dmPolicy: z.enum(["open", "pairing", "allowlist"]).optional().default("open"),

  /** Group message policy: open or allowlist */
  groupPolicy: z.enum(["open", "allowlist"]).optional().default("open"),

  /** List of allowed user IDs for allowlist policy */
  allowFrom: z.array(z.string()).optional(),

  /** Show thinking indicator while processing */
  showThinking: z.boolean().optional().default(true),

  /** Enable debug logging */
  debug: z.boolean().optional().default(false),

  /** Message type for replies: markdown or card */
  messageType: z.enum(["markdown", "card"]).optional().default("markdown"),

  /** Card template ID for AI interactive cards
   * obtain the template ID from DingTalk Developer Console.
   * ref: https://github.com/soimy/openclaw-channel-dingtalk/blob/main/README.md#3-%E5%BB%BA%E7%AB%8B%E5%8D%A1%E7%89%87%E6%A8%A1%E6%9D%BF%E5%8F%AF%E9%80%89
   */
  cardTemplateId: z.string().optional(),

  /** Card template key for streaming updates
   * Default: 'msgContent' - maps to the content field in the card template
   * This key is used in the streaming API to update specific fields in the card.
   */
  cardTemplateKey: z.string().optional().default("content"),

  /** Per-group configuration, keyed by conversationId (supports "*" wildcard) */
  groups: z
    .record(
      z.string(),
      z.object({
        systemPrompt: z.string().optional(),
      }),
    )
    .optional(),

  /** Connection robustness configuration */

  /** Maximum number of connection attempts before giving up (default: 10) */
  maxConnectionAttempts: z.number().int().min(1).optional().default(10),

  /** Initial reconnection delay in milliseconds (default: 1000ms) */
  initialReconnectDelay: z.number().int().min(100).optional().default(1000),

  /** Maximum reconnection delay in milliseconds for exponential backoff (default: 60000ms = 1 minute) */
  maxReconnectDelay: z.number().int().min(1000).optional().default(60000),

  /** Jitter factor for reconnection delay randomization (0-1, default: 0.3) */
  reconnectJitter: z.number().min(0).max(1).optional().default(0.3),

  /** Maximum number of runtime reconnect cycles before giving up (default: 10) */
  maxReconnectCycles: z.number().int().min(1).optional().default(10),

  proactivePermissionHint: z
    .object({
      enabled: z.boolean().optional().default(true),
      cooldownHours: z.number().int().min(1).max(24 * 30).optional().default(24),
    })
    .optional()
    .default({ enabled: true, cooldownHours: 24 }),
});

/**
 * DingTalk configuration schema using Zod
 * Mirrors the structure needed for proper control-ui rendering
 */
export const DingTalkConfigSchema: z.ZodTypeAny = DingTalkAccountConfigSchema.extend({
  /** Multi-account configuration */
  accounts: z.record(z.string(), DingTalkAccountConfigSchema.optional()).optional(),
});

export type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>;
