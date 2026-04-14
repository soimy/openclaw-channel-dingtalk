# DingTalk Context Visibility And Sub-Agent Session Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the DingTalk plugin with upstream OpenClaw `contextVisibility` and canonical sub-agent session-key semantics without overstating support or leaving runtime behavior half-wired.

**Architecture:** Treat this as two related but distinct tracks. First, finish the configuration-contract work for `contextVisibility`, then add the missing DingTalk runtime filtering needed to make the setting real for quote-chain context. In parallel, remove the plugin-local sub-agent session-key fallback and fully rely on the host routing helper so session storage, locking, card tracking, and future host features all share the same canonical key shape.

**Tech Stack:** TypeScript, Zod v4, OpenClaw plugin SDK/runtime helpers, JSON manifest metadata, Vitest

---

## Scope Summary

- In scope:
  - DingTalk top-level/account-level `contextVisibility` config support
  - DingTalk quote-context filtering behavior for `all`, `allowlist`, and `allowlist_quote`
  - Persisting enough sender metadata to evaluate quoted-message visibility correctly
  - Removing plugin-local sub-agent session-key synthesis
  - Clear operator-facing warning on old hosts missing `buildAgentSessionKey`
  - Unit and focused integration coverage for the above
- Out of scope:
  - Migrating legacy sub-agent sessions created with the old fallback key shape
  - Reworking all supplemental context types beyond DingTalk quote / quoted-chain context in this pass
  - TaskFlow adoption or other upstream alignment items unrelated to these two features

## File Map

- Modify: `src/config-schema.ts`
  - Add `contextVisibility` to the DingTalk runtime schema.
- Modify: `src/types.ts`
  - Add public TypeScript support for `contextVisibility`.
  - Ensure resolved account snapshots include it.
- Modify: `openclaw.plugin.json`
  - Publish `contextVisibility` in top-level and account-level manifest schema.
  - Add `uiHints` help copy that matches the real runtime behavior.
- Modify: `src/onboarding.ts`
  - Surface a minimal operator note for `contextVisibility`.
- Modify: `src/inbound-handler.ts`
  - Persist inbound sender metadata into `messages.context`.
  - Apply `contextVisibility` before emitting `ReplyToBody` / `ReplyToSender` / `UntrustedContext`.
  - Stop using plugin-local sub-agent session-key fallback behavior.
- Modify: `src/messaging/quoted-context.ts`
  - Preserve enough quoted-message sender metadata for visibility decisions.
  - Support trimming deeper quoted-chain context when the selected visibility mode blocks it.
- Optional create: `src/messaging/context-visibility.ts`
  - Centralize DingTalk-specific context-visibility resolution and filtering helpers.
- Modify: `src/targeting/agent-routing.ts`
  - Remove the local `resolveAgentRoute(...):subagent:` fallback.
  - Fail fast with a clear helper-missing error on unsupported hosts.
- Modify: `tests/unit/config-schema.test.ts`
  - Cover `contextVisibility` acceptance.
- Modify: `tests/unit/plugin-manifest.test.ts`
  - Cover manifest publication of `contextVisibility`.
- Modify: `tests/unit/types.test.ts`
  - Cover resolved account snapshots carrying `contextVisibility`.
- Modify: `tests/unit/onboarding.test.ts`
  - Cover the new `contextVisibility` onboarding note.
- Modify: `tests/unit/inbound-handler.test.ts`
  - Add quote-visibility behavior tests.
  - Add helper-missing sub-agent warning coverage if not already present.
- Modify: `tests/unit/targeting/dm-subagent-routing.test.ts`
  - Cover canonical helper usage and parameter forwarding (`dmScope`, `identityLinks`).
- Optional modify: `docs/user/reference/configuration.md`
  - Clarify what DingTalk currently filters under `contextVisibility`.
- Optional modify: `docs/releases/*.md`
  - Note that old plugin-local sub-agent session keys are not migrated.

## Constraints And References

- Repo policy requires AI-authored plans under `docs/plans/`, not custom plan roots.
- The current DingTalk plugin already emits quote-related runtime fields:
  - `ReplyToBody`
  - `ReplyToSender`
  - `ReplyToIsQuote`
  - `UntrustedContext`
- The current DingTalk plugin does **not** yet read or apply `contextVisibility` anywhere in `src/`.
- `MessageRecord` already supports `senderId` / `senderName`, but the main inbound upsert path does not populate them.
- Upstream host references:
  - `~/Repo/openclaw/src/config/context-visibility.ts`
  - `~/Repo/openclaw/src/security/context-visibility.ts`
  - `~/Repo/openclaw/src/routing/resolve-route.ts`
  - `~/Repo/openclaw/src/routing/session-key.ts`
  - `~/Repo/openclaw/src/plugins/runtime/types-channel.ts`
  - `~/Repo/openclaw/extensions/discord/src/monitor/message-handler.process.ts`
  - `~/Repo/openclaw/extensions/feishu/src/bot.ts`
  - `~/Repo/openclaw/extensions/signal/src/monitor/event-handler.ts`

## Behavior Targets

- `contextVisibility: "all"`
  - Keep current DingTalk quote behavior.
- `contextVisibility: "allowlist"`
  - Only keep quote context when the quoted sender passes the effective DingTalk allowlist logic for the active conversation mode.
- `contextVisibility: "allowlist_quote"`
  - Keep the first explicit quoted/replied message in group contexts even if the quoted sender is not allowlisted.
  - Do not keep deeper quoted-chain context unless it separately passes visibility checks.
- Missing host `runtime.channel.routing.buildAgentSessionKey`
  - Do not synthesize a plugin-local fallback key.
  - Show a clear user-facing DingTalk warning and log the failure.

### Task 1: Lock The Current Gaps In Tests

**Files:**
- Modify: `tests/unit/config-schema.test.ts`
- Modify: `tests/unit/plugin-manifest.test.ts`
- Modify: `tests/unit/types.test.ts`
- Modify: `tests/unit/onboarding.test.ts`
- Modify: `tests/unit/inbound-handler.test.ts`
- Modify: `tests/unit/targeting/dm-subagent-routing.test.ts`

- [ ] **Step 1: Add a failing runtime-schema regression for `contextVisibility`**

Add assertions that `DingTalkConfigSchema` accepts:

```ts
{
  clientId: "id",
  clientSecret: "secret",
  contextVisibility: "allowlist_quote",
  accounts: {
    main: {
      clientId: "id",
      clientSecret: "secret",
      contextVisibility: "allowlist",
    },
  },
}
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run: `pnpm vitest run tests/unit/config-schema.test.ts`
Expected: FAIL because the runtime schema currently does not model `contextVisibility`.

- [ ] **Step 3: Add a failing manifest regression**

Assert both top-level and account-level DingTalk manifest schema publish:

```ts
expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.contextVisibility).toBeDefined();
expect(
  manifest.channelConfigs?.dingtalk?.schema?.properties?.accounts?.additionalProperties?.properties
    ?.contextVisibility,
).toBeDefined();
```

- [ ] **Step 4: Run the manifest test to verify it fails**

Run: `pnpm vitest run tests/unit/plugin-manifest.test.ts`
Expected: FAIL because `openclaw.plugin.json` currently omits `contextVisibility`.

- [ ] **Step 5: Add a failing resolved-account regression**

In `tests/unit/types.test.ts`, assert:

```ts
expect(resolveDingTalkAccount(cfg, "default").contextVisibility).toBe("allowlist_quote");
expect(resolveDingTalkAccount(cfg, "main").contextVisibility).toBe("allowlist");
```

- [ ] **Step 6: Run the types test to verify it fails**

Run: `pnpm vitest run tests/unit/types.test.ts`
Expected: FAIL because `resolveDingTalkAccount()` currently drops `contextVisibility`.

- [ ] **Step 7: Add a failing onboarding regression**

Assert the DingTalk setup flow emits a note mentioning:

```text
channels.dingtalk.contextVisibility
allowlist_quote
```

- [ ] **Step 8: Run the onboarding test to verify it fails**

Run: `pnpm vitest run tests/unit/onboarding.test.ts`
Expected: FAIL because setup currently has no `contextVisibility` note.

- [ ] **Step 9: Add failing quote-visibility regressions**

In `tests/unit/inbound-handler.test.ts`, add group-chat cases proving:

- `all` keeps `ReplyToBody`
- `allowlist` drops blocked quoted context
- `allowlist_quote` keeps one explicit quote but drops deeper quoted-chain `UntrustedContext`

Use an arrangement where the current sender is allowed to speak, but the quoted sender is not.

- [ ] **Step 10: Run the focused inbound-handler tests to verify they fail**

Run: `pnpm vitest run tests/unit/inbound-handler.test.ts`
Expected: FAIL because DingTalk currently always forwards quote context.

- [ ] **Step 11: Add failing canonical sub-agent helper regressions**

In `tests/unit/targeting/dm-subagent-routing.test.ts`, assert `buildAgentSessionKey()`:

- forwards `agentId`, `channel`, `accountId`, `peer`, `dmScope`, and `identityLinks`
- throws when the host helper is missing

- [ ] **Step 12: Run the sub-agent routing test to verify it fails**

Run: `pnpm vitest run tests/unit/targeting/dm-subagent-routing.test.ts`
Expected: FAIL because current code still allows plugin-local fallback behavior.

- [ ] **Step 13: Commit the red-state baseline**

```bash
git add tests/unit/config-schema.test.ts tests/unit/plugin-manifest.test.ts tests/unit/types.test.ts tests/unit/onboarding.test.ts tests/unit/inbound-handler.test.ts tests/unit/targeting/dm-subagent-routing.test.ts
git commit -m "test(alignment): capture dingtalk visibility and subagent gaps"
```

### Task 2: Align `contextVisibility` Config Surfaces

**Files:**
- Modify: `src/config-schema.ts`
- Modify: `src/types.ts`
- Modify: `src/onboarding.ts`
- Modify: `openclaw.plugin.json`
- Test: `tests/unit/config-schema.test.ts`
- Test: `tests/unit/plugin-manifest.test.ts`
- Test: `tests/unit/types.test.ts`
- Test: `tests/unit/onboarding.test.ts`

- [ ] **Step 1: Add the runtime schema enum**

In `src/config-schema.ts`, add:

```ts
const ContextVisibilitySchema = z.enum(["all", "allowlist", "allowlist_quote"]);
```

Then wire:

```ts
contextVisibility: ContextVisibilitySchema.optional(),
```

into the shared DingTalk account config shape.

- [ ] **Step 2: Run the schema test**

Run: `pnpm vitest run tests/unit/config-schema.test.ts`
Expected: PASS for the new `contextVisibility` cases.

- [ ] **Step 3: Add public TypeScript support**

In `src/types.ts`:

- add `ContextVisibilityMode = "all" | "allowlist" | "allowlist_quote"`
- add `contextVisibility?: ContextVisibilityMode` to `DingTalkConfig`
- add `contextVisibility?: ContextVisibilityMode` to `DingTalkChannelConfig`

- [ ] **Step 4: Include `contextVisibility` in resolved account snapshots**

Update `resolveDingTalkAccount()` so both top-level and account-scoped resolved configs expose the field.

- [ ] **Step 5: Run the types test**

Run: `pnpm vitest run tests/unit/types.test.ts`
Expected: PASS for the resolved-account assertions.

- [ ] **Step 6: Publish `contextVisibility` in the manifest schema**

In `openclaw.plugin.json`, add:

```json
"contextVisibility": {
  "type": "string",
  "enum": ["all", "allowlist", "allowlist_quote"]
}
```

to both:

- `channelConfigs.dingtalk.schema.properties`
- `channelConfigs.dingtalk.schema.properties.accounts.additionalProperties.properties`

- [ ] **Step 7: Add manifest `uiHints` help text**

Use help copy that does not over-promise:

```text
Host-level quote/supplemental context filtering.
allowlist_quote keeps one explicit quote while filtering extra context.
```

- [ ] **Step 8: Run the manifest test**

Run: `pnpm vitest run tests/unit/plugin-manifest.test.ts`
Expected: PASS for `contextVisibility` schema and UI-hint assertions.

- [ ] **Step 9: Add a minimal onboarding note**

In `src/onboarding.ts`:

- persist `contextVisibility` if present in `applyAccountConfig()`
- add a short `prompter.note(...)` after `displayNameResolution`
- do not add a new interactive select in this pass

The note must mention:

- the config path
- the three modes
- `allowlist_quote` as the recommended advanced setting

- [ ] **Step 10: Run the onboarding test**

Run: `pnpm vitest run tests/unit/onboarding.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit the config-surface alignment**

```bash
git add src/config-schema.ts src/types.ts src/onboarding.ts openclaw.plugin.json tests/unit/config-schema.test.ts tests/unit/plugin-manifest.test.ts tests/unit/types.test.ts tests/unit/onboarding.test.ts
git commit -m "feat(config): expose dingtalk context visibility"
```

### Task 3: Persist Sender Metadata Needed For Visibility Decisions

**Files:**
- Modify: `src/inbound-handler.ts`
- Modify: `src/message-context-store.ts`
- Test: `tests/unit/inbound-handler.test.ts`

- [ ] **Step 1: Audit the main inbound upsert paths**

Review every `upsertInboundMessageContext(...)` call in `src/inbound-handler.ts` and mark which ones represent user-authored inbound content versus derived attachment/doc cache entries.

- [ ] **Step 2: Update the main inbound message upsert**

At the primary inbound record write in `src/inbound-handler.ts`, pass:

```ts
senderId,
senderName,
chatType: isDirect ? "direct" : "group",
```

so the stored record can later participate in sender-based visibility checks.

- [ ] **Step 3: Update any quoted-doc/media cache upserts that can safely carry sender metadata**

Only add sender fields where the cached record still semantically represents the original inbound sender. Do not fabricate sender data for synthetic attachment extraction records that no longer have a reliable source.

- [ ] **Step 4: Add a regression assertion**

In `tests/unit/inbound-handler.test.ts`, verify the main inbound message context upsert is called with `senderId` and `senderName`.

- [ ] **Step 5: Run the focused inbound-handler test**

Run: `pnpm vitest run tests/unit/inbound-handler.test.ts`
Expected: PASS for sender-metadata persistence.

- [ ] **Step 6: Commit the sender-metadata foundation**

```bash
git add src/inbound-handler.ts tests/unit/inbound-handler.test.ts
git commit -m "feat(context): persist dingtalk sender metadata for quote visibility"
```

### Task 4: Implement DingTalk Quote Visibility Filtering

**Files:**
- Optional create: `src/messaging/context-visibility.ts`
- Modify: `src/messaging/quoted-context.ts`
- Modify: `src/inbound-handler.ts`
- Modify: `src/access-control.ts`
- Test: `tests/unit/inbound-handler.test.ts`

- [ ] **Step 1: Add a focused DingTalk visibility helper**

Prefer a new helper file if the logic would otherwise sprawl inside `src/inbound-handler.ts`.

The helper should:

- resolve the effective `contextVisibility` mode from the already-resolved DingTalk account config
- answer whether a quoted sender is allowlisted for the current direct/group context
- answer whether deeper quoted-chain context should be kept

- [ ] **Step 2: Reuse existing allowlist normalization**

Do not duplicate allowlist parsing. Reuse:

- `normalizeAllowFrom()`
- `isSenderAllowed()`
- group-specific allowlist precedence already encoded in `resolveGroupAccess()` or a new small helper extracted beside it

If `resolveGroupAccess()` is too coarse for quoted-sender checks, extract a shared helper rather than copy/pasting its precedence logic.

- [ ] **Step 3: Extend quoted runtime context to expose sender IDs when available**

In `src/messaging/quoted-context.ts`, preserve quoted-record sender identity in the chain entries so filtering can distinguish:

- visible top-level quote
- deeper quoted-chain entries

Minimal acceptable shape:

```ts
senderId?: string;
senderName?: string;
```

- [ ] **Step 4: Filter the first explicit quote**

Before calling `finalizeInboundContext(...)`, compute whether the top-level quoted message should remain visible:

- `all` -> keep
- `allowlist` -> keep only if quoted sender allowed
- `allowlist_quote` -> keep even if quoted sender blocked, but only for the first explicit quote

- [ ] **Step 5: Filter deeper quoted-chain context**

When `resolveQuotedRuntimeContext()` returns `chain.length > 1`, trim or clear the deeper chain before serializing it into `UntrustedContext` unless those deeper entries are allowed under the active mode.

For this pass, a safe default is:

- `all` -> keep deeper chain
- `allowlist` -> keep only entries whose sender is allowed
- `allowlist_quote` -> drop deeper blocked entries even if the first quote is kept

- [ ] **Step 6: Preserve user-facing behavior for allowed quotes**

Make sure allowed quote context still fills:

- `ReplyToBody`
- `ReplyToSender`
- `ReplyToIsQuote`

and that blocked quotes clear these fields rather than leaving stale partial data.

- [ ] **Step 7: Run focused visibility tests**

Run:

```bash
pnpm vitest run tests/unit/inbound-handler.test.ts
```

Expected:

- `all` test passes
- `allowlist` blocked-quote test passes
- `allowlist_quote` explicit-quote test passes

- [ ] **Step 8: Commit the runtime filtering**

```bash
git add src/access-control.ts src/messaging/quoted-context.ts src/inbound-handler.ts tests/unit/inbound-handler.test.ts
git commit -m "feat(context): enforce dingtalk quote visibility modes"
```

### Task 5: Remove Plugin-Local Sub-Agent Session-Key Fallback

**Files:**
- Modify: `src/targeting/agent-routing.ts`
- Modify: `src/inbound-handler.ts`
- Test: `tests/unit/targeting/dm-subagent-routing.test.ts`
- Test: `tests/unit/inbound-handler.test.ts`

- [ ] **Step 1: Replace fallback behavior with a hard requirement**

In `src/targeting/agent-routing.ts`, remove the local fallback that currently does:

```ts
const fallbackRoute = rt.channel.routing.resolveAgentRoute(...);
return `${fallbackRoute.sessionKey}:subagent:${agentId}`;
```

Replace it with:

```ts
throw new Error(
  "DingTalk sub-agent routing requires runtime.channel.routing.buildAgentSessionKey from the host runtime.",
);
```

when the helper is absent.

- [ ] **Step 2: Keep canonical helper argument forwarding exact**

The helper call must continue forwarding:

- `agentId`
- `channel: "dingtalk"`
- `accountId`
- `peer`
- `dmScope`
- `identityLinks`

- [ ] **Step 3: Surface a user-facing warning in the dispatch path**

In `dispatchSubAgents(...)`, when the failure message mentions `buildAgentSessionKey`, send a DingTalk warning reply telling the operator to upgrade OpenClaw instead of silently proceeding.

- [ ] **Step 4: Keep logging explicit**

The log line must still include the real error so maintainers can correlate host-version mismatch with the failed route.

- [ ] **Step 5: Run focused sub-agent tests**

Run:

```bash
pnpm vitest run tests/unit/targeting/dm-subagent-routing.test.ts tests/unit/inbound-handler.test.ts
```

Expected:

- helper-forwarding assertions pass
- helper-missing warning assertions pass
- no tests expect plugin-local fallback keys anymore

- [ ] **Step 6: Commit the routing alignment**

```bash
git add src/targeting/agent-routing.ts src/inbound-handler.ts tests/unit/targeting/dm-subagent-routing.test.ts tests/unit/inbound-handler.test.ts
git commit -m "fix(routing): require host subagent session helper"
```

### Task 6: Document The Real Behavior And Verify End-To-End

**Files:**
- Optional modify: `docs/user/reference/configuration.md`
- Optional modify: `docs/contributor/architecture.en.md`
- Optional modify: `docs/contributor/architecture.zh-CN.md`
- Optional modify: `docs/releases/*.md`

- [ ] **Step 1: Update user docs for `contextVisibility`**

Document DingTalk-specific reality:

- the field exists at top-level and account-level
- this pass filters quote and quoted-chain context
- `allowlist_quote` keeps one explicit quote but filters extra chain context

- [ ] **Step 2: Update contributor docs for sub-agent session keys**

Note that DingTalk sub-agent routing must use host-owned `buildAgentSessionKey` and should not reintroduce plugin-local fallback key synthesis.

- [ ] **Step 3: Add a release-note migration note**

State plainly that legacy fallback-generated sub-agent sessions are not migrated to canonical host-built keys.

- [ ] **Step 4: Run the targeted verification suite**

Run:

```bash
pnpm vitest run tests/unit/config-schema.test.ts tests/unit/plugin-manifest.test.ts tests/unit/types.test.ts tests/unit/onboarding.test.ts tests/unit/inbound-handler.test.ts tests/unit/targeting/dm-subagent-routing.test.ts
```

Expected: PASS

- [ ] **Step 5: Run broad project verification**

Run:

```bash
pnpm test
npm run type-check
npm run lint
```

Expected:

- all tests pass
- type check passes
- lint passes

- [ ] **Step 6: Commit docs and final verification state**

```bash
git add docs/user/reference/configuration.md docs/contributor/architecture.en.md docs/contributor/architecture.zh-CN.md docs/releases
git commit -m "docs(alignment): document dingtalk visibility and routing semantics"
```

## Exit Criteria

- DingTalk accepts and publishes `contextVisibility` in all relevant config surfaces.
- `resolveDingTalkAccount()` preserves `contextVisibility`.
- DingTalk persists inbound sender metadata needed for quote visibility checks.
- Group quote context respects `all`, `allowlist`, and `allowlist_quote`.
- Deeper quoted-chain context is no longer blindly preserved in blocked modes.
- DingTalk sub-agent routing no longer synthesizes plugin-local fallback keys.
- Unsupported hosts receive a clear upgrade warning instead of silent session-key drift.
- Focused tests and full verification commands pass.
