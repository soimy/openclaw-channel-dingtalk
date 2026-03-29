import type {
  ChannelSetupAdapter,
  ChannelSetupInput,
  ChannelSetupWizard,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { DEFAULT_ACCOUNT_ID, formatDocsLink, normalizeAccountId } from "openclaw/plugin-sdk/setup";
import { DEFAULT_MESSAGE_CONTEXT_TTL_DAYS } from "./message-context-store.js";
import type { DingTalkConfig, DingTalkChannelConfig } from "./types.js";
import { listDingTalkAccountIds, resolveDingTalkAccount } from "./types.js";

const channel = "dingtalk" as const;

function isConfigured(account: DingTalkConfig): boolean {
  return Boolean(account.clientId && account.clientSecret);
}

function parseList(value: string): string[] {
  return value
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function applyAccountNameToChannelSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name?: string;
}): OpenClawConfig {
  const { cfg, channelKey, name } = params;
  if (!name) {
    return cfg;
  }
  const base = cfg.channels?.[channelKey] as DingTalkChannelConfig | undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channelKey]: { ...base, name },
    },
  };
}

async function promptDingTalkAccountId(options: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  label: string;
  currentId: string;
  listAccountIds: (cfg: OpenClawConfig) => string[];
  defaultAccountId: string;
}): Promise<string> {
  const existingIds = options.listAccountIds(options.cfg);
  if (existingIds.length === 0) {
    return options.defaultAccountId;
  }
  const useExisting = await options.prompter.confirm({
    message: `Use existing ${options.label} account?`,
    initialValue: true,
  });
  if (useExisting) {
    if (existingIds.includes(options.currentId)) {
      return options.currentId;
    }
    const selected = await options.prompter.select({
      message: `Select existing ${options.label} account`,
      options: existingIds.map((accountId) => ({
        label: accountId,
        value: accountId,
      })),
      initialValue: existingIds[0],
    });
    return normalizeAccountId(String(selected));
  }
  const newId = await options.prompter.text({
    message: `New ${options.label} account ID`,
    placeholder: options.defaultAccountId,
    initialValue: options.defaultAccountId,
  });
  return normalizeAccountId(String(newId));
}

async function noteDingTalkHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "You need DingTalk application credentials.",
      "1. Visit https://open-dev.dingtalk.com/",
      "2. Create an enterprise internal application",
      "3. Enable 'Robot' capability",
      "4. Configure message receiving mode as 'Stream mode'",
      "5. Copy Client ID (AppKey) and Client Secret (AppSecret)",
      `Docs: ${formatDocsLink("https://github.com/soimy/openclaw-channel-dingtalk", "plugin docs")}`,
    ].join("\n"),
    "DingTalk setup",
  );
}

function applyAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: Partial<DingTalkConfig>;
}): OpenClawConfig {
  const { cfg, accountId, input } = params;
  const useDefault = accountId === DEFAULT_ACCOUNT_ID;

  const namedConfig = applyAccountNameToChannelSection({
    cfg,
    channelKey: "dingtalk",
    accountId,
    name: input.name,
  });
  const base = namedConfig.channels?.dingtalk as DingTalkChannelConfig | undefined;

  const payload: Partial<DingTalkConfig> = {
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
    ...(input.dmPolicy ? { dmPolicy: input.dmPolicy } : {}),
    ...(input.groupPolicy ? { groupPolicy: input.groupPolicy } : {}),
    ...(input.allowFrom && input.allowFrom.length > 0 ? { allowFrom: input.allowFrom } : {}),
    ...(input.groupAllowFrom && input.groupAllowFrom.length > 0
      ? { groupAllowFrom: input.groupAllowFrom }
      : {}),
    ...(input.displayNameResolution ? { displayNameResolution: input.displayNameResolution } : {}),
    ...(input.mediaUrlAllowlist && input.mediaUrlAllowlist.length > 0
      ? { mediaUrlAllowlist: input.mediaUrlAllowlist }
      : {}),
    ...(input.messageType ? { messageType: input.messageType } : {}),
    ...(input.cardTemplateId ? { cardTemplateId: input.cardTemplateId } : {}),
    ...(input.cardTemplateKey ? { cardTemplateKey: input.cardTemplateKey } : {}),
    ...(typeof input.maxReconnectCycles === "number"
      ? { maxReconnectCycles: input.maxReconnectCycles }
      : {}),
    ...(typeof input.useConnectionManager === "boolean"
      ? { useConnectionManager: input.useConnectionManager }
      : {}),
    ...(typeof input.mediaMaxMb === "number" ? { mediaMaxMb: input.mediaMaxMb } : {}),
    ...(typeof input.journalTTLDays === "number" ? { journalTTLDays: input.journalTTLDays } : {}),
  };

  if (useDefault) {
    return {
      ...namedConfig,
      channels: {
        ...namedConfig.channels,
        dingtalk: {
          ...base,
          enabled: true,
          ...payload,
        },
      },
    };
  }

  const accounts = (base as { accounts?: Record<string, unknown> }).accounts ?? {};
  const existingAccount =
    (base as { accounts?: Record<string, Record<string, unknown>> }).accounts?.[accountId] ?? {};

  return {
    ...namedConfig,
    channels: {
      ...namedConfig.channels,
      dingtalk: {
        ...base,
        enabled: base?.enabled ?? true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...existingAccount,
            enabled: true,
            ...payload,
          },
        },
      },
    },
  };
}

function applyGenericSetupInput(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: ChannelSetupInput;
}): OpenClawConfig {
  return applyAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    input: {
      name: params.input.name,
      clientId: typeof params.input.token === "string" ? params.input.token.trim() : undefined,
      clientSecret:
        typeof params.input.password === "string" ? params.input.password.trim() : undefined,
    },
  });
}

function validatePositiveInteger(value: string): string | undefined {
  const raw = String(value ?? "").trim();
  const num = Number(raw);
  if (!raw) {
    return "Required";
  }
  if (!Number.isInteger(num) || num < 1) {
    return "Must be an integer >= 1";
  }
  return undefined;
}

async function configureDingTalkAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const { cfg, accountId, prompter } = params;
  const resolved = resolveDingTalkAccount(cfg, accountId);

  await noteDingTalkHelp(prompter);

  const clientId = await prompter.text({
    message: "Client ID (AppKey)",
    placeholder: "dingxxxxxxxx",
    initialValue: resolved.clientId ?? undefined,
    validate: (value: string) => (String(value ?? "").trim() ? undefined : "Required"),
  });

  const clientSecret = await prompter.text({
    message: "Client Secret (AppSecret)",
    placeholder: "xxx-xxx-xxx-xxx",
    initialValue: resolved.clientSecret ?? undefined,
    validate: (value: string) => (String(value ?? "").trim() ? undefined : "Required"),
  });

  const wantsCardMode = await prompter.confirm({
    message: "Enable AI interactive card mode? (for streaming AI responses)",
    initialValue: resolved.messageType === "card",
  });

  let cardTemplateId: string | undefined;
  let cardTemplateKey: string | undefined;
  let messageType: "markdown" | "card" = "markdown";

  if (wantsCardMode) {
    await prompter.note(
      [
        "Create an AI card template in DingTalk Developer Console:",
        "https://open-dev.dingtalk.com/fe/card",
        "1. Go to 'My Templates' > 'Create Template'",
        "2. Select 'AI Card' scenario",
        "3. Design your card and publish",
        "4. Copy the Template ID (e.g., xxx.schema)",
      ].join("\n"),
      "Card Template Setup",
    );

    cardTemplateId =
      String(
        await prompter.text({
          message: "Card Template ID",
          placeholder: "xxxxx-xxxxx-xxxxx.schema",
          initialValue: resolved.cardTemplateId ?? undefined,
        }),
      ).trim() || undefined;

    cardTemplateKey =
      String(
        await prompter.text({
          message: "Card Template Key (content field name)",
          placeholder: "content",
          initialValue: resolved.cardTemplateKey ?? "content",
        }),
      ).trim() || "content";

    messageType = "card";
  }

  const dmPolicyValue = await prompter.select({
    message: "Direct message policy",
    options: [
      { label: "Open - anyone can DM", value: "open" },
      { label: "Allowlist - only allowed users", value: "allowlist" },
    ],
    initialValue: resolved.dmPolicy ?? "open",
  });

  let allowFrom: string[] | undefined;
  if (dmPolicyValue === "allowlist") {
    const entry = await prompter.text({
      message: "Allowed user IDs (comma-separated)",
      placeholder: "user1, user2",
    });
    const parsed = parseList(String(entry ?? ""));
    allowFrom = parsed.length > 0 ? parsed : undefined;
  }

  const mediaUrlAllowlistEntry = await prompter.text({
    message: "Media URL allowlist (comma-separated host/IP/CIDR, optional)",
    placeholder: "cdn.example.com, 192.168.1.23, 10.0.0.0/8",
    initialValue: (resolved.mediaUrlAllowlist || []).join(", ") || undefined,
  });
  const mediaUrlAllowlistParsed = parseList(String(mediaUrlAllowlistEntry ?? ""));
  const mediaUrlAllowlist = mediaUrlAllowlistParsed.length > 0 ? mediaUrlAllowlistParsed : undefined;

  const groupPolicyValue = await prompter.select({
    message: "Group message policy",
    options: [
      { label: "Open - any group can use bot", value: "open" },
      { label: "Allowlist - only allowed groups", value: "allowlist" },
      { label: "Disabled - block all group messages", value: "disabled" },
    ],
    initialValue: resolved.groupPolicy ?? "open",
  });

  if (groupPolicyValue === "allowlist") {
    await prompter.note(
      [
        'groupPolicy=allowlist requires "groups" config to specify allowed group IDs.',
        "After setup, manually add group conversationIds to your config:",
        "",
        '  "groups": { "cidXXX": {}, "cidYYY": { "systemPrompt": "..." } }',
        "",
        'Groups not listed will be blocked. Use "*" as key to allow all groups.',
      ].join("\n"),
    );
  }

  let groupAllowFrom: string[] | undefined;
  if (groupPolicyValue !== "disabled") {
    const groupAllowFromEntry = await prompter.text({
      message: "Group sender allowlist - user IDs allowed in groups (comma-separated, optional)",
      placeholder: "user1, user2",
      initialValue: (resolved.groupAllowFrom || []).join(", ") || undefined,
    });
    const parsedGroupAllowFrom = parseList(String(groupAllowFromEntry ?? ""));
    groupAllowFrom = parsedGroupAllowFrom.length > 0 ? parsedGroupAllowFrom : undefined;
  }

  await prompter.note(
    [
      "Enabling learned displayName target resolution has tradeoffs:",
      "- learned names come from observed inbound messages and can become stale",
      "- duplicate display names can resolve to the wrong group or user",
      '- current upstream target resolution does not provide requester authz, so "all" applies to every caller that can reach the send flow',
      "Use explicit IDs for sensitive or high-risk deliveries.",
    ].join("\n"),
    "displayName resolution risk",
  );

  const displayNameResolutionValue = await prompter.select({
    message: "Learned displayName target resolution",
    options: [
      {
        label: "Disabled - require explicit IDs",
        value: "disabled",
      },
      {
        label: "All - learned lookup for all callers (higher risk)",
        value: "all",
      },
    ],
    initialValue: resolved.displayNameResolution ?? "disabled",
  });

  let maxReconnectCycles: number | undefined;
  const wantsReconnectLimits = await prompter.confirm({
    message: "Configure runtime reconnect cycle limit? (recommended)",
    initialValue: typeof resolved.maxReconnectCycles === "number",
  });
  if (wantsReconnectLimits) {
    const parsedCycles = Number(
      String(
        await prompter.text({
          message: "Max runtime reconnect cycles",
          placeholder: "10",
          initialValue: String(resolved.maxReconnectCycles ?? 10),
          validate: (value: string) => validatePositiveInteger(value),
        }),
      ).trim(),
    );
    maxReconnectCycles = Number.isInteger(parsedCycles) && parsedCycles > 0 ? parsedCycles : 10;
  }

  let mediaMaxMb: number | undefined;
  const wantsMediaMax = await prompter.confirm({
    message: "Configure inbound media max size in MB? (optional)",
    initialValue: typeof resolved.mediaMaxMb === "number",
  });
  if (wantsMediaMax) {
    const parsedMediaMax = Number(
      String(
        await prompter.text({
          message: "Max inbound media size (MB)",
          placeholder: "20",
          initialValue:
            typeof resolved.mediaMaxMb === "number" ? String(resolved.mediaMaxMb) : "20",
          validate: (value: string) => validatePositiveInteger(value),
        }),
      ).trim(),
    );
    mediaMaxMb = Number.isInteger(parsedMediaMax) && parsedMediaMax > 0 ? parsedMediaMax : 20;
  }

  let journalTTLDays: number | undefined;
  const wantsJournalTTL = await prompter.confirm({
    message: "Configure quote journal retention in days?",
    initialValue: typeof resolved.journalTTLDays === "number",
  });
  if (wantsJournalTTL) {
    const parsedJournalTTL = Number(
      String(
        await prompter.text({
          message: "Quote journal retention days",
          placeholder: String(DEFAULT_MESSAGE_CONTEXT_TTL_DAYS),
          initialValue:
            typeof resolved.journalTTLDays === "number"
              ? String(resolved.journalTTLDays)
              : String(DEFAULT_MESSAGE_CONTEXT_TTL_DAYS),
          validate: (value: string) => validatePositiveInteger(value),
        }),
      ).trim(),
    );
    journalTTLDays =
      Number.isInteger(parsedJournalTTL) && parsedJournalTTL > 0
        ? parsedJournalTTL
        : DEFAULT_MESSAGE_CONTEXT_TTL_DAYS;
  }

  return applyAccountConfig({
    cfg,
    accountId,
    input: {
      clientId: String(clientId).trim(),
      clientSecret: String(clientSecret).trim(),
      dmPolicy: dmPolicyValue as "open" | "allowlist",
      groupPolicy: groupPolicyValue as "open" | "allowlist" | "disabled",
      allowFrom,
      groupAllowFrom,
      displayNameResolution: displayNameResolutionValue as "disabled" | "all",
      mediaUrlAllowlist,
      messageType,
      cardTemplateId,
      cardTemplateKey,
      maxReconnectCycles,
      mediaMaxMb,
      journalTTLDays,
    },
  });
}

export const dingtalkSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({ cfg, channelKey: channel, accountId, name }),
  applyAccountConfig: ({ cfg, accountId, input }) =>
    applyGenericSetupInput({
      cfg,
      accountId,
      input,
    }),
};

export const dingtalkSetupWizard: ChannelSetupWizard = {
  channel,
  credentials: [],
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs setup",
    resolveConfigured: ({ cfg }) => {
      const accountIds = listDingTalkAccountIds(cfg);
      return accountIds.length > 0
        ? accountIds.some((accountId) => isConfigured(resolveDingTalkAccount(cfg, accountId)))
        : isConfigured(resolveDingTalkAccount(cfg, DEFAULT_ACCOUNT_ID));
    },
    resolveStatusLines: ({ configured }) => [
      `DingTalk: ${configured ? "configured" : "needs setup"}`,
    ],
    resolveSelectionHint: ({ configured }) =>
      configured ? "configured" : "钉钉企业机器人",
    resolveQuickstartScore: ({ configured }) => (configured ? 1 : 4),
  },
  resolveAccountIdForConfigure: async ({
    cfg,
    prompter,
    accountOverride,
    shouldPromptAccountIds,
    listAccountIds,
    defaultAccountId,
  }) => {
    const resolvedAccountId = accountOverride
      ? normalizeAccountId(accountOverride)
      : defaultAccountId;
    if (!shouldPromptAccountIds || accountOverride) {
      return resolvedAccountId;
    }
    return await promptDingTalkAccountId({
      cfg,
      prompter,
      label: "DingTalk",
      currentId: resolvedAccountId,
      listAccountIds,
      defaultAccountId,
    });
  },
  finalize: async ({ cfg, accountId, prompter }) => ({
    cfg: await configureDingTalkAccount({
      cfg,
      accountId,
      prompter,
    }),
  }),
};
