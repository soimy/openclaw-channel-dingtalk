# DingTalk Onboarding Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify DingTalk onboarding into a short basic flow plus optional card-focused advanced flow, and make multi-account setup explicit.

**Architecture:** Keep runtime config semantics unchanged. Refactor `src/onboarding.ts` by adding small helper functions around the existing `configureDingTalkAccount` path, then update `tests/unit/onboarding.test.ts` to lock the new prompt order and config writes.

**Tech Stack:** TypeScript, OpenClaw plugin setup wizard APIs, Vitest.

---

## File Map

- Modify: `src/onboarding.ts`
  - Replace the long post-credential prompt chain with basic prompts for `dmPolicy`, `groupPolicy`, and `messageType`.
  - Add allowlist instructional notes instead of prompting for `allowFrom` / `groupAllowFrom`.
  - Add optional advanced card prompts gated by `messageType=card`.
  - Improve account selection for default / existing named / new named accounts.
- Modify: `tests/unit/onboarding.test.ts`
  - Update existing tests for the shorter prompt sequence.
  - Add regressions for allowlist notes, card advanced prompts, and named account writes.
- Read-only reference: `docs/spec/2026-04-28-dingtalk-onboarding-simplification-design.md`

## Task 1: Improve Account Target Selection

**Files:**
- Modify: `src/onboarding.ts`
- Test: `tests/unit/onboarding.test.ts`

- [ ] **Step 1: Add failing tests for explicit account target choices**

Add tests near the existing account selection test:

```ts
it("allows adding a named account during setup", async () => {
    const select = vi.fn().mockResolvedValueOnce("new");
    const text = vi.fn().mockResolvedValueOnce("work");
    const confirm = vi.fn();

    const accountId = await dingtalkSetupWizard.resolveAccountIdForConfigure?.({
        cfg: {
            channels: {
                dingtalk: {
                    clientId: "default-id",
                    clientSecret: "default-secret",
                    accounts: {
                        test: { clientId: "test-id", clientSecret: "test-secret" },
                    },
                },
            },
        } as any,
        prompter: { confirm, select, text } as unknown as WizardPrompter,
        shouldPromptAccountIds: true,
        listAccountIds: () => ["default", "test"],
        defaultAccountId: "default",
    });

    expect(accountId).toBe("work");
    expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
            message: expect.stringContaining("DingTalk account"),
        }),
    );
});
```

Add another test for choosing an existing named account:

```ts
it("allows modifying an existing named account during setup", async () => {
    const select = vi.fn().mockResolvedValueOnce("existing").mockResolvedValueOnce("test");
    const text = vi.fn();

    const accountId = await dingtalkSetupWizard.resolveAccountIdForConfigure?.({
        cfg: {
            channels: {
                dingtalk: {
                    accounts: {
                        test: { clientId: "test-id", clientSecret: "test-secret" },
                    },
                },
            },
        } as any,
        prompter: { select, text } as unknown as WizardPrompter,
        shouldPromptAccountIds: true,
        listAccountIds: () => ["test"],
        defaultAccountId: "default",
    });

    expect(accountId).toBe("test");
    expect(text).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm vitest run tests/unit/onboarding.test.ts
```

Expected: new account-selection tests fail because the current prompt still uses the old confirm/select flow.

- [ ] **Step 3: Implement account target selection helper**

In `src/onboarding.ts`, replace `promptDingTalkAccountId` with a three-path selection.

Implementation shape:

```ts
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

  const choices = [
    { label: hasDefault ? "Configure default account" : "Add default account", value: "default" },
    ...(namedIds.length > 0
      ? [{ label: "Modify existing named account", value: "existing" }]
      : []),
    { label: "Add named account", value: "new" },
  ];

  const action = await options.prompter.select({
    message: `Choose ${options.label} account`,
    options: choices,
    initialValue: hasDefault ? "default" : namedIds.length > 0 ? "existing" : "default",
  });

  if (action === "default") {
    return options.defaultAccountId;
  }

  if (action === "existing") {
    const selected = await options.prompter.select({
      message: `Select existing ${options.label} account`,
      options: namedIds.map((accountId) => ({ label: accountId, value: accountId })),
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
      await options.prompter.note("Enter a non-default account ID, for example: work", "DingTalk account");
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
```

- [ ] **Step 4: Run account selection tests**

Run:

```bash
pnpm vitest run tests/unit/onboarding.test.ts
```

Expected: account selection tests pass or only later prompt-order tests fail.

## Task 2: Reduce Basic Onboarding Prompts

**Files:**
- Modify: `src/onboarding.ts`
- Test: `tests/unit/onboarding.test.ts`

- [ ] **Step 1: Replace old long-flow tests with basic-flow expectations**

Replace `configure writes card + allowlist settings` with a basic-flow test:

```ts
it("configure writes credentials and basic policies without allowlist prompts", async () => {
    const note = vi.fn();
    const text = vi
        .fn()
        .mockResolvedValueOnce("ding_client")
        .mockResolvedValueOnce("ding_secret");

    const confirm = vi.fn().mockResolvedValueOnce(false);

    const select = vi
        .fn()
        .mockResolvedValueOnce("manual")
        .mockResolvedValueOnce("allowlist")
        .mockResolvedValueOnce("allowlist")
        .mockResolvedValueOnce("markdown");

    const result = await runSetupWizardConfigure({
        cfg: {} as any,
        prompter: { note, text, confirm, select } as unknown as WizardPrompter,
    });

    const dingtalkConfig = result.cfg.channels?.dingtalk;
    expect(dingtalkConfig?.clientId).toBe("ding_client");
    expect(dingtalkConfig?.clientSecret).toBe("ding_secret");
    expect(dingtalkConfig?.dmPolicy).toBe("allowlist");
    expect(dingtalkConfig?.groupPolicy).toBe("allowlist");
    expect(dingtalkConfig?.messageType).toBe("markdown");
    expect(dingtalkConfig?.allowFrom).toBeUndefined();
    expect(dingtalkConfig?.groupAllowFrom).toBeUndefined();
    expect(dingtalkConfig?.displayNameResolution).toBeUndefined();
    expect(dingtalkConfig?.mediaMaxMb).toBeUndefined();
    expect(dingtalkConfig?.journalTTLDays).toBeUndefined();
    expect(text).toHaveBeenCalledTimes(2);
    expect(note).toHaveBeenCalledWith(expect.stringContaining("userId"), expect.any(String));
    expect(note).toHaveBeenCalledWith(expect.stringContaining("conversationId"), expect.any(String));
});
```

Update auto-register/manual/fallback tests so their prompt mocks match the new basic order:

```ts
const text = vi.fn(); // auto success no text prompts
const confirm = vi.fn().mockResolvedValueOnce(false); // advanced options
const select = vi
    .fn()
    .mockResolvedValueOnce("auto")
    .mockResolvedValueOnce("open")
    .mockResolvedValueOnce("open")
    .mockResolvedValueOnce("markdown");
```

Manual fallback should still provide only `clientId` and `clientSecret` text values before basic policy selects.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm vitest run tests/unit/onboarding.test.ts
```

Expected: tests fail because current code still asks allowlist/media/displayName/reconnect/TTL prompts.

- [ ] **Step 3: Add allowlist guidance note helpers**

In `src/onboarding.ts`, add:

```ts
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
```

- [ ] **Step 4: Replace post-credential prompt chain**

In `configureDingTalkAccount`, after credential acquisition:

```ts
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
```

Remove prompts for:

- `allowFrom`
- `groupAllowFrom`
- `mediaUrlAllowlist`
- `displayNameResolution`
- `contextVisibility` note
- `maxReconnectCycles`
- `mediaMaxMb`
- `journalTTLDays`

- [ ] **Step 5: Update apply payload types**

Update the final `applyAccountConfig` call to include:

```ts
dmPolicy: dmPolicyValue,
groupPolicy: groupPolicyValue,
messageType,
```

Do not pass `allowFrom`, `groupAllowFrom`, `displayNameResolution`, `mediaMaxMb`, or `journalTTLDays` unless they were explicitly collected in another helper.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm vitest run tests/unit/onboarding.test.ts
```

Expected: basic-flow tests pass; card advanced tests may still be pending.

## Task 3: Add Optional Card Advanced Flow

**Files:**
- Modify: `src/onboarding.ts`
- Test: `tests/unit/onboarding.test.ts`

- [ ] **Step 1: Add tests for advanced=false and advanced card=true**

Add test for no advanced writes:

```ts
it("skips card advanced settings by default", async () => {
    const note = vi.fn();
    const text = vi
        .fn()
        .mockResolvedValueOnce("ding-id")
        .mockResolvedValueOnce("ding-secret");
    const confirm = vi.fn().mockResolvedValueOnce(false);
    const select = vi
        .fn()
        .mockResolvedValueOnce("manual")
        .mockResolvedValueOnce("open")
        .mockResolvedValueOnce("open")
        .mockResolvedValueOnce("card");

    const result = await runSetupWizardConfigure({
        cfg: {} as any,
        prompter: { note, text, confirm, select } as unknown as WizardPrompter,
    });

    const dingtalkConfig = result.cfg.channels?.dingtalk;
    expect(dingtalkConfig?.messageType).toBe("card");
    expect(dingtalkConfig?.cardStreamingMode).toBeUndefined();
    expect(dingtalkConfig?.cardStreamInterval).toBeUndefined();
    expect(dingtalkConfig?.cardAtSender).toBeUndefined();
    expect(dingtalkConfig?.cardStatusLine).toBeUndefined();
});
```

Add test for card advanced writes:

```ts
it("writes card advanced settings when card mode advanced setup is enabled", async () => {
    const note = vi.fn();
    const text = vi
        .fn()
        .mockResolvedValueOnce("ding-id")
        .mockResolvedValueOnce("ding-secret")
        .mockResolvedValueOnce("750")
        .mockResolvedValueOnce("回复完成");
    const confirm = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);
    const select = vi
        .fn()
        .mockResolvedValueOnce("manual")
        .mockResolvedValueOnce("open")
        .mockResolvedValueOnce("open")
        .mockResolvedValueOnce("card")
        .mockResolvedValueOnce("answer");

    const result = await runSetupWizardConfigure({
        cfg: {} as any,
        prompter: { note, text, confirm, select } as unknown as WizardPrompter,
    });

    const dingtalkConfig = result.cfg.channels?.dingtalk as any;
    expect(dingtalkConfig.cardStreamingMode).toBe("answer");
    expect(dingtalkConfig.cardStreamInterval).toBe(750);
    expect(dingtalkConfig.cardAtSender).toBe("回复完成");
    expect(dingtalkConfig.cardStatusLine).toEqual({
        model: true,
        effort: false,
        agent: true,
        taskTime: false,
        tokens: false,
        dapiUsage: false,
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm vitest run tests/unit/onboarding.test.ts
```

Expected: advanced card tests fail because helpers are not implemented yet.

- [ ] **Step 3: Add validation helper for card stream interval**

In `src/onboarding.ts`, add:

```ts
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
```

Existing `validatePositiveInteger` can be replaced with this helper if no longer used elsewhere.

- [ ] **Step 4: Add card advanced prompt helper**

In `src/onboarding.ts`, add:

```ts
async function promptCardAdvancedConfig(params: {
  resolved: DingTalkConfig;
  prompter: WizardPrompter;
}): Promise<Pick<DingTalkConfig, "cardStreamingMode" | "cardStreamInterval" | "cardAtSender" | "cardStatusLine">> {
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
      placeholder: "回复完成",
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
      model: await prompter.confirm({ message: "Show model name?", initialValue: current.model ?? true }),
      effort: await prompter.confirm({ message: "Show thinking effort?", initialValue: current.effort ?? true }),
      agent: await prompter.confirm({ message: "Show agent name?", initialValue: current.agent ?? true }),
      taskTime: await prompter.confirm({ message: "Show task elapsed time?", initialValue: current.taskTime ?? false }),
      tokens: await prompter.confirm({ message: "Show token usage?", initialValue: current.tokens ?? false }),
      dapiUsage: await prompter.confirm({ message: "Show DingTalk API usage?", initialValue: current.dapiUsage ?? false }),
    };
  }

  return {
    cardStreamingMode,
    cardStreamInterval,
    ...(cardAtSenderRaw ? { cardAtSender: cardAtSenderRaw } : {}),
    ...(cardStatusLine ? { cardStatusLine } : {}),
  };
}
```

- [ ] **Step 5: Gate advanced prompts in main flow**

After `messageType` selection:

```ts
let cardAdvanced: Pick<DingTalkConfig, "cardStreamingMode" | "cardStreamInterval" | "cardAtSender" | "cardStatusLine"> = {};
const wantsAdvanced = await prompter.confirm({
  message: "Configure advanced DingTalk options?",
  initialValue: false,
});
if (wantsAdvanced && messageType === "card") {
  cardAdvanced = await promptCardAdvancedConfig({ resolved, prompter });
} else if (wantsAdvanced) {
  await prompter.note(
    "No markdown-specific advanced onboarding options are required. Other advanced settings can be edited in the config UI or openclaw.json.",
    "DingTalk advanced options",
  );
}
```

Include `...cardAdvanced` in the final `input`.

- [ ] **Step 6: Update `applyAccountConfig` payload**

Add these optional fields to `payload`:

```ts
...(input.cardStreamInterval ? { cardStreamInterval: input.cardStreamInterval } : {}),
...(input.cardAtSender ? { cardAtSender: input.cardAtSender } : {}),
...(input.cardStatusLine ? { cardStatusLine: input.cardStatusLine } : {}),
```

Use `typeof input.cardStreamInterval === "number"` if `0` is possible; validation makes it `>=200`.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm vitest run tests/unit/onboarding.test.ts
```

Expected: all onboarding tests pass.

## Task 4: Named Account Config Writes and Final Notes

**Files:**
- Modify: `src/onboarding.ts`
- Test: `tests/unit/onboarding.test.ts`

- [ ] **Step 1: Add named account finalize test**

Add:

```ts
it("writes a newly configured named account without overwriting default account", async () => {
    const note = vi.fn();
    const text = vi
        .fn()
        .mockResolvedValueOnce("ding-work-id")
        .mockResolvedValueOnce("ding-work-secret");
    const confirm = vi.fn().mockResolvedValueOnce(false);
    const select = vi
        .fn()
        .mockResolvedValueOnce("manual")
        .mockResolvedValueOnce("open")
        .mockResolvedValueOnce("disabled")
        .mockResolvedValueOnce("markdown");

    const finalized = await dingtalkSetupWizard.finalize?.({
        cfg: {
            channels: {
                dingtalk: {
                    clientId: "default-id",
                    clientSecret: "default-secret",
                },
            },
        } as any,
        accountId: "work",
        prompter: { note, text, confirm, select } as unknown as WizardPrompter,
    });

    const dingtalk = finalized?.cfg.channels?.dingtalk as any;
    expect(dingtalk.clientId).toBe("default-id");
    expect(dingtalk.clientSecret).toBe("default-secret");
    expect(dingtalk.accounts.work.clientId).toBe("ding-work-id");
    expect(dingtalk.accounts.work.clientSecret).toBe("ding-work-secret");
    expect(dingtalk.accounts.work.groupPolicy).toBe("disabled");
});
```

- [ ] **Step 2: Add finish note test**

Assert final guidance mentions multi-account and restart:

```ts
expect(note).toHaveBeenCalledWith(
    expect.stringContaining("channels.dingtalk.accounts"),
    "DingTalk setup complete",
);
expect(note).toHaveBeenCalledWith(
    expect.stringContaining("openclaw gateway restart"),
    "DingTalk setup complete",
);
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
pnpm vitest run tests/unit/onboarding.test.ts
```

Expected: final note test fails until completion note is implemented.

- [ ] **Step 4: Add completion note helper**

In `src/onboarding.ts`, add:

```ts
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
```

Call it before returning from `configureDingTalkAccount`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run tests/unit/onboarding.test.ts
```

Expected: all onboarding tests pass.

## Task 5: Full Verification

**Files:**
- No code changes unless verification exposes a bug.

- [ ] **Step 1: Run onboarding tests**

Run:

```bash
pnpm vitest run tests/unit/onboarding.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run config and manifest tests**

Run:

```bash
pnpm vitest run tests/unit/config-schema.test.ts tests/unit/plugin-manifest.test.ts tests/unit/types.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full unit/integration suite**

Run:

```bash
pnpm vitest run
```

Expected: PASS.

- [ ] **Step 4: Run type-check**

Run:

```bash
pnpm run type-check
```

Expected: PASS in CI-like SDK type environment. If it fails locally with `TS7016` for `/Users/sym/Repo/openclaw/dist/plugin-sdk/*`, record as existing local SDK declaration issue.

- [ ] **Step 5: Run format check**

Run:

```bash
pnpm run format:check
```

Expected: PASS after formatting. If existing branch has format drift, run `pnpm run format` only if this branch is intended to include formatting changes.

- [ ] **Step 6: Manual smoke test**

Run:

```bash
openclaw configure --section channels
```

Expected:

- Existing configured account defaults to manual / keep credentials path.
- Fresh account defaults to auto-register.
- Basic questions stop after `dmPolicy`, `groupPolicy`, `messageType`, and one advanced toggle.
- Selecting allowlist policies shows guidance notes but does not prompt for IDs.
- New named account writes under `channels.dingtalk.accounts.<accountId>`.
