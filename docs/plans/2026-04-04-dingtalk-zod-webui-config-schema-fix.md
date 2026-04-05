# DingTalk Channel Config Manifest Schema Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the DingTalk channel form in OpenClaw WebUI by shipping manifest-level `channelConfigs.dingtalk` schema + `uiHints`, so `频道 -> DingTalk` stops showing `Unsupported type: . Use Raw mode.`

**Architecture:** The host channels page reads external plugin channel config metadata from manifest `channelConfigs`, not from the plugin runtime `configSchema` alone. The fix therefore starts by adding `channelConfigs.dingtalk` and `uiHints` to `openclaw.plugin.json`, raising the minimum OpenClaw version to `>=2026.3.28`, and only then aligning runtime schema/parity code as needed.

**Tech Stack:** TypeScript, JSON Schema Draft-07, Zod v4, OpenClaw plugin manifest metadata, Vitest

---

## File Map

- Modify: `openclaw.plugin.json`
  - Add `channelConfigs.dingtalk` with `label`, `description`, `schema`, and `uiHints`.
  - Keep the top-level manifest `configSchema` valid, but stop expecting it to drive the channels page for DingTalk.
- Modify: `package.json`
  - Raise `peerDependencies.openclaw`, `openclaw.compat.pluginApi`, `openclaw.build.openclawVersion`, and `openclaw.install.minHostVersion` to `2026.3.28`.
- Modify: `src/config-schema.ts`
  - Keep runtime validation aligned with the manifest schema source of truth where practical.
  - Only make code changes here if tests prove the current runtime schema is missing fields required by the manifest or real host.
- Modify: `src/channel.ts`
  - Keep runtime `configSchema` sane, but treat it as secondary to manifest `channelConfigs` for this bug.
- Modify: `tests/unit/config-schema.test.ts`
  - Add failing coverage for the runtime schema nodes we still want to preserve.
- Create: `tests/unit/plugin-manifest.test.ts`
  - Add failing coverage proving `openclaw.plugin.json` now exports `channelConfigs.dingtalk` schema + `uiHints` and advertises the raised version floor.

## Constraints And References

- Canonical repo constraints live in `AGENTS.md` and `docs/contributor/architecture.en.md`.
- Save planning docs under `docs/plans/`, not `docs/superpowers/plans/`.
- The real host root cause is manifest metadata absence, not a direct failure inside `DingTalkConfigSchema.toJSONSchema()`.
- `channelConfigs` support for external plugin channel metadata is present in OpenClaw `v2026.3.28` and later, but not in `v2026.3.24`.
- Parent-repo references:
  - `~/Repo/openclaw/src/plugins/manifest.ts`
  - `~/Repo/openclaw/src/plugins/manifest-registry.ts`
  - `~/Repo/openclaw/src/config/channel-config-metadata.ts`
  - `~/Repo/openclaw/extensions/telegram/openclaw.plugin.json`
  - `~/Repo/openclaw/extensions/telegram/src/config-schema.ts`

### Task 1: Reproduce The Missing Manifest Channel Metadata In Tests

**Files:**
- Create: `tests/unit/plugin-manifest.test.ts`
- Reference: `openclaw.plugin.json`
- Reference: `package.json`

- [ ] **Step 1: Write the failing test**

Add a manifest-focused regression test that fails because the current manifest does not publish DingTalk channel metadata:

```ts
it("publishes DingTalk channel config metadata in openclaw.plugin.json", () => {
    const manifest = JSON.parse(readFileSync("openclaw.plugin.json", "utf8"));
    expect(manifest.channelConfigs?.dingtalk?.schema?.type).toBe("object");
    expect(manifest.channelConfigs?.dingtalk?.uiHints?.clientSecret?.sensitive).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/plugin-manifest.test.ts`
Expected: FAIL because `openclaw.plugin.json` currently has no `channelConfigs.dingtalk`.

- [ ] **Step 3: Add a version-floor regression assertion**

Extend the failing test file with:

```ts
expect(pkg.peerDependencies.openclaw).toBe(">=2026.3.28");
expect(pkg.openclaw.compat.pluginApi).toBe(">=2026.3.28");
```

- [ ] **Step 4: Run the focused test again**

Run: `pnpm vitest run tests/unit/plugin-manifest.test.ts`
Expected: FAIL remains localized to missing metadata/version assertions.

- [ ] **Step 5: Commit the test-only red state**

```bash
git add tests/unit/plugin-manifest.test.ts
git commit -m "test(manifest): capture missing dingtalk channel metadata"
```

### Task 2: Add Manifest `channelConfigs.dingtalk` Schema And `uiHints`

**Files:**
- Modify: `openclaw.plugin.json`
- Test: `tests/unit/plugin-manifest.test.ts`
- Reference: `~/Repo/openclaw/extensions/telegram/openclaw.plugin.json`

- [ ] **Step 1: Add `channelConfigs.dingtalk` to the manifest**

Add a new manifest section:

```json
"channelConfigs": {
  "dingtalk": {
    "label": "DingTalk",
    "description": "钉钉企业内部机器人，使用 Stream 模式，无需公网 IP。",
    "schema": { "...": "draft-07 object schema for channels.dingtalk" },
    "uiHints": { "...": "channel-level DingTalk uiHints" }
  }
}
```

The schema must cover at least the fields currently present in user config and visible on the card:

```text
clientId
clientSecret
enabled
dmPolicy
groupPolicy
allowFrom
messageType
ackReaction
useConnectionManager
cardRealTimeStream
proactivePermissionHint
aicardDegradeMs
displayNameResolution
groups
accounts
```

Also preserve the real-world legacy compatibility keys currently present in local/operator configs:

```text
agentId
corpId
showThinkingStream
asyncMode
```

- [ ] **Step 2: Add first-round `uiHints` directly in the manifest**

Include labels/help for:

```text
clientId
clientSecret
messageType
ackReaction
displayNameResolution
cardTemplateId
proactivePermissionHint.enabled
proactivePermissionHint.cooldownHours
```

- [ ] **Step 2.5: Keep the legacy compatibility keys under test**

Extend `tests/unit/plugin-manifest.test.ts` to assert the manifest schema still includes:

```ts
expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.agentId).toBeDefined();
expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.corpId).toBeDefined();
expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.showThinkingStream).toBeDefined();
expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.asyncMode).toBeDefined();
```

- [ ] **Step 3: Run the manifest regression tests**

Run: `pnpm vitest run tests/unit/plugin-manifest.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit the manifest metadata**

```bash
git add openclaw.plugin.json tests/unit/plugin-manifest.test.ts
git commit -m "fix(manifest): publish dingtalk channel config metadata"
```

### Task 3: Raise The Minimum OpenClaw Version To Match Manifest Support

**Files:**
- Modify: `package.json`
- Test: `tests/unit/plugin-manifest.test.ts`

- [ ] **Step 1: Update the published compatibility floor**

Change:

```json
"peerDependencies": {
  "openclaw": ">=2026.3.28"
},
"openclaw": {
  "compat": { "pluginApi": ">=2026.3.28" },
  "build": { "openclawVersion": "2026.3.28" },
  "install": { "minHostVersion": ">=2026.3.28" }
}
```

- [ ] **Step 2: Re-run the manifest/version regression tests**

Run: `pnpm vitest run tests/unit/plugin-manifest.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit the version bump**

```bash
git add package.json tests/unit/plugin-manifest.test.ts
git commit -m "chore(package): require openclaw channel metadata support"
```

### Task 4: Keep Runtime Schema And Tests Honest

**Files:**
- Modify: `tests/unit/config-schema.test.ts`
- Reference: `src/config-schema.ts`
- Optional modify: `src/config-schema.ts`

- [ ] **Step 1: Add a focused runtime-schema regression that still checks key nodes**

Keep a smaller schema test that asserts current runtime Zod JSON Schema still exports expected nodes for:

```ts
accounts
groups
ackReaction
proactivePermissionHint
```

and keeps key nested object structure intact for:

```ts
groups.additionalProperties
accounts.additionalProperties
```

- [ ] **Step 2: Run the focused runtime schema tests**

Run: `pnpm vitest run tests/unit/config-schema.test.ts`
Expected: PASS.

- [ ] **Step 3: Only if the runtime test reveals drift, make the smallest schema cleanup**

Do not refactor `src/config-schema.ts` further unless the test proves runtime shape is missing fields the manifest now exposes.

- [ ] **Step 4: Commit the runtime parity adjustments**

```bash
git add src/config-schema.ts tests/unit/config-schema.test.ts
git commit -m "test(config): keep runtime schema coverage aligned"
```

### Task 5: Real Host Verification In OpenClaw

**Files:**
- No repo file changes required unless recording notes
- Runtime verification target: `~/Repo/openclaw`

- [ ] **Step 1: Point `~/.openclaw/openclaw.json` plugin path at this worktree and restart**

Run: `openclaw gateway restart`
Expected: gateway restarts against the worktree plugin path.

- [ ] **Step 2: Verify `config.schema` now includes `channels.dingtalk`**

Use the browser console or RPC client to confirm:

```js
const res = await app.client.request("config.schema", {});
Boolean(res.schema.properties.channels.properties.dingtalk) === true
```

- [ ] **Step 3: Open `频道 -> DingTalk` and confirm the form renders**

Expected:
- No `Unsupported type: . Use Raw mode.`
- DingTalk form fields render
- `uiHints` text appears for the fields included in the manifest

- [ ] **Step 4: Capture one screenshot and restore the host environment**

Capture:
- `output/playwright/dingtalk-config-rendered-*.png`

Restore:
- `~/.openclaw/openclaw.json` plugin path
- `openclaw gateway restart`

- [ ] **Step 5: Run the full repo verification**

Run: `pnpm test`
Expected: PASS.

Run: `npm run type-check`
Expected: PASS.

- [ ] **Step 6: Commit the finished implementation**

```bash
git add openclaw.plugin.json package.json tests/unit/plugin-manifest.test.ts tests/unit/config-schema.test.ts output/playwright
git commit -m "fix(manifest): restore dingtalk channel config form"
```

## Notes For The Implementer

- The previous plan version assumed runtime `buildChannelConfigSchema()` was the primary WebUI path. That assumption was disproven by real-host inspection.
- The host `config.schema` response must contain `channels.dingtalk`; without that, the channels page cannot render the DingTalk form correctly.
- Duplicating manifest schema is acceptable here because the host requires static manifest metadata before runtime plugin code participates.
