import { z } from "zod";
import { DEFAULT_MESSAGE_CONTEXT_TTL_DAYS } from "./message-context-store";

const AckReactionSchema = z.union([
  z.literal(""),
  z.enum(["off", "emoji", "kaomoji"]),
  z.string().min(1),
]);

const CardStreamingModeSchema = z.enum(["off", "answer", "all"]);
const ContextVisibilitySchema = z.enum(["all", "allowlist", "allowlist_quote"]);

/**
 * Runtime-parsed DingTalk account config.
 *
 * Compatibility note:
 * - `agentId`, `corpId`, `showThinkingStream`, and `asyncMode` are intentionally
 *   not parsed here. They remain only in manifest metadata for legacy host/UI
 *   compatibility and are ignored by the current runtime.
 */
const DingTalkAccountConfigShape = {
  /** Account name (optional display name) */
  name: z.string().optional(),

  /** Enable or disable this DingTalk channel/account without deleting saved credentials. */
  enabled: z.boolean().optional().default(true),

  /** DingTalk App Key (Client ID) used to authenticate API and Stream connections. */
  clientId: z.string().optional(),

  /** DingTalk App Secret (Client Secret) used to obtain DingTalk access tokens. */
  clientSecret: z.string().optional(),

  /** Direct-message access policy: open, pairing, or allowlist. */
  dmPolicy: z.enum(["open", "pairing", "allowlist"]).optional().default("open"),

  /** Group-message access policy: open, allowlist, or disabled. */
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional().default("open"),

  /** User IDs allowed when `dmPolicy` is `allowlist`. */
  allowFrom: z.array(z.string()).optional(),

  /** Sender IDs allowed when `groupPolicy` is `allowlist`. */
  groupAllowFrom: z.array(z.string()).optional(),

  /** Default disabled. Enabling `all` allows learned displayName lookup but may misroute on stale or duplicate names and is available to all callers until upstream exposes requester authz context. */
  displayNameResolution: z.enum(["disabled", "all"]).optional().default("disabled"),

  /** Controls how much supplemental host context remains visible to the reply runtime. `allowlist_quote` is the safest advanced mode when only explicit quotes or replies should remain visible. */
  contextVisibility: ContextVisibilitySchema.optional(),

  /** Allowed remote media download hosts, IPs, or CIDRs for media fetches. */
  mediaUrlAllowlist: z.array(z.string()).optional(),

  /** Native acknowledgement reaction mode: off, emoji, kaomoji, or a custom compatibility string. */
  ackReaction: AckReactionSchema.optional(),

  /** Retention window in days for short-lived message context used by quoting and media recovery. */
  journalTTLDays: z.number().int().min(1).optional().default(DEFAULT_MESSAGE_CONTEXT_TTL_DAYS),
  /** Enable verbose DingTalk channel debug logging. */
  debug: z.boolean().optional().default(false),

  /** Default reply delivery mode: markdown or card. */
  messageType: z.enum(["markdown", "card"]).optional().default("markdown"),

  /** Deprecated and ignored. AI card replies now always use the built-in DingTalk template contract. Keep only for backward-compatible config parsing. */
  cardTemplateId: z.string().optional(),

  /** Deprecated and ignored. The built-in AI card contract owns the streaming field mapping. Keep only for backward-compatible config parsing. */
  cardTemplateKey: z.string().optional().default("content"),

  /** Per-group overrides keyed by conversationId. Supports `*` as a wildcard fallback. */
  groups: z
    .record(
      z.string(),
      z.object({
        /** Additional system prompt appended for this group. */
        systemPrompt: z.string().optional(),
        /** Require an explicit @mention before the bot answers in this group. */
        requireMention: z.boolean().optional(),
        /** Optional per-group sender allowlist for tighter access control than the channel default. */
        groupAllowFrom: z.array(z.string()).optional(),
      }),
    )
    .optional(),

  /** Connection robustness configuration */

  /** Maximum connection attempts in a single reconnect cycle before backing off or giving up. */
  maxConnectionAttempts: z.number().int().min(1).optional().default(10),

  /** Initial reconnect backoff delay in milliseconds. */
  initialReconnectDelay: z.number().int().min(100).optional().default(1000),

  /** Upper bound for reconnect backoff delay in milliseconds. */
  maxReconnectDelay: z.number().int().min(1000).optional().default(60000),

  /** Randomization factor added to reconnect backoff to avoid synchronized reconnect storms. */
  reconnectJitter: z.number().min(0).max(1).optional().default(0.3),

  /** Maximum reconnect cycles before the channel stops retrying and waits for the next lifecycle restart. */
  maxReconnectCycles: z.number().int().min(1).optional().default(10),

  /** Time limit in milliseconds for one reconnect cycle before starting a fresh cycle. */
  reconnectDeadlineMs: z.number().int().min(5000).optional().default(50000),

  /** Enable the plugin connection manager. Disable only when you intentionally rely on DWClient native keepAlive plus autoReconnect behavior. */
  useConnectionManager: z.boolean().optional().default(true),

  /** Maximum inbound media size in MB accepted by the plugin. When omitted, the runtime default is used. */
  mediaMaxMb: z.number().int().min(1).optional(),

  /** Enable the underlying Stream client heartbeat. When omitted, runtime derives a default from `useConnectionManager`. */
  keepAlive: z.boolean().optional(),
  /** Bypass global or system HTTP(S) proxy settings for DingTalk send, upload, and card APIs. */
  bypassProxyForSend: z.boolean().optional().default(false),
  /** Controls the proactive-send permission reminder shown when a conversation has not granted send rights yet. */
  proactivePermissionHint: z
    .object({
      /** Show the proactive-send permission hint when the runtime detects missing DingTalk proactive permission. */
      enabled: z.boolean().optional().default(true),
      /** Minimum cooldown in hours before the same proactive permission hint can be shown again. */
      cooldownHours: z.number().int().min(1).max(24 * 30).optional().default(24),
    })
    .optional()
    .default({ enabled: true, cooldownHours: 24 }),

  /** Deprecated compatibility flag. When true and `cardStreamingMode` is unset, runtime resolves to `cardStreamingMode: "all"`. Do not use in new configs. */
  cardRealTimeStream: z.boolean().optional(),

  /** Card streaming mode:
   *  - off: disable incremental streaming
   *  - answer: stream answer text
   *  - all: stream answer + reasoning or thinking text */
  cardStreamingMode: CardStreamingModeSchema.optional(),

  /** Throttle interval in milliseconds between AI card streaming updates. */
  cardStreamInterval: z.number().int().min(200).optional().default(1000),

  /** Cooldown window in milliseconds after AI card trigger errors. Replies fall back to non-card delivery during this period. */
  aicardDegradeMs: z.number().int().min(60_000).optional().default(30 * 60 * 1000),

  /** Enable the local feedback-learning loop for notes, reflections, and command-assisted learning. */
  learningEnabled: z.boolean().optional(),

  /** Automatically apply generated learning output into session notes or global rules when available. */
  learningAutoApply: z.boolean().optional(),

  /** Retention window in milliseconds for temporary learning notes. */
  learningNoteTtlMs: z.number().int().min(60_000).optional(),

  /** Convert markdown tables to plain text before sending when you want more consistent DingTalk rendering. */
  convertMarkdownTables: z.boolean().optional().default(true),

  /** @mention the sender after card finalization in group chats.
   *  Set to a non-empty string (e.g. "✅ 回复完成") to enable — the value is used as the message text.
   *  Leave empty or omit to disable. */
  cardAtSender: z.string().optional(),

  /** Show model name in AI card status line footer. */
  cardStatusModel: z.boolean().optional().default(true),

  /** Show thinking effort level in AI card status line footer. */
  cardStatusEffort: z.boolean().optional().default(true),

  /** Show agent display name in AI card status line footer. */
  cardStatusAgent: z.boolean().optional().default(true),

  /** Show task elapsed time in AI card status line footer. */
  cardStatusTaskTime: z.boolean().optional().default(false),

  /** Show token usage summary (input/output/cache) in AI card status line footer. */
  cardStatusTokens: z.boolean().optional().default(false),

  /** Show DingTalk API call count in AI card status line footer. */
  cardStatusDapiUsage: z.boolean().optional().default(false),
} as const;

const DingTalkAccountConfigSchema = z.object(DingTalkAccountConfigShape);

/**
 * DingTalk configuration schema using Zod
 * Mirrors the structure needed for proper control-ui rendering
 */
export const DingTalkConfigSchema: z.ZodTypeAny = DingTalkAccountConfigSchema.extend({
  /** Multi-account configuration */
  accounts: z.record(z.string(), DingTalkAccountConfigSchema.optional()).optional(),
});

export type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>;
