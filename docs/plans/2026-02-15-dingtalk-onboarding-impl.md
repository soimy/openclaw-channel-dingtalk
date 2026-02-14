# DingTalk Onboarding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement interactive onboarding wizard for DingTalk channel plugin

**Architecture:** Create `src/onboarding.ts` with `ChannelOnboardingAdapter` implementation, add helper functions to `types.ts`, and register adapter in `channel.ts`. Follow tlon extension pattern exactly.

**Tech Stack:** TypeScript, OpenClaw Plugin SDK (ChannelOnboardingAdapter, WizardPrompter)

---

## Task 1: Add Helper Functions to types.ts

**Files:**

- Modify: `src/types.ts` (append to end of file)

**Step 1: Add DEFAULT_ACCOUNT_ID import**

Add at the beginning of the imports section (after line 11 where OpenClawConfig is imported):

```typescript
import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk';
```

**Step 2: Add listDingTalkAccountIds function**

Append to end of file (after line 645):

```typescript
/**
 * List all DingTalk account IDs from config
 */
export function listDingTalkAccountIds(cfg: OpenClawConfig): string[] {
  const dingtalk = cfg.channels?.dingtalk as DingTalkChannelConfig | undefined;
  if (!dingtalk) return [];

  const accountIds: string[] = [];

  // Check for direct configuration (default account)
  if (dingtalk.clientId || dingtalk.clientSecret) {
    accountIds.push(DEFAULT_ACCOUNT_ID);
  }

  // Check accounts object
  if (dingtalk.accounts) {
    accountIds.push(...Object.keys(dingtalk.accounts));
  }

  return accountIds;
}

/**
 * Resolve a specific DingTalk account configuration
 */
export function resolveDingTalkAccount(
  cfg: OpenClawConfig,
  accountId?: string | null
): DingTalkConfig & { configured: boolean } {
  const id = accountId || DEFAULT_ACCOUNT_ID;
  const dingtalk = cfg.channels?.dingtalk as DingTalkChannelConfig | undefined;

  // For default account, return top-level config
  if (id === DEFAULT_ACCOUNT_ID) {
    const config: DingTalkConfig = {
      clientId: dingtalk?.clientId ?? '',
      clientSecret: dingtalk?.clientSecret ?? '',
      robotCode: dingtalk?.robotCode,
      corpId: dingtalk?.corpId,
      agentId: dingtalk?.agentId,
      dmPolicy: dingtalk?.dmPolicy,
      groupPolicy: dingtalk?.groupPolicy,
      allowFrom: dingtalk?.allowFrom,
      showThinking: dingtalk?.showThinking,
      debug: dingtalk?.debug,
      messageType: dingtalk?.messageType,
      cardTemplateId: dingtalk?.cardTemplateId,
      cardTemplateKey: dingtalk?.cardTemplateKey,
      groups: dingtalk?.groups,
      maxConnectionAttempts: dingtalk?.maxConnectionAttempts,
      initialReconnectDelay: dingtalk?.initialReconnectDelay,
      maxReconnectDelay: dingtalk?.maxReconnectDelay,
      reconnectJitter: dingtalk?.reconnectJitter,
    };
    return {
      ...config,
      configured: Boolean(config.clientId && config.clientSecret),
    };
  }

  // For named account, get from accounts object
  const accountConfig = dingtalk?.accounts?.[id];
  if (accountConfig) {
    return {
      ...accountConfig,
      configured: Boolean(accountConfig.clientId && accountConfig.clientSecret),
    };
  }

  // Account doesn't exist, return empty config
  return {
    clientId: '',
    clientSecret: '',
    configured: false,
  };
}
```

**Step 3: Run type check**

Run: `npm run type-check`
Expected: Exit code 0, no errors

**Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: add listDingTalkAccountIds and resolveDingTalkAccount helpers"
```

---

## Task 2: Create onboarding.ts

**Files:**

- Create: `src/onboarding.ts`

**Step 1: Create onboarding.ts with full implementation**

```typescript
/**
 * DingTalk Channel Onboarding Adapter
 *
 * Provides interactive configuration wizard for DingTalk channel setup.
 * Follows the same pattern as tlon extension.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import {
  formatDocsLink,
  promptAccountId,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  applyAccountNameToChannelSection,
  type ChannelOnboardingAdapter,
  type WizardPrompter,
} from 'openclaw/plugin-sdk';
import type { DingTalkConfig } from './types.js';
import { listDingTalkAccountIds, resolveDingTalkAccount } from './types.js';

const channel = 'dingtalk' as const;

/**
 * Check if account has required configuration
 */
function isConfigured(account: DingTalkConfig): boolean {
  return Boolean(account.clientId && account.clientSecret);
}

/**
 * Apply account configuration to OpenClawConfig
 */
function applyAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: Partial<DingTalkConfig>;
}): OpenClawConfig {
  const { cfg, accountId, input } = params;
  const useDefault = accountId === DEFAULT_ACCOUNT_ID;

  // Apply account name first
  const namedConfig = applyAccountNameToChannelSection({
    cfg,
    channelKey: 'dingtalk',
    accountId,
    name: input.name,
  });

  const base = namedConfig.channels?.dingtalk ?? {};

  // Build payload with only provided values
  const payload: Record<string, unknown> = {};

  if (input.clientId) payload.clientId = input.clientId;
  if (input.clientSecret) payload.clientSecret = input.clientSecret;
  if (input.robotCode) payload.robotCode = input.robotCode;
  if (input.corpId) payload.corpId = input.corpId;
  if (input.agentId) payload.agentId = input.agentId;
  if (input.dmPolicy) payload.dmPolicy = input.dmPolicy;
  if (input.groupPolicy) payload.groupPolicy = input.groupPolicy;
  if (input.allowFrom && input.allowFrom.length > 0) payload.allowFrom = input.allowFrom;
  if (input.messageType) payload.messageType = input.messageType;
  if (input.cardTemplateId) payload.cardTemplateId = input.cardTemplateId;
  if (input.cardTemplateKey) payload.cardTemplateKey = input.cardTemplateKey;

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

  return {
    ...namedConfig,
    channels: {
      ...namedConfig.channels,
      dingtalk: {
        ...base,
        enabled: base.enabled ?? true,
        accounts: {
          ...(base as { accounts?: Record<string, unknown> }).accounts,
          [accountId]: {
            ...(base as { accounts?: Record<string, Record<string, unknown>> }).accounts?.[accountId],
            enabled: true,
            ...payload,
          },
        },
      },
    },
  };
}

/**
 * Show DingTalk setup help to user
 */
async function noteDingTalkHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      'You need DingTalk application credentials to proceed.',
      '',
      '1. Visit https://open-dev.dingtalk.com/',
      '2. Create an enterprise internal application',
      "3. Enable 'Robot' capability",
      "4. Configure message receiving mode as 'Stream mode'",
      '5. Copy Client ID (AppKey) and Client Secret (AppSecret)',
      '',
      `Docs: ${formatDocsLink('/channels/dingtalk', 'channels/dingtalk')}`,
    ].join('\n'),
    'DingTalk Setup'
  );
}

/**
 * Parse comma/newline/semicolon separated list
 */
function parseList(value: string): string[] {
  return value
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * DingTalk onboarding adapter
 */
export const dingtalkOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const accountIds = listDingTalkAccountIds(cfg);
    const configured =
      accountIds.length > 0
        ? accountIds.some((accountId) => isConfigured(resolveDingTalkAccount(cfg, accountId)))
        : isConfigured(resolveDingTalkAccount(cfg, DEFAULT_ACCOUNT_ID));

    return {
      channel,
      configured,
      statusLines: [`DingTalk: ${configured ? 'configured' : 'needs setup'}`],
      selectionHint: configured ? 'configured' : '钉钉企业机器人',
      quickstartScore: configured ? 1 : 4,
    };
  },

  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides[channel]?.trim();
    const defaultAccountId = DEFAULT_ACCOUNT_ID;
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;

    // Prompt for account ID if needed
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: 'DingTalk',
        currentId: accountId,
        listAccountIds: listDingTalkAccountIds,
        defaultAccountId,
      });
    }

    const resolved = resolveDingTalkAccount(cfg, accountId);

    // Show help
    await noteDingTalkHelp(prompter);

    // === Required fields ===
    const clientId = await prompter.text({
      message: 'Client ID (AppKey)',
      placeholder: 'dingxxxxxxxx',
      initialValue: resolved.clientId ?? undefined,
      validate: (value) => (String(value ?? '').trim() ? undefined : 'Required'),
    });

    const clientSecret = await prompter.text({
      message: 'Client Secret (AppSecret)',
      placeholder: 'xxx-xxx-xxx-xxx',
      initialValue: resolved.clientSecret ?? undefined,
      validate: (value) => (String(value ?? '').trim() ? undefined : 'Required'),
    });

    // === Optional: Full credentials ===
    const wantsFullConfig = await prompter.confirm({
      message: 'Configure robot code, corp ID, and agent ID? (recommended for full features)',
      initialValue: false,
    });

    let robotCode: string | undefined;
    let corpId: string | undefined;
    let agentId: string | undefined;

    if (wantsFullConfig) {
      robotCode =
        String(
          await prompter.text({
            message: 'Robot Code',
            placeholder: 'dingxxxxxxxx',
            initialValue: resolved.robotCode ?? undefined,
          })
        ).trim() || undefined;

      corpId =
        String(
          await prompter.text({
            message: 'Corp ID',
            placeholder: 'dingxxxxxxxx',
            initialValue: resolved.corpId ?? undefined,
          })
        ).trim() || undefined;

      agentId =
        String(
          await prompter.text({
            message: 'Agent ID',
            placeholder: '123456789',
            initialValue: resolved.agentId ? String(resolved.agentId) : undefined,
          })
        ).trim() || undefined;
    }

    // === Optional: AI Card mode ===
    const wantsCardMode = await prompter.confirm({
      message: 'Enable AI interactive card mode? (for streaming AI responses)',
      initialValue: resolved.messageType === 'card',
    });

    let cardTemplateId: string | undefined;
    let cardTemplateKey: string | undefined;

    if (wantsCardMode) {
      await prompter.note(
        [
          'To use AI cards, create a card template:',
          '',
          '1. Visit https://open-dev.dingtalk.com/fe/card',
          "2. Click 'Create Template'",
          "3. Select 'AI Card' scenario",
          '4. Design and publish the template',
          '5. Copy the template ID',
        ].join('\n'),
        'Card Template Setup'
      );

      cardTemplateId =
        String(
          await prompter.text({
            message: 'Card Template ID',
            placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.schema',
            initialValue: resolved.cardTemplateId ?? undefined,
          })
        ).trim() || undefined;

      cardTemplateKey =
        String(
          await prompter.text({
            message: 'Card Template Content Key',
            placeholder: 'msgContent',
            initialValue: resolved.cardTemplateKey ?? 'msgContent',
          })
        ).trim() || 'msgContent';
    }

    // === DM Policy ===
    const dmPolicy = (await prompter.select({
      message: 'Direct message policy',
      options: [
        { label: 'Open - anyone can DM', value: 'open' },
        { label: 'Allowlist - only approved users', value: 'allowlist' },
      ],
      initialValue: resolved.dmPolicy ?? 'open',
    })) as 'open' | 'allowlist';

    let allowFrom: string[] | undefined;
    if (dmPolicy === 'allowlist') {
      const entry = await prompter.text({
        message: 'Allowed user IDs (comma-separated)',
        placeholder: 'user1, user2, user3',
      });
      const parsed = parseList(String(entry ?? ''));
      allowFrom = parsed.length > 0 ? parsed : undefined;
    }

    // === Group Policy ===
    const groupPolicy = (await prompter.select({
      message: 'Group message policy',
      options: [
        { label: 'Open - any group can mention bot', value: 'open' },
        { label: 'Allowlist - only approved groups', value: 'allowlist' },
      ],
      initialValue: resolved.groupPolicy ?? 'open',
    })) as 'open' | 'allowlist';

    // Build input object
    const input: Partial<DingTalkConfig> = {
      clientId: String(clientId).trim(),
      clientSecret: String(clientSecret).trim(),
      robotCode,
      corpId,
      agentId,
      dmPolicy,
      groupPolicy,
      allowFrom,
      messageType: wantsCardMode ? 'card' : 'markdown',
      cardTemplateId,
      cardTemplateKey,
    };

    // Apply configuration
    const next = applyAccountConfig({
      cfg,
      accountId,
      input,
    });

    return { cfg: next, accountId };
  },
};
```

**Step 2: Run type check**

Run: `npm run type-check`
Expected: Exit code 0, no errors

**Step 3: Run lint**

Run: `npm run lint`
Expected: Exit code 0, no errors (or run `npm run lint:fix` to auto-fix)

**Step 4: Commit**

```bash
git add src/onboarding.ts
git commit -m "feat: add DingTalk onboarding adapter"
```

---

## Task 3: Register Onboarding in channel.ts

**Files:**

- Modify: `src/channel.ts`

**Step 1: Add import at top of file**

Find line 1-20 where imports are, add after existing imports:

```typescript
import { dingtalkOnboardingAdapter } from './onboarding.js';
```

**Step 2: Add onboarding property to dingtalkPlugin**

Find the `dingtalkPlugin` definition (around line 1352), add `onboarding` property after `capabilities`:

```typescript
export const dingtalkPlugin: DingTalkChannelPlugin = {
  id: 'dingtalk',
  meta: { ... },
  capabilities: { ... },

  // Add this line:
  onboarding: dingtalkOnboardingAdapter,

  config: { ... },
  // ... rest unchanged
```

**Step 3: Run type check**

Run: `npm run type-check`
Expected: Exit code 0, no errors

**Step 4: Commit**

```bash
git add src/channel.ts
git commit -m "feat: register onboarding adapter in DingTalk plugin"
```

---

## Task 4: Final Verification

**Step 1: Run full type check**

Run: `npm run type-check`
Expected: Exit code 0

**Step 2: Run lint**

Run: `npm run lint`
Expected: Exit code 0

**Step 3: Verify exports**

Run: `grep -n "dingtalkOnboardingAdapter" src/onboarding.ts src/channel.ts`
Expected:

- `src/onboarding.ts`: export const dingtalkOnboardingAdapter
- `src/channel.ts`: import { dingtalkOnboardingAdapter } from './onboarding.js'

**Step 4: Final commit (if any fixes)**

```bash
git add -A
git commit -m "feat: complete DingTalk onboarding implementation"
```

---

## Summary

| Task | Files Changed       | Description                                       |
| ---- | ------------------- | ------------------------------------------------- |
| 1    | `src/types.ts`      | Add helper functions for account resolution       |
| 2    | `src/onboarding.ts` | Create onboarding adapter with interactive wizard |
| 3    | `src/channel.ts`    | Register onboarding adapter in plugin definition  |
| 4    | -                   | Final verification                                |
