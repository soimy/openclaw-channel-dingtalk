import { randomUUID } from "node:crypto";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { getAccessToken } from "./auth";
import { createAICard, streamAICard, finishAICard } from "./card-service";
import { getConfig, isConfigured, resolveRelativePath, stripTargetPrefix } from "./config";
import { DingTalkConfigSchema } from "./config-schema.js";
import { ConnectionManager } from "./connection-manager";
import { isMessageProcessed, markMessageProcessed } from "./dedup";
import { handleDingTalkMessage } from "./inbound-handler";
import { getLogger } from "./logger-context";
import { dingtalkOnboardingAdapter } from "./onboarding.js";
import { resolveOriginalPeerId } from "./peer-id-registry";
import {
  detectMediaTypeFromExtension,
  sendMessage,
  sendProactiveMedia,
  sendBySession,
  uploadMedia,
} from "./send-service";
import type {
  DingTalkInboundMessage,
  GatewayStartContext,
  GatewayStopResult,
  ConnectionManagerConfig,
  DingTalkChannelPlugin,
  ResolvedAccount,
} from "./types";
import { ConnectionState } from "./types";
import { cleanupOrphanedTempFiles, formatDingTalkErrorPayloadLog, getCurrentTimestamp } from "./utils";

const processingDedupKeys = new Set<string>();
const inboundCountersByAccount = new Map<
  string,
  {
    received: number;
    acked: number;
    dedupSkipped: number;
    inflightSkipped: number;
    processed: number;
    failed: number;
    noMessageId: number;
  }
>();
const INBOUND_COUNTER_LOG_EVERY = 10;

function getInboundCounters(accountId: string) {
  const existing = inboundCountersByAccount.get(accountId);
  if (existing) {
    return existing;
  }
  const created = {
    received: 0,
    acked: 0,
    dedupSkipped: 0,
    inflightSkipped: 0,
    processed: 0,
    failed: 0,
    noMessageId: 0,
  };
  inboundCountersByAccount.set(accountId, created);
  return created;
}

function logInboundCounters(log: any, accountId: string, reason: string): void {
  const stats = getInboundCounters(accountId);
  log?.info?.(
    `[${accountId}] Inbound counters (${reason}): received=${stats.received}, acked=${stats.acked}, processed=${stats.processed}, dedupSkipped=${stats.dedupSkipped}, inflightSkipped=${stats.inflightSkipped}, failed=${stats.failed}, noMessageId=${stats.noMessageId}`,
  );
}

// DingTalk Channel Definition (assembly layer).
// Heavy logic is delegated to service modules for maintainability.
export const dingtalkPlugin: DingTalkChannelPlugin = {
  id: "dingtalk",
  meta: {
    id: "dingtalk",
    label: "DingTalk",
    selectionLabel: "DingTalk (钉钉)",
    docsPath: "/channels/dingtalk",
    blurb: "钉钉企业内部机器人，使用 Stream 模式，无需公网 IP。",
    aliases: ["dd", "ding"],
  },
  configSchema: buildChannelConfigSchema(DingTalkConfigSchema),
  onboarding: dingtalkOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct", "group"] as Array<"direct" | "group">,
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.dingtalk"] },
  config: {
    listAccountIds: (cfg: OpenClawConfig): string[] => {
      const config = getConfig(cfg);
      return config.accounts && Object.keys(config.accounts).length > 0
        ? Object.keys(config.accounts)
        : isConfigured(cfg)
          ? ["default"]
          : [];
    },
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      const config = getConfig(cfg);
      const id = accountId || "default";
      const account = config.accounts?.[id];
      const resolvedConfig = account || config;
      const configured = Boolean(resolvedConfig.clientId && resolvedConfig.clientSecret);
      return {
        accountId: id,
        config: resolvedConfig,
        enabled: resolvedConfig.enabled !== false,
        configured,
        name: resolvedConfig.name || null,
      };
    },
    defaultAccountId: (): string => "default",
    isConfigured: (account: ResolvedAccount): boolean =>
      Boolean(account.config?.clientId && account.config?.clientSecret),
    describeAccount: (account: ResolvedAccount) => ({
      accountId: account.accountId,
      name: account.config?.name || "DingTalk",
      enabled: account.enabled,
      configured: Boolean(account.config?.clientId),
    }),
  },
  security: {
    resolveDmPolicy: ({ account }: any) => ({
      policy: account.config?.dmPolicy || "open",
      allowFrom: account.config?.allowFrom || [],
      policyPath: "channels.dingtalk.dmPolicy",
      allowFromPath: "channels.dingtalk.allowFrom",
      approveHint: "使用 /allow dingtalk:<userId> 批准用户",
      normalizeEntry: (raw: string) => raw.replace(/^(dingtalk|dd|ding):/i, ""),
    }),
  },
  groups: {
    resolveRequireMention: ({ cfg }: any): boolean => getConfig(cfg).groupPolicy !== "open",
    resolveGroupIntroHint: ({ groupId, groupChannel }: any): string | undefined => {
      const parts = [`conversationId=${groupId}`];
      if (groupChannel) {
        parts.push(`sessionKey=${groupChannel}`);
      }
      return `DingTalk IDs: ${parts.join(", ")}.`;
    },
  },
  messaging: {
    normalizeTarget: (raw: string) => (raw ? raw.replace(/^(dingtalk|dd|ding):/i, "") : undefined),
    targetResolver: {
      looksLikeId: (id: string): boolean => /^[\w+\-/=]+$/.test(id),
      hint: "<conversationId>",
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    resolveTarget: ({ to }: any) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false as const,
          error: new Error("DingTalk message requires --to <conversationId>"),
        };
      }
      const { targetId } = stripTargetPrefix(trimmed);
      const resolved = resolveOriginalPeerId(targetId);
      return { ok: true as const, to: resolved };
    },
    sendText: async ({ cfg, to, text, accountId, log }: any) => {
      const config = getConfig(cfg, accountId);
      try {
        const result = await sendMessage(config, to, text, { log, accountId });
        getLogger()?.debug?.(`[DingTalk] sendText: "${text}" result: ${JSON.stringify(result)}`);
        if (result.ok) {
          const data = result.data as any;
          const messageId = String(data?.processQueryKey || data?.messageId || randomUUID());
          return {
            channel: "dingtalk",
            messageId,
            meta: result.data
              ? { data: result.data as unknown as Record<string, unknown> }
              : undefined,
          };
        }
        throw new Error(
          typeof result.error === "string" ? result.error : JSON.stringify(result.error),
        );
      } catch (err: any) {
        if (err?.response?.data !== undefined) {
          log?.error?.(formatDingTalkErrorPayloadLog("outbound.sendText", err.response.data));
        }
        throw new Error(
          typeof err?.response?.data === "string"
            ? err.response.data
            : err?.message || "sendText failed",
          { cause: err },
        );
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
        throw new Error("DingTalk not configured");
      }

      // Support mediaPath/filePath/mediaUrl aliases for better CLI compatibility.
      const rawMediaPath = mediaPath || filePath || mediaUrl;

      getLogger()?.debug?.(
        `[DingTalk] sendMedia called: to=${to}, mediaPath=${mediaPath}, filePath=${filePath}, mediaUrl=${mediaUrl}, rawMediaPath=${rawMediaPath}`,
      );

      if (!rawMediaPath) {
        throw new Error(
          `mediaPath, filePath, or mediaUrl is required. Received: ${JSON.stringify({
            to,
            mediaPath,
            filePath,
            mediaUrl,
          })}`,
        );
      }

      const actualMediaPath = resolveRelativePath(rawMediaPath);

      getLogger()?.debug?.(
        `[DingTalk] sendMedia resolved path: rawMediaPath=${rawMediaPath}, actualMediaPath=${actualMediaPath}`,
      );

      try {
        const mediaType = providedMediaType || detectMediaTypeFromExtension(actualMediaPath);
        const result = await sendProactiveMedia(config, to, actualMediaPath, mediaType, {
          log,
          accountId,
        });
        getLogger()?.debug?.(
          `[DingTalk] sendMedia: ${mediaType} file=${actualMediaPath} result: ${JSON.stringify(result)}`,
        );

        if (result.ok) {
          const data = result.data;
          const messageId = String(
            result.messageId || data?.processQueryKey || data?.messageId || randomUUID(),
          );
          return {
            channel: "dingtalk",
            messageId,
            meta: result.data
              ? { data: result.data as unknown as Record<string, unknown> }
              : undefined,
          };
        }
        throw new Error(
          typeof result.error === "string" ? result.error : JSON.stringify(result.error),
        );
      } catch (err: any) {
        if (err?.response?.data !== undefined) {
          log?.error?.(formatDingTalkErrorPayloadLog("outbound.sendMedia", err.response.data));
        }
        throw new Error(
          typeof err?.response?.data === "string"
            ? err.response.data
            : err?.message || "sendMedia failed",
          { cause: err },
        );
      }
    },
  },
  gateway: {
    startAccount: async (ctx: GatewayStartContext): Promise<GatewayStopResult> => {
      const { account, cfg, abortSignal } = ctx;
      const config = account.config;
      if (!config.clientId || !config.clientSecret) {
        throw new Error("DingTalk clientId and clientSecret are required");
      }

      ctx.log?.info?.(`[${account.accountId}] Initializing DingTalk Stream client...`);

      cleanupOrphanedTempFiles(ctx.log);

      const client = new DWClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        debug: config.debug || false,
        keepAlive: true,
      });

      // Disable built-in reconnect so ConnectionManager owns all retry/backoff behavior.
      (client as any).config.autoReconnect = false;

      client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
        const messageId = res.headers?.messageId;
        const stats = getInboundCounters(account.accountId);
        stats.received += 1;
        try {
          if (messageId) {
            client.socketCallBackResponse(messageId, { success: true });
            stats.acked += 1;
          }
          const data = JSON.parse(res.data) as DingTalkInboundMessage;

          // Message deduplication key is bot-scoped to avoid cross-account conflicts.
          const robotKey = config.robotCode || config.clientId || account.accountId;
          const msgId = data.msgId || messageId;
          const dedupKey = msgId ? `${robotKey}:${msgId}` : undefined;

          if (!dedupKey) {
            ctx.log?.warn?.(`[${account.accountId}] No message ID available for deduplication`);
            stats.noMessageId += 1;
            await handleDingTalkMessage({
              cfg,
              accountId: account.accountId,
              data,
              sessionWebhook: data.sessionWebhook,
              log: ctx.log,
              dingtalkConfig: config,
            });
            stats.processed += 1;
            if (stats.received % INBOUND_COUNTER_LOG_EVERY === 0) {
              logInboundCounters(ctx.log, account.accountId, "periodic");
            }
            return;
          }

          if (isMessageProcessed(dedupKey)) {
            ctx.log?.debug?.(`[${account.accountId}] Skipping duplicate message: ${dedupKey}`);
            stats.dedupSkipped += 1;
            logInboundCounters(ctx.log, account.accountId, "dedup-skipped");
            return;
          }

          if (processingDedupKeys.has(dedupKey)) {
            ctx.log?.debug?.(
              `[${account.accountId}] Skipping in-flight duplicate message: ${dedupKey}`,
            );
            stats.inflightSkipped += 1;
            logInboundCounters(ctx.log, account.accountId, "inflight-skipped");
            return;
          }

          processingDedupKeys.add(dedupKey);
          try {
            await handleDingTalkMessage({
              cfg,
              accountId: account.accountId,
              data,
              sessionWebhook: data.sessionWebhook,
              log: ctx.log,
              dingtalkConfig: config,
            });
            stats.processed += 1;
            markMessageProcessed(dedupKey);
            if (stats.received % INBOUND_COUNTER_LOG_EVERY === 0) {
              logInboundCounters(ctx.log, account.accountId, "periodic");
            }
          } finally {
            processingDedupKeys.delete(dedupKey);
          }
        } catch (error: any) {
          stats.failed += 1;
          logInboundCounters(ctx.log, account.accountId, "failed");
          ctx.log?.error?.(`[${account.accountId}] Error processing message: ${error.message}`);
        }
      });

      // Guard against duplicate stop paths (abort signal + explicit stop).
      let stopped = false;

      const connectionConfig: ConnectionManagerConfig = {
        maxAttempts: config.maxConnectionAttempts ?? 10,
        initialDelay: config.initialReconnectDelay ?? 1000,
        maxDelay: config.maxReconnectDelay ?? 60000,
        jitter: config.reconnectJitter ?? 0.3,
        maxReconnectCycles: config.maxReconnectCycles,
        onStateChange: (state: ConnectionState, error?: string) => {
          if (stopped) {
            return;
          }
          ctx.log?.debug?.(
            `[${account.accountId}] Connection state changed to: ${state}${error ? ` (${error})` : ""}`,
          );
          if (state === ConnectionState.CONNECTED) {
            ctx.setStatus({
              ...ctx.getStatus(),
              running: true,
              lastStartAt: getCurrentTimestamp(),
              lastError: null,
            });
          } else if (state === ConnectionState.FAILED || state === ConnectionState.DISCONNECTED) {
            ctx.setStatus({
              ...ctx.getStatus(),
              running: false,
              lastError: error || `Connection ${state.toLowerCase()}`,
            });
          }
        },
      };

      ctx.log?.debug?.(
        `[${account.accountId}] Connection config: maxAttempts=${connectionConfig.maxAttempts}, ` +
          `initialDelay=${connectionConfig.initialDelay}ms, maxDelay=${connectionConfig.maxDelay}ms, ` +
          `jitter=${connectionConfig.jitter}`,
      );

      const connectionManager = new ConnectionManager(
        client,
        account.accountId,
        connectionConfig,
        ctx.log,
      );

      // Register abort listener before connect() so startup can be cancelled safely.
      if (abortSignal) {
        if (abortSignal.aborted) {
          ctx.log?.warn?.(
            `[${account.accountId}] Abort signal already active, skipping connection`,
          );

          ctx.setStatus({
            ...ctx.getStatus(),
            running: false,
            lastStopAt: getCurrentTimestamp(),
            lastError: "Connection aborted before start",
          });

          throw new Error("Connection aborted before start");
        }

        abortSignal.addEventListener("abort", () => {
          if (stopped) {
            return;
          }
          stopped = true;
          ctx.log?.info?.(
            `[${account.accountId}] Abort signal received, stopping DingTalk Stream client...`,
          );
          connectionManager.stop();

          ctx.setStatus({
            ...ctx.getStatus(),
            running: false,
            lastStopAt: getCurrentTimestamp(),
          });
        });
      }

      try {
        await connectionManager.connect();

        if (!stopped && connectionManager.isConnected()) {
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            lastStartAt: getCurrentTimestamp(),
            lastError: null,
          });
          ctx.log?.info?.(`[${account.accountId}] DingTalk Stream client connected successfully`);

          await connectionManager.waitForStop();
        } else {
          ctx.log?.info?.(
            `[${account.accountId}] DingTalk Stream client connect() completed but channel is ` +
              `not running (stopped=${stopped}, connected=${connectionManager.isConnected()})`,
          );
        }
      } catch (err: any) {
        ctx.log?.error?.(`[${account.accountId}] Failed to establish connection: ${err.message}`);

        ctx.setStatus({
          ...ctx.getStatus(),
          running: false,
          lastError: err.message || "Connection failed",
        });
        throw err;
      }

      return {
        stop: () => {
          if (stopped) {
            return;
          }
          stopped = true;
          ctx.log?.info?.(`[${account.accountId}] Stopping DingTalk Stream client...`);
          connectionManager.stop();

          ctx.setStatus({
            ...ctx.getStatus(),
            running: false,
            lastStopAt: getCurrentTimestamp(),
          });

          ctx.log?.info?.(`[${account.accountId}] DingTalk Stream client stopped`);
        },
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts: any[]) => {
      return accounts.flatMap((account) => {
        if (!account.configured) {
          return [
            {
              channel: "dingtalk",
              accountId: account.accountId,
              kind: "config" as const,
              message: "Account not configured (missing clientId or clientSecret)",
            },
          ];
        }
        return [];
      });
    },
    buildChannelSummary: ({ snapshot }: any) => ({
      configured: snapshot?.configured ?? false,
      running: snapshot?.running ?? false,
      lastStartAt: snapshot?.lastStartAt ?? null,
      lastStopAt: snapshot?.lastStopAt ?? null,
      lastError: snapshot?.lastError ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }: any) => {
      if (!account.configured || !account.config?.clientId || !account.config?.clientSecret) {
        return { ok: false, error: "Not configured" };
      }
      try {
        const controller = new AbortController();
        const timeoutId = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
        try {
          await getAccessToken(account.config);
          return { ok: true, details: { clientId: account.config.clientId } };
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        }
      } catch (error: any) {
        return { ok: false, error: error.message };
      }
    },
    buildAccountSnapshot: ({ account, runtime, snapshot, probe }: any) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      clientId: account.config?.clientId ?? null,
      running: runtime?.running ?? snapshot?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? snapshot?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? snapshot?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? snapshot?.lastError ?? null,
      probe,
    }),
  },
};

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
export { detectMediaTypeFromExtension } from "./media-utils";
