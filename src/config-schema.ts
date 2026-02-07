import { z } from 'zod';

/**
 * DingTalk configuration schema using Zod
 * Mirrors the structure needed for proper control-ui rendering
 */
export const DingTalkConfigSchema = z.object({
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
  dmPolicy: z.enum(['open', 'pairing', 'allowlist']).optional().default('open'),

  /** Group message policy: open or allowlist */
  groupPolicy: z.enum(['open', 'allowlist']).optional().default('open'),

  /** List of allowed user IDs for allowlist policy */
  allowFrom: z.array(z.string()).optional(),

  /** Show thinking indicator while processing */
  showThinking: z.boolean().optional().default(true),

  /** Enable debug logging */
  debug: z.boolean().optional().default(false),

  /** Message type for replies: markdown or card */
  messageType: z.enum(['markdown', 'card']).optional().default('markdown'),

  /** Card template ID for AI interactive cards
   * Default: '382e4302-551d-4880-bf29-a30acfab2e71.schema' (DingTalk official AI Card template)
   * Note: This is the official AI Card template ID provided by DingTalk for AI streaming cards.
   * If using custom templates, obtain the template ID from DingTalk Developer Console.
   */
  cardTemplateId: z.string().optional().default('382e4302-551d-4880-bf29-a30acfab2e71.schema'),

  /** Per-group configuration, keyed by conversationId (supports "*" wildcard) */
  groups: z.record(z.string(), z.object({
    systemPrompt: z.string().optional(),
  })).optional(),

  /** Multi-account configuration */
  accounts: z.record(z.string(), z.unknown()).optional(),

  /** Connection robustness configuration */
  
  /** Maximum number of connection attempts before giving up (default: 10) */
  maxConnectionAttempts: z.number().int().min(1).optional().default(10),

  /** Initial reconnection delay in milliseconds (default: 1000ms) */
  initialReconnectDelay: z.number().int().min(100).optional().default(1000),

  /** Maximum reconnection delay in milliseconds for exponential backoff (default: 60000ms = 1 minute) */
  maxReconnectDelay: z.number().int().min(1000).optional().default(60000),

  /** Jitter factor for reconnection delay randomization (0-1, default: 0.3) */
  reconnectJitter: z.number().min(0).max(1).optional().default(0.3),
});

export type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>;
