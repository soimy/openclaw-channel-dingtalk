import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import pluginManifest from "../openclaw.plugin.json";
import {
  CHANNEL_INFLIGHT_NAMESPACE_POLICY,
  createDingTalkGateway,
} from "./gateway/channel-gateway";
import { createDingTalkMessageActions } from "./messaging/channel-actions";
import { createDingTalkOutbound } from "./messaging/channel-outbound";
import { createDingTalkStatus } from "./platform/channel-status";
import {
  assertDingTalkAccountIds,
  getConfig,
  isConfigured,
  mergeAccountWithDefaults,
  resolveDingTalkDefaultAccountId,
  resolveGroupConfig,
} from "./platform/config";
import { dingtalkSetupAdapter, dingtalkSetupWizard } from "./platform/onboarding.js";
import { hasConfiguredSecretInput } from "./platform/secret-input";
import type { DingTalkChannelPlugin, ResolvedAccount } from "./platform/types";
import {
  listDingTalkDirectoryGroups,
  listDingTalkDirectoryUsers,
} from "./targeting/target-directory-adapter";
import { looksLikeDingTalkTargetId, normalizeDingTalkTarget } from "./targeting/target-input";

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
  configSchema: buildJsonChannelConfigSchema(pluginManifest.channelConfigs.dingtalk.schema),
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
      const id = accountId ?? resolveDingTalkDefaultAccountId(cfg);
      assertDingTalkAccountIds(config, id);
      const account = config.accounts?.[id];
      const resolvedConfig = account ? mergeAccountWithDefaults(config, account) : config;
      const configured = Boolean(
        resolvedConfig.clientId && hasConfiguredSecretInput(resolvedConfig.clientSecret),
      );
      return {
        accountId: id,
        config: resolvedConfig,
        enabled: resolvedConfig.enabled !== false,
        configured,
        name: resolvedConfig.name || null,
      };
    },
    defaultAccountId: resolveDingTalkDefaultAccountId,
    isConfigured: (account: ResolvedAccount): boolean =>
      Boolean(account.config?.clientId && hasConfiguredSecretInput(account.config?.clientSecret)),
    describeAccount: (account: ResolvedAccount) => ({
      accountId: account.accountId,
      name: account.config?.name || "DingTalk",
      enabled: account.enabled,
      configured: Boolean(account.config?.clientId),
    }),
  },
  pairing: {
    idLabel: "dingtalkUserId",
    normalizeAllowEntry: (raw: string) => raw.replace(/^(dingtalk|dd|ding):/i, ""),
  },
  security: {
    resolveDmPolicy: ({ account }: any) => ({
      policy: account.config?.dmPolicy || "open",
      allowFrom: account.config?.allowFrom || [],
      policyPath: "channels.dingtalk.dmPolicy",
      allowFromPath: "channels.dingtalk.allowFrom",
      approveHint: "使用 openclaw pairing approve dingtalk <code> --account <accountId> 批准用户",
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
  actions: createDingTalkMessageActions(),
  outbound: createDingTalkOutbound(),
  gateway: createDingTalkGateway(),
  status: createDingTalkStatus(),
};

export { CHANNEL_INFLIGHT_NAMESPACE_POLICY };
export { getAccessToken } from "./platform/auth";
export { createAICard, finishAICard, streamAICard } from "./card/card-service";
export { detectMediaTypeFromExtension } from "./messaging/media-utils";
export { getLogger } from "./platform/logger-context";
export {
  sendBySession,
  sendMessage,
  sendProactiveMedia,
  uploadMedia,
} from "./messaging/send-service";
