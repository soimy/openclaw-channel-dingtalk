import type {
  ChannelSetupAdapter,
  ChannelSetupInput,
  ChannelSetupWizard,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { DEFAULT_ACCOUNT_ID, formatDocsLink, normalizeAccountId } from "openclaw/plugin-sdk/setup";
import { listDingTalkAccountIds, resolveDingTalkAccount } from "./config.js";
import {
  beginDeviceRegistration,
  openUrlInBrowser,
  RegistrationError,
} from "./device-registration.js";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
  parseSecretInputString,
} from "./secret-input.js";
import type { DingTalkConfig, DingTalkChannelConfig } from "./types.js";

const channel = "dingtalk" as const;

function isConfigured(account: DingTalkConfig): boolean {
  return Boolean(account.clientId && hasConfiguredSecretInput(account.clientSecret));
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
  const hasDefault = existingIds.includes(options.defaultAccountId);
  const namedIds = existingIds.filter((id) => id !== options.defaultAccountId);
  const action = await options.prompter.select({
    message: `Choose ${options.label} account`,
    options: [
      {
        label: hasDefault ? "Configure default account" : "Add default account",
        value: "default",
      },
      ...(namedIds.length > 0
        ? [{ label: "Modify existing named account", value: "existing" }]
        : []),
      { label: "Add named account", value: "new" },
    ],
    initialValue: hasDefault ? "default" : namedIds.length > 0 ? "existing" : "default",
  });

  if (action === "default") {
    return options.defaultAccountId;
  }

  if (action === "existing") {
    const selected = await options.prompter.select({
      message: `Select existing ${options.label} account`,
      options: namedIds.map((accountId) => ({
        label: accountId,
        value: accountId,
      })),
      initialValue: namedIds[0],
    });
    return normalizeAccountId(String(selected));
  }

  while (true) {
    const raw = await options.prompter.text({
      message: `New ${options.label} account ID`,
      placeholder: "work",
      initialValue: "",
    });
    const normalized = normalizeAccountId(String(raw));
    if (!normalized || normalized === options.defaultAccountId) {
      await options.prompter.note(
        "Enter a non-default account ID, for example: work",
        "DingTalk account",
      );
      continue;
    }
    if (existingIds.includes(normalized)) {
      await options.prompter.note(
        `Account "${normalized}" already exists. Choose Modify existing named account to edit it.`,
        "DingTalk account",
      );
      continue;
    }
    return normalized;
  }
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

async function noteDmAllowlistGuidance(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "DM allowlist requires DingTalk userId values.",
      "Ask each target user to send a direct message to this bot.",
      "The plugin will show the observed userId so an admin can add it to channels.dingtalk.allowFrom.",
    ].join("\n"),
    "DingTalk DM allowlist",
  );
}

async function noteGroupAllowlistGuidance(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Group allowlist requires DingTalk conversationId values.",
      "Ask a member to @mention this bot in the target group.",
      "The plugin will show the observed group ID so an admin can configure channels.dingtalk.groups or related allowlist settings.",
    ].join("\n"),
    "DingTalk group allowlist",
  );
}

async function noteDingTalkSetupComplete(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "DingTalk configuration has been saved.",
      "For named accounts, configuration lives under channels.dingtalk.accounts.",
      "If you selected allowlist policies, ask the target user or group to message this bot first; the plugin will show IDs that an admin can add manually.",
      "Advanced runtime settings can be edited in the config UI or openclaw.json.",
      "Restart the gateway to apply changes:",
      "  openclaw gateway restart",
    ].join("\n"),
    "DingTalk setup complete",
  );
}

function validateMinInteger(min: number) {
  return (value: string): string | undefined => {
    const raw = String(value ?? "").trim();
    const num = Number(raw);
    if (!raw) {
      return "Required";
    }
    if (!Number.isInteger(num) || num < min) {
      return `Must be an integer >= ${min}`;
    }
    return undefined;
  };
}

type CardAdvancedConfig = Partial<
  Pick<
    DingTalkConfig,
    "cardStreamingMode" | "cardStreamInterval" | "cardAtSender" | "cardStatusLine"
  >
>;

async function promptCardAdvancedConfig(params: {
  resolved: DingTalkConfig;
  prompter: WizardPrompter;
}): Promise<CardAdvancedConfig> {
  const { resolved, prompter } = params;
  const cardStreamingMode = (await prompter.select({
    message: "Card streaming mode",
    options: [
      { label: "Off - answer does not stream incrementally", value: "off" },
      { label: "Answer - only answer streams incrementally", value: "answer" },
      { label: "All - answer and thinking stream incrementally", value: "all" },
    ],
    initialValue: resolved.cardStreamingMode ?? (resolved.cardRealTimeStream ? "all" : "off"),
  })) as DingTalkConfig["cardStreamingMode"];

  const cardStreamInterval = Number(
    String(
      await prompter.text({
        message: "Card stream interval (ms)",
        placeholder: "1000",
        initialValue: String(resolved.cardStreamInterval ?? 1000),
        validate: validateMinInteger(200),
      }),
    ).trim(),
  );

  const cardAtSenderRaw = String(
    await prompter.text({
      message: "Card completion @mention text (optional)",
      placeholder: "Reply complete",
      initialValue: resolved.cardAtSender || undefined,
    }),
  ).trim();

  const wantsStatusLine = await prompter.confirm({
    message: "Customize AI card status line?",
    initialValue: Boolean(resolved.cardStatusLine),
  });

  let cardStatusLine: DingTalkConfig["cardStatusLine"] | undefined;
  if (wantsStatusLine) {
    const current = resolved.cardStatusLine ?? {};
    cardStatusLine = {
      model: await prompter.confirm({
        message: "Show model name?",
        initialValue: current.model ?? true,
      }),
      effort: await prompter.confirm({
        message: "Show thinking effort?",
        initialValue: current.effort ?? true,
      }),
      agent: await prompter.confirm({
        message: "Show agent name?",
        initialValue: current.agent ?? true,
      }),
      taskTime: await prompter.confirm({
        message: "Show task elapsed time?",
        initialValue: current.taskTime ?? false,
      }),
      tokens: await prompter.confirm({
        message: "Show token usage?",
        initialValue: current.tokens ?? false,
      }),
      dapiUsage: await prompter.confirm({
        message: "Show DingTalk API usage?",
        initialValue: current.dapiUsage ?? false,
      }),
    };
  }

  return {
    cardStreamingMode,
    cardStreamInterval,
    ...(cardAtSenderRaw ? { cardAtSender: cardAtSenderRaw } : {}),
    ...(cardStatusLine ? { cardStatusLine } : {}),
  };
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
    ...(input.contextVisibility ? { contextVisibility: input.contextVisibility } : {}),
    ...(input.mediaUrlAllowlist && input.mediaUrlAllowlist.length > 0
      ? { mediaUrlAllowlist: input.mediaUrlAllowlist }
      : {}),
    ...(input.messageType ? { messageType: input.messageType } : {}),
    ...(input.cardStreamingMode ? { cardStreamingMode: input.cardStreamingMode } : {}),
    ...(typeof input.cardStreamInterval === "number"
      ? { cardStreamInterval: input.cardStreamInterval }
      : {}),
    ...(input.cardAtSender ? { cardAtSender: input.cardAtSender } : {}),
    ...(input.cardStatusLine ? { cardStatusLine: input.cardStatusLine } : {}),
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
        typeof params.input.password === "string"
          ? parseSecretInputString(params.input.password)
          : undefined,
    },
  });
}

async function configureDingTalkAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const { cfg, accountId, prompter } = params;
  const resolved = resolveDingTalkAccount(cfg, accountId);

  // ── Credential acquisition: auto-register or manual ────────────────────
  const hasExistingCredentials = Boolean(
    resolved.clientId && hasConfiguredSecretInput(resolved.clientSecret),
  );
  const credentialMethod = await prompter.select({
    message: "How do you want to get DingTalk bot credentials?",
    options: [
      { label: "Auto-register an OpenClaw DingTalk bot", value: "auto" },
      { label: "Enter an existing DingTalk bot Client ID / Client Secret", value: "manual" },
    ],
    initialValue: hasExistingCredentials ? "manual" : "auto",
  });

  let clientId: string;
  let clientSecret: string;

  if (credentialMethod === "auto") {
    try {
      const session = await beginDeviceRegistration();

      openUrlInBrowser(session.verificationUrl);

      await prompter.note(
        [
          "Opened the authorization page in your browser.",
          "Scan the authorization code in DingTalk to finish registration.",
          "",
          "If the browser did not open automatically, visit this link manually:",
          session.verificationUrl,
        ].join("\n"),
        "DingTalk bot auto-registration",
      );

      let lastWaitingNote = 0;
      const result = await session.waitForResult({
        onWaiting: () => {
          const now = Date.now();
          if (now - lastWaitingNote >= 15_000) {
            lastWaitingNote = now;
            prompter
              .note("Waiting for authorization. Please finish the scan in DingTalk...", "Polling")
              .catch(() => {});
          }
        },
      });
      clientId = result.clientId;
      clientSecret = result.clientSecret;

      await prompter.note(
        [
          "Registration succeeded!",
          `Client ID: ${clientId}`,
          "Client Secret: [captured; see config file]",
        ].join("\n"),
        "Registration complete",
      );
    } catch (err) {
      const message = err instanceof RegistrationError ? err.message : String(err);
      await prompter.note(
        [`Auto-registration failed: ${message}`, "", "Falling back to manual input."].join("\n"),
        "Registration failed",
      );
      // Fall through to manual path
      await noteDingTalkHelp(prompter);
      clientId = String(
        await prompter.text({
          message: "Client ID (AppKey)",
          placeholder: "dingxxxxxxxx",
          initialValue: resolved.clientId ?? undefined,
          validate: (value: string) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();
      clientSecret = String(
        await prompter.text({
          message: "Client Secret (AppSecret)",
          placeholder: "xxx-xxx-xxx-xxx",
          initialValue: normalizeSecretInputString(resolved.clientSecret),
          validate: (value: string) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();
    }
  } else {
    // Manual path — existing behavior
    await noteDingTalkHelp(prompter);
    clientId = String(
      await prompter.text({
        message: "Client ID (AppKey)",
        placeholder: "dingxxxxxxxx",
        initialValue: resolved.clientId ?? undefined,
        validate: (value: string) => (String(value ?? "").trim() ? undefined : "Required"),
      }),
    ).trim();
    clientSecret = String(
      await prompter.text({
        message: "Client Secret (AppSecret)",
        placeholder: "xxx-xxx-xxx-xxx",
        initialValue: normalizeSecretInputString(resolved.clientSecret),
        validate: (value: string) => (String(value ?? "").trim() ? undefined : "Required"),
      }),
    ).trim();
  }

  const dmPolicyValue = (await prompter.select({
    message: "Direct message policy",
    options: [
      { label: "Open - anyone can DM", value: "open" },
      { label: "Pairing - require OpenClaw pairing approval", value: "pairing" },
      { label: "Allowlist - only manually allowed users", value: "allowlist" },
    ],
    initialValue: resolved.dmPolicy ?? "open",
  })) as "open" | "pairing" | "allowlist";

  if (dmPolicyValue === "allowlist") {
    await noteDmAllowlistGuidance(prompter);
  }

  const groupPolicyValue = (await prompter.select({
    message: "Group message policy",
    options: [
      { label: "Open - any group can use bot", value: "open" },
      { label: "Allowlist - only manually configured groups", value: "allowlist" },
      { label: "Disabled - block all group messages", value: "disabled" },
    ],
    initialValue: resolved.groupPolicy ?? "open",
  })) as "open" | "allowlist" | "disabled";

  if (groupPolicyValue === "allowlist") {
    await noteGroupAllowlistGuidance(prompter);
  }

  const messageType = (await prompter.select({
    message: "Reply message type",
    options: [
      { label: "Markdown - standard DingTalk messages", value: "markdown" },
      { label: "AI Card - interactive card replies", value: "card" },
    ],
    initialValue: resolved.messageType ?? "markdown",
  })) as "markdown" | "card";

  const wantsAdvanced = await prompter.confirm({
    message: "Configure advanced DingTalk options?",
    initialValue: false,
  });
  let cardAdvanced: CardAdvancedConfig = {};
  if (wantsAdvanced && messageType === "card") {
    cardAdvanced = await promptCardAdvancedConfig({ resolved, prompter });
  } else if (wantsAdvanced) {
    await prompter.note(
      "No markdown-specific advanced onboarding options are required. Other advanced settings can be edited in the config UI or openclaw.json.",
      "DingTalk advanced options",
    );
  }

  const nextCfg = applyAccountConfig({
    cfg,
    accountId,
    input: {
      clientId: String(clientId).trim(),
      clientSecret: parseSecretInputString(clientSecret),
      dmPolicy: dmPolicyValue,
      groupPolicy: groupPolicyValue,
      messageType,
      ...cardAdvanced,
    },
  });
  await noteDingTalkSetupComplete(prompter);
  return nextCfg;
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
      configured ? "configured" : "DingTalk enterprise bot",
    resolveQuickstartScore: ({ configured }) => (configured ? 1 : 4),
  },
  resolveShouldPromptAccountIds: () => true,
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
