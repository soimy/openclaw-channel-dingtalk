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

  /** Multi-account configuration */
  accounts: z.record(z.string(), z.unknown()).optional(),
});

export type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>;
