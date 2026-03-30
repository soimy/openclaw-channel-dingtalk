import { randomUUID } from "node:crypto";
import { DWClient, TOPIC_CARD, TOPIC_ROBOT } from "dingtalk-stream";
import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { buildChannelConfigSchema, type OpenClawConfig } from "openclaw/plugin-sdk/core";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { getAccessToken } from "./auth";
import { analyzeCardCallback } from "./card-callback-service";
import { handleCardAction } from "./card/card-action-handler";
import {
  createAICard,
  streamAICard,
  finishAICard,
  finalizeActiveCardsForAccount,
  recoverPendingCardsForAccount,
} from "./card-service";
import {
  getConfig,
  isConfigured,
  mergeAccountWithDefaults,
  resolveGroupConfig,
  resolveRelativePath,
  resolveRobotCode,
  stripTargetPrefix,
} from "./config";
import { DingTalkConfigSchema } from "./config-schema.js";
import { ConnectionManager } from "./connection-manager";
import { isMessageProcessed, markMessageProcessed } from "./dedup";
import {
  isLearningAutoApplyEnabled,
  isLearningEnabled,
  recordExplicitFeedbackLearning,
} from "./feedback-learning-service";
import { handleDingTalkMessage } from "./inbound-handler";
import { getLogger, setCurrentLogger } from "./logger-context";
import { prepareMediaInput, resolveOutboundMediaType } from "./media-utils";
import { dingtalkSetupAdapter, dingtalkSetupWizard } from "./onboarding.js";
import { resolveOriginalPeerId, preloadPeerIdsFromSessions } from "./peer-id-registry";
import { getDingTalkRuntime } from "./runtime";
import {
  sendMessage,
  sendProactiveMedia,
  sendProactiveTextOrMarkdown,
  sendBySession,
  uploadMedia,
} from "./send-service";
import {
  listDingTalkDirectoryGroups,
  listDingTalkDirectoryUsers,
  normalizeResolvedDingTalkTarget,
} from "./targeting/target-directory-adapter";
import { looksLikeDingTalkTargetId, normalizeDingTalkTarget } from "./targeting/target-input";
import type {
  DingTalkInboundMessage,
  GatewayStartContext,
  GatewayStopResult,
  ConnectionManagerConfig,
  DingTalkChannelPlugin,
  ResolvedAccount,
  StreamClientFactory,
} from "./types";
import { ConnectionState } from "./types";
import {
  buildExecApprovalText,
  buildPluginApprovalText,
} from "./approval-message-builder";
import {
  closePluginDebugLog,
  cleanupOrphanedTempFiles,
  createResolve4FallbackLookup,
  formatDingTalkConnectionErrorLog,
  formatDingTalkErrorPayloadLog,
  getCurrentTimestamp,
  parseBooleanLike,
  resolvePluginDebugLog,
} from "./utils";

type InstrumentedDWClient = {
  getEndpoint?: () => Promise<unknown>;
  _connect?: () => Promise<unknown>;
  config?: Record<string, unknown> & { endpoint?: { endpoint?: string } | string };
  dw_url?: string;
};

function attachConnectionErrorContext(
  err: unknown,
  stage: "connect.open" | "connect.websocket",
  endpoint?: string,
): void {
  if (!err || typeof err !== "object") {
    return;
  }
  const target = err as Record<string, unknown>;
  if (typeof target.dingtalkConnectionStage !== "string") {
    target.dingtalkConnectionStage = stage;
  }
  if (endpoint && typeof target.dingtalkConnectionEndpoint !== "string") {
    target.dingtalkConnectionEndpoint = endpoint;
  }
}

function getInstrumentedEndpoint(client: InstrumentedDWClient): string | undefined {
  if (typeof client.dw_url === "string" && client.dw_url.length > 0) {
    return client.dw_url;
  }

  const endpointConfig = client.config?.endpoint;
  if (typeof endpointConfig === "string") {
    return endpointConfig;
  }
  if (
    endpointConfig &&
    typeof endpointConfig === "object" &&
    typeof endpointConfig.endpoint === "string"
  ) {
    return endpointConfig.endpoint;
  }
  return undefined;
}

function instrumentConnectionStages(client: DWClient): void {
  const instrumented = client as unknown as InstrumentedDWClient;
  if (
    typeof instrumented.getEndpoint !== "function" ||
    typeof instrumented._connect !== "function"
  ) {
    return;
  }

  const originalGetEndpoint = instrumented.getEndpoint.bind(instrumented);
  const originalSocketConnect = instrumented._connect.bind(instrumented);

  instrumented.getEndpoint = async () => {
    try {
      return await originalGetEndpoint();
    } catch (err) {
      attachConnectionErrorContext(err, "connect.open");
      throw err;
    }
  };

  instrumented._connect = async () => {
    try {
      return await originalSocketConnect();
    } catch (err) {
      attachConnectionErrorContext(err, "connect.websocket", getInstrumentedEndpoint(instrumented));
      throw err;
    }
  };
}

const INFLIGHT_TTL_MS = 5 * 60 * 1000; // 5 min safety net for hung handlers
const processingDedupKeys = new Map<string, number>(); // key → timestamp when acquired
export const CHANNEL_INFLIGHT_NAMESPACE_POLICY = "memory-only" as const;
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

function readBooleanLikeParam(params: Record<string, unknown>, key: string): boolean | undefined {
  return parseBooleanLike(params[key]);
}

function readSharedAudioAsVoiceParam(params: Record<string, unknown>): boolean {
  const sharedValue = readBooleanLikeParam(params, "audioAsVoice");
  if (sharedValue !== undefined) {
    return sharedValue;
  }
  return readBooleanLikeParam(params, "asVoice") === true;
}

function describeDingTalkMessageTool(cfg: OpenClawConfig): {
  actions: readonly ["send"] | readonly [];
  capabilities: readonly ["cards"] | readonly [];
  schema: null;
} {
  const config = getConfig(cfg);
  const configured = Boolean(config.clientId && config.clientSecret);
  if (!configured && !(config.accounts && Object.keys(config.accounts).length > 0)) {
    return { actions: [], capabilities: [], schema: null };
  }
  const hasCardMode =
    config.messageType === "card" ||
    (config.accounts && Object.values(config.accounts).some((a) => a?.messageType === "card"));
  return {
    actions: ["send"] as const,
    capabilities: hasCardMode ? (["cards"] as const) : [],
    schema: null,
  };
}

const dingtalkMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg }) => describeDingTalkMessageTool(cfg),
  supportsAction: ({ action }) => action === "send",
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async ({ action, params, cfg, accountId, dryRun, mediaLocalRoots }) => {
    if (action !== "send") {
      throw new Error(`Action ${action} is not supported for provider dingtalk.`);
    }

    const to = readStringParam(params, "to", { required: true });
    const mediaInput =
      readStringParam(params, "media", { trim: false }) ??
      readStringParam(params, "path", { trim: false }) ??
      readStringParam(params, "filePath", { trim: false }) ??
      readStringParam(params, "mediaUrl", { trim: false });

    const hasMedia = Boolean(mediaInput && mediaInput.trim());
    const caption = readStringParam(params, "caption", { allowEmpty: true }) ?? "";
    let message =
      readStringParam(params, "message", {
        required: !hasMedia,
        allowEmpty: true,
      }) ?? "";

    if (!message.trim() && caption.trim()) {
      message = caption;
    }

    const asVoice = readSharedAudioAsVoiceParam(params);
    const requestedMediaType = readStringParam(params, "mediaType");

    const target = resolveOriginalPeerId(stripTargetPrefix(to).targetId);

    if (dryRun) {
      return jsonResult({
        ok: true,
        dryRun: true,
        to: target,
        hasMedia,
        asVoice,
      });
    }

    const log = getLogger();
    const config = getConfig(cfg, accountId ?? undefined);

    if (hasMedia && mediaInput) {
      let preparedMedia;
      try {
        preparedMedia = await prepareMediaInput(mediaInput, log, config.mediaUrlAllowlist);
        const mediaPath = preparedMedia.cleanup
          ? preparedMedia.path
          : resolveRelativePath(preparedMedia.path);
        const mediaType = resolveOutboundMediaType({
          mediaType: requestedMediaType ?? undefined,
          mediaPath,
          asVoice,
        });
        const result = await sendProactiveMedia(config, target, mediaPath, mediaType, {
          log,
          accountId: accountId ?? undefined,
          mediaLocalRoots: mediaLocalRoots ? [...mediaLocalRoots] : undefined,
        });

        if (!result.ok) {
          throw new Error(result.error || "send media failed");
        }

        return jsonResult({
          ok: true,
          to: target,
          mediaType,
          messageId: result.messageId ?? null,
          result: result.data ?? null,
        });
      } finally {
        await preparedMedia?.cleanup?.();
      }
    }

    if (asVoice) {
      throw new Error(
        "DingTalk send with asVoice requires media/path/filePath/mediaUrl pointing to an audio file.",
      );
    }

    if (!message.trim()) {
      throw new Error("send requires message when media is not provided");
    }

    const result = await sendMessage(config, target, message, {
      log,
      accountId: accountId ?? undefined,
    });

    if (!result.ok) {
      throw new Error(result.error || "send message failed");
    }

    const data = result.data as any;
    return jsonResult({
      ok: true,
      to: target,
      messageId: data?.processQueryKey || data?.messageId || null,
      result: data ?? null,
    });
  },
};

// DingTalk Channel Definition (assembly layer).
// Heavy logic is delegated to service modules for maintainability.
export const dingtalkPlugin: DingTalkChannelPlugin = {
  id: "dingtalk",
  meta: {
    id: "dingtalk",
    label: "DingTalk",
    selectionLabel: "DingTalk (钉钉)",
    docsPath: "https://github.com/soimy/openclaw-channel-dingtalk",
    blurb: "钉钉企业内部机器人，使用 Stream 模式，无需公网 IP。",
    aliases: ["dd", "ding"],
  },
  configSchema: buildChannelConfigSchema(DingTalkConfigSchema),
  setup: dingtalkSetupAdapter,
  setupWizard: dingtalkSetupWizard,
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
      const resolvedConfig = account ? mergeAccountWithDefaults(config, account) : config;
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
    resolveRequireMention: ({ cfg, groupId }: any): boolean => {
      const config = getConfig(cfg);
      if (groupId) {
        const groupCfg = resolveGroupConfig(config, groupId);
        if (groupCfg?.requireMention !== undefined) {
          return groupCfg.requireMention;
        }
      }
      return config.groupPolicy !== "open";
    },
    resolveGroupIntroHint: ({ groupId, groupChannel }: any): string | undefined => {
      const parts = [`conversationId=${groupId}`];
      if (groupChannel) {
        parts.push(`sessionKey=${groupChannel}`);
      }
      return `DingTalk IDs: ${parts.join(", ")}.`;
    },
  },
  messaging: {
    normalizeTarget: (raw: string) => (raw ? normalizeDingTalkTarget(raw) : undefined),
    targetResolver: {
      looksLikeId: (raw: string, normalized?: string): boolean =>
        looksLikeDingTalkTargetId(raw, normalized),
      hint: "<displayName|conversationId|user:staffId|user:+861...>",
    },
  },
  directory: {
    self: async () => null,
    listGroups: async (params) => listDingTalkDirectoryGroups(params),
    listGroupsLive: async (params) => listDingTalkDirectoryGroups(params),
    listPeers: async (params) => listDingTalkDirectoryUsers(params),
    listPeersLive: async (params) => listDingTalkDirectoryUsers(params),
  },
  actions: dingtalkMessageActions,
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
      return { ok: true as const, to: normalizeResolvedDingTalkTarget(trimmed) };
    },
    sendText: async ({ cfg, to, text, accountId, log }: any) => {
      const config = getConfig(cfg, accountId);
      const rt = getDingTalkRuntime();
      const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: accountId,
      });
      const effectiveLog = getLogger(accountId) || log;
      try {
        const result = await sendMessage(config, to, text, {
          log: effectiveLog,
          accountId,
          storePath,
          conversationId: to,
        });
        effectiveLog?.debug?.(`[DingTalk] sendText: "${text}" result: ${JSON.stringify(result)}`);
        if (!result.ok) {
          throw new Error(result.error || "sendText failed");
        }
        const data = result.data as any;
        const messageId = String(data?.processQueryKey || data?.messageId || randomUUID());
        const meta =
          result.data || result.tracking
            ? {
                ...(result.data ? { data: result.data as unknown as Record<string, unknown> } : {}),
                ...(result.tracking ? { tracking: result.tracking } : {}),
              }
            : undefined;
        return {
          channel: "dingtalk",
          messageId,
          meta,
        };
      } catch (err: any) {
        if (err?.response?.data !== undefined) {
          effectiveLog?.error?.(formatDingTalkErrorPayloadLog("outbound.sendText", err.response.data));
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
      audioAsVoice,
      asVoice,
      accountId,
      mediaLocalRoots,
      log,
    }: any) => {
      const config = getConfig(cfg, accountId);
      const rt = getDingTalkRuntime();
      const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: accountId,
      });
      const effectiveLog = getLogger(accountId) || log;
      if (!config.clientId) {
        throw new Error("DingTalk not configured");
      }

      // Support mediaPath/filePath/mediaUrl aliases for better CLI compatibility.
      const rawMediaPath = mediaPath || filePath || mediaUrl;

      effectiveLog?.debug?.(
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

      let preparedMedia;
      try {
        try {
          preparedMedia = await prepareMediaInput(rawMediaPath, effectiveLog, config.mediaUrlAllowlist);
        } catch (err: any) {
          if (err?.response?.data !== undefined) {
            effectiveLog?.error?.(
              formatDingTalkErrorPayloadLog("outbound.sendMedia.prepare", err.response.data),
            );
          }
          const errorCode = typeof err?.code === "string" ? `[${err.code}] ` : "";
          throw new Error(
            `remote media preparation failed: ${errorCode}${err?.message || "unknown error"}`,
            {
              cause: err,
            },
          );
        }

        const actualMediaPath = preparedMedia.cleanup
          ? preparedMedia.path
          : resolveRelativePath(preparedMedia.path);

        effectiveLog?.debug?.(
          `[DingTalk] sendMedia resolved path: rawMediaPath=${rawMediaPath}, actualMediaPath=${actualMediaPath}`,
        );

        const mediaType = resolveOutboundMediaType({
          mediaType: typeof providedMediaType === "string" ? providedMediaType : undefined,
          mediaPath: actualMediaPath,
          asVoice: readSharedAudioAsVoiceParam({ audioAsVoice, asVoice }),
        });
        let result;
        try {
          result = await sendProactiveMedia(config, to, actualMediaPath, mediaType, {
            log: effectiveLog,
            accountId,
            storePath,
            conversationId: to,
            mediaLocalRoots,
          });
        } catch (err: any) {
          if (err?.response?.data !== undefined) {
            effectiveLog?.error?.(
              formatDingTalkErrorPayloadLog("outbound.sendMedia.send", err.response.data),
            );
          }
          throw new Error(`proactive media send failed: ${err?.message || "unknown error"}`, {
            cause: err,
          });
        }
        effectiveLog?.debug?.(
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
          effectiveLog?.error?.(formatDingTalkErrorPayloadLog("outbound.sendMedia", err.response.data));
        }
        throw new Error(
          typeof err?.response?.data === "string"
            ? err.response.data
            : err?.message || "sendMedia failed",
          { cause: err },
        );
      } finally {
        await preparedMedia?.cleanup?.();
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
      let accountStorePath: string | undefined;
      try {
        const rt = getDingTalkRuntime();
        accountStorePath = rt.channel.session.resolveStorePath(cfg.session?.store, {
          agentId: account.accountId,
        });
      } catch {
        accountStorePath = undefined;
      }

      const pluginLog = resolvePluginDebugLog({
        accountId: account.accountId,
        storePath: accountStorePath,
        debug: config.debug,
        baseLog: ctx.log,
      });
      setCurrentLogger(pluginLog, account.accountId);

      pluginLog?.info?.(`[${account.accountId}] Initializing DingTalk Stream client...`);

      // Preload known peer IDs from sessions so outbound delivery (e.g. cron
      // jobs that fire immediately after startup) can resolve the original
      // case-sensitive conversationId before any inbound message has arrived.
      preloadPeerIdsFromSessions();
      pluginLog?.debug?.(`[${account.accountId}] Peer ID registry preloaded from sessions`);

      cleanupOrphanedTempFiles(pluginLog);
      try {
        const recovered = await recoverPendingCardsForAccount(
          config,
          account.accountId,
          accountStorePath,
          pluginLog,
        );
        if (recovered > 0) {
          pluginLog?.info?.(
            `[${account.accountId}] Recovered and finalized ${recovered} unfinished card(s) from previous runtime`,
          );
        }
      } catch (err: any) {
        pluginLog?.warn?.(
          `[${account.accountId}] Failed to recover unfinished cards: ${err.message}`,
        );
      }

      const useConnectionManager = config.useConnectionManager ?? true;
      const applyStatusPatch = (patch: Record<string, unknown>) => {
        ctx.setStatus({
          ...ctx.getStatus(),
          ...patch,
        });
      };

      // Factory that creates a fresh DWClient with the TOPIC_ROBOT callback
      // already registered. Each client captures its own reference for
      // socketCallBackResponse so acks are sent on the correct socket.
      // ConnectionManager uses this to create new clients during warm
      // reconnection, minimizing the message-loss window when the DingTalk
      // server initiates a disconnect for load balancing.
      const createStreamClient: StreamClientFactory = () => {
        const c = new DWClient({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          debug: config.debug || false,
          keepAlive: config.keepAlive ?? !useConnectionManager,
        });
        (c as any).sslopts = {
          ...(c as any).sslopts,
          lookup: createResolve4FallbackLookup(pluginLog, account.accountId),
        };

        instrumentConnectionStages(c);

        (c as any).config.autoReconnect = !useConnectionManager;

        c.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
          const messageId = res.headers?.messageId;
          const stats = getInboundCounters(account.accountId);
          stats.received += 1;
          const acknowledge = () => {
            if (!messageId) {
              return;
            }
            try {
              c.socketCallBackResponse(messageId, { success: true });
              stats.acked += 1;
            } catch (ackError: any) {
              pluginLog?.warn?.(
                `[${account.accountId}] Failed to acknowledge callback ${messageId}: ${ackError.message}`,
              );
            }
          };
          try {
            const data = JSON.parse(res.data) as DingTalkInboundMessage;
            // Record the latest inbound callback arrival for status/UI projection.
            // This intentionally tracks "message reached the plugin callback" rather
            // than "message passed dedup and completed processing".
            applyStatusPatch({
              connected: true,
              lastInboundAt: getCurrentTimestamp(),
              lastEventAt: getCurrentTimestamp(),
            });

            const robotKey = resolveRobotCode(config) || account.accountId;
            const msgId = data.msgId || messageId;
            const dedupKey = msgId ? `${robotKey}:${msgId}` : undefined;

            if (!dedupKey) {
              ctx.log?.warn?.(`[${account.accountId}] No message ID available for deduplication`);
              stats.noMessageId += 1;
              acknowledge();
              await handleDingTalkMessage({
                cfg,
                accountId: account.accountId,
                data,
                sessionWebhook: data.sessionWebhook,
                log: pluginLog,
                dingtalkConfig: config,
              });
              stats.processed += 1;
              if (stats.received % INBOUND_COUNTER_LOG_EVERY === 0) {
                logInboundCounters(pluginLog, account.accountId, "periodic");
              }
              return;
            }

            if (isMessageProcessed(dedupKey)) {
              pluginLog?.debug?.(`[${account.accountId}] Skipping duplicate message: ${dedupKey}`);
              stats.dedupSkipped += 1;
              acknowledge();
              logInboundCounters(pluginLog, account.accountId, "dedup-skipped");
              return;
            }

            const inflightSince = processingDedupKeys.get(dedupKey);
            if (inflightSince !== undefined) {
              if (Date.now() - inflightSince > INFLIGHT_TTL_MS) {
                pluginLog?.warn?.(
                  `[${account.accountId}] Releasing stale in-flight lock for ${dedupKey} (held ${Date.now() - inflightSince}ms > TTL ${INFLIGHT_TTL_MS}ms)`,
                );
                processingDedupKeys.delete(dedupKey);
              } else {
                pluginLog?.debug?.(
                  `[${account.accountId}] Skipping in-flight duplicate message: ${dedupKey}`,
                );
                stats.inflightSkipped += 1;
                acknowledge();
                logInboundCounters(pluginLog, account.accountId, "inflight-skipped");
                return;
              }
            }

            acknowledge();
            processingDedupKeys.set(dedupKey, Date.now());
            try {
              await handleDingTalkMessage({
                cfg,
                accountId: account.accountId,
                data,
                sessionWebhook: data.sessionWebhook,
                log: pluginLog,
                dingtalkConfig: config,
              });
              stats.processed += 1;
              markMessageProcessed(dedupKey);
              if (stats.received % INBOUND_COUNTER_LOG_EVERY === 0) {
                logInboundCounters(pluginLog, account.accountId, "periodic");
              }
            } finally {
              processingDedupKeys.delete(dedupKey);
            }
          } catch (error: any) {
            stats.failed += 1;
            logInboundCounters(pluginLog, account.accountId, "failed");
            pluginLog?.error?.(`[${account.accountId}] Error processing message: ${error.message}`);
          }
        });

        c.registerCallbackListener(TOPIC_CARD, async (res: any) => {
          const messageId = res.headers?.messageId;
          const acknowledge = () => {
            if (!messageId) {
              return;
            }
            try {
              c.socketCallBackResponse(messageId, { success: true });
            } catch (ackError: any) {
              pluginLog?.warn?.(
                `[${account.accountId}] Failed to acknowledge card callback ${messageId}: ${ackError.message}`,
              );
            }
          };

          try {
            const payload = JSON.parse(res.data);
            const analysis = analyzeCardCallback(payload);
            pluginLog?.info?.(
              `[${account.accountId}] [DingTalk][CardCallback] action=${analysis.summary} raw=${JSON.stringify(payload)}`,
            );

            if (analysis.feedbackTarget && analysis.feedbackAckText) {
              recordExplicitFeedbackLearning({
                enabled: isLearningEnabled(config),
                autoApply: isLearningAutoApplyEnabled(config),
                storePath: accountStorePath,
                accountId: account.accountId,
                targetId: analysis.feedbackTarget,
                feedbackType: analysis.actionId === "feedback_up" ? "feedback_up" : "feedback_down",
                userId: analysis.userId,
                processQueryKey: analysis.processQueryKey,
                noteTtlMs: config.learningNoteTtlMs,
              });
              try {
                await sendProactiveTextOrMarkdown(
                  config,
                  analysis.feedbackTarget,
                  analysis.feedbackAckText,
                  {
                    accountId: account.accountId,
                    log: pluginLog,
                  },
                );
                pluginLog?.info?.(
                  `[${account.accountId}] [DingTalk][CardCallback] feedback ack sent to ${analysis.feedbackTarget}`,
                );
              } catch (sendErr: any) {
                pluginLog?.warn?.(
                  `[${account.accountId}] [DingTalk][CardCallback] Failed to send feedback ack: ${sendErr?.message || String(sendErr)}`,
                );
              }
            }
            const actionResult = await handleCardAction({
              analysis,
              cfg,
              accountId: account.accountId,
              config,
              log: pluginLog,
            });
            if (!actionResult.handled && analysis.actionId && analysis.actionId !== "feedback_up" && analysis.actionId !== "feedback_down") {
              pluginLog?.debug?.(
                `[${account.accountId}] [DingTalk][CardCallback] Unhandled actionId=${analysis.actionId}`,
              );
            }
          } catch (error: any) {
            pluginLog?.error?.(
              `[${account.accountId}] [DingTalk][CardCallback] Failed to parse callback: ${error.message}`,
            );
          } finally {
            acknowledge();
          }
        });

        return c;
      };

      const client = createStreamClient();

      // Guard against duplicate stop paths (abort signal + explicit stop).
      let stopped = false;
      let nativeStopResolve: (() => void) | undefined;
      const nativeStopPromise = new Promise<void>((resolve) => {
        nativeStopResolve = resolve;
      });
      let connectionManager: ConnectionManager | undefined;

      const stopClient = () => {
        if (stopped) {
          return;
        }
        stopped = true;
        pluginLog?.info?.(`[${account.accountId}] Stopping DingTalk Stream client...`);
        void finalizeActiveCardsForAccount(
          config,
          account.accountId,
          "⚠️ 服务正在重启，当前回复已中断。请重新发送你的问题。",
          accountStorePath,
          pluginLog,
        ).catch((err: any) => {
          pluginLog?.debug?.(
            `[${account.accountId}] Failed to finalize active cards during stop: ${err.message}`,
          );
        });
        if (useConnectionManager) {
          connectionManager?.stop();
        } else {
          try {
            client.disconnect();
          } catch (err: any) {
            pluginLog?.warn?.(`[${account.accountId}] Error during disconnect: ${err.message}`);
          }
          nativeStopResolve?.();
        }

        applyStatusPatch({
          running: false,
          connected: false,
          lastEventAt: getCurrentTimestamp(),
          lastStopAt: getCurrentTimestamp(),
        });

        pluginLog?.info?.(`[${account.accountId}] DingTalk Stream client stopped`);
        closePluginDebugLog({
          accountId: account.accountId,
          storePath: accountStorePath,
        });
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          pluginLog?.warn?.(
            `[${account.accountId}] Abort signal already active, skipping connection`,
          );

          applyStatusPatch({
            running: false,
            connected: false,
            lastEventAt: getCurrentTimestamp(),
            lastStopAt: getCurrentTimestamp(),
            lastError: "Connection aborted before start",
          });

          throw new Error("Connection aborted before start");
        }

        abortSignal.addEventListener("abort", () => {
          if (stopped) {
            return;
          }
          pluginLog?.info?.(
            `[${account.accountId}] Abort signal received, stopping DingTalk Stream client...`,
          );
          stopClient();
        });
      }

      if (!useConnectionManager) {
        try {
          await client.connect();
          if (!stopped) {
            applyStatusPatch({
              running: true,
              connected: true,
              lastConnectedAt: getCurrentTimestamp(),
              lastEventAt: getCurrentTimestamp(),
              lastStartAt: getCurrentTimestamp(),
              lastError: null,
            });
            pluginLog?.info?.(`[${account.accountId}] DingTalk Stream client connected successfully`);
            await nativeStopPromise;
          }
        } catch (err: any) {
          pluginLog?.error?.(
            formatDingTalkConnectionErrorLog(
              // Use connect.open as base scope; instrumentation can override to connect.websocket
              "connect.open",
              err,
              `[${account.accountId}] Failed to establish connection: ${err.message}`,
            ) ?? `[${account.accountId}] Failed to establish connection: ${err.message}`,
          );
          applyStatusPatch({
            running: false,
            connected: false,
            lastEventAt: getCurrentTimestamp(),
            lastError: err.message || "Connection failed",
          });
          throw err;
        }

        return {
          stop: () => {
            stopClient();
          },
        };
      }

      const connectionConfig: ConnectionManagerConfig = {
        maxAttempts: config.maxConnectionAttempts ?? 10,
        initialDelay: config.initialReconnectDelay ?? 1000,
        maxDelay: config.maxReconnectDelay ?? 60000,
        jitter: config.reconnectJitter ?? 0.3,
        maxReconnectCycles: config.maxReconnectCycles,
        reconnectDeadlineMs: config.reconnectDeadlineMs,
        onStateChange: (state: ConnectionState, error?: string) => {
          if (stopped) {
            return;
          }
          pluginLog?.debug?.(
            `[${account.accountId}] Connection state changed to: ${state}${error ? ` (${error})` : ""}`,
          );
          if (state === ConnectionState.CONNECTED) {
            applyStatusPatch({
              running: true,
              connected: true,
              lastConnectedAt: getCurrentTimestamp(),
              lastEventAt: getCurrentTimestamp(),
              lastStartAt: getCurrentTimestamp(),
              lastError: null,
            });
          } else if (state === ConnectionState.FAILED || state === ConnectionState.DISCONNECTED) {
            // Clear stale in-flight locks for this account on disconnect.
            // DingTalk will redeliver unacknowledged messages on reconnect; without
            // this cleanup the redelivered messages would be silently skipped forever.
            const robotKey = resolveRobotCode(config) || account.accountId;
            let cleared = 0;
            for (const key of processingDedupKeys.keys()) {
              if (key.startsWith(`${robotKey}:`)) {
                processingDedupKeys.delete(key);
                cleared++;
              }
            }
            if (cleared > 0) {
              pluginLog?.info?.(
                `[${account.accountId}] Cleared ${cleared} stale in-flight lock(s) on disconnect`,
              );
            }
            applyStatusPatch({
              running: false,
              connected: false,
              lastEventAt: getCurrentTimestamp(),
              lastError: error || `Connection ${state.toLowerCase()}`,
            });
          }
        },
      };

      pluginLog?.debug?.(
        `[${account.accountId}] Connection config: maxAttempts=${connectionConfig.maxAttempts}, ` +
          `initialDelay=${connectionConfig.initialDelay}ms, maxDelay=${connectionConfig.maxDelay}ms, ` +
          `jitter=${connectionConfig.jitter}`,
      );

      connectionManager = new ConnectionManager(
        client,
        account.accountId,
        connectionConfig,
        pluginLog,
        createStreamClient,
      );

      try {
        await connectionManager.connect();

        if (!stopped && connectionManager.isConnected()) {
          applyStatusPatch({
            running: true,
            connected: true,
            lastConnectedAt: getCurrentTimestamp(),
            lastEventAt: getCurrentTimestamp(),
            lastStartAt: getCurrentTimestamp(),
            lastError: null,
          });
          pluginLog?.info?.(`[${account.accountId}] DingTalk Stream client connected successfully`);

          await connectionManager.waitForStop();
        } else {
          pluginLog?.info?.(
            `[${account.accountId}] DingTalk Stream client connect() completed but channel is ` +
              `not running (stopped=${stopped}, connected=${connectionManager.isConnected()})`,
          );
        }
      } catch (err: any) {
        pluginLog?.error?.(
          formatDingTalkConnectionErrorLog(
            // Use connect.open as base scope; instrumentation can override to connect.websocket
            "connect.open",
            err,
            `[${account.accountId}] Failed to establish connection: ${err.message}`,
          ) ?? `[${account.accountId}] Failed to establish connection: ${err.message}`,
        );

        applyStatusPatch({
          running: false,
          connected: false,
          lastEventAt: getCurrentTimestamp(),
          lastError: err.message || "Connection failed",
        });
        throw err;
      }

      return {
        stop: () => {
          stopClient();
        },
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      connected: false,
      lastEventAt: null,
      lastConnectedAt: null,
      lastInboundAt: null,
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
    buildAccountSnapshot: ({ account, runtime, snapshot, probe }: any) => {
      const running = runtime?.running ?? snapshot?.running ?? false;
      const persistedLastEventAt = runtime?.lastEventAt ?? snapshot?.lastEventAt ?? null;

      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        clientId: account.config?.clientId ?? null,
        running,
        connected: runtime?.connected ?? snapshot?.connected ?? null,
        lastEventAt: running ? getCurrentTimestamp() : persistedLastEventAt,
        lastConnectedAt: runtime?.lastConnectedAt ?? snapshot?.lastConnectedAt ?? null,
        lastInboundAt: runtime?.lastInboundAt ?? snapshot?.lastInboundAt ?? null,
        lastStartAt: runtime?.lastStartAt ?? snapshot?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? snapshot?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? snapshot?.lastError ?? null,
        probe,
      };
    },
  },
  execApprovals: {
    buildPendingPayload: ({ request, nowMs }: { request: any; nowMs: number }) => ({
      text: buildExecApprovalText(request, nowMs),
    }),
    buildPluginPendingPayload: ({ request, nowMs }: { request: any; nowMs: number }) => ({
      text: buildPluginApprovalText(request, nowMs),
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
