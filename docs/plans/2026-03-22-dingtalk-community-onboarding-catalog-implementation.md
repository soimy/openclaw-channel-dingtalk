# DingTalk Community Onboarding Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the community `dingtalk` channel plugin appear directly in first-run `openclaw onboard` channel selection, so a new user can select it and install it from npm without discovering the plugin elsewhere first.

**Architecture:** Reuse OpenClaw's existing channel catalog and install-on-demand flow. Add one official built-in community channel catalog JSON inside the upstream `openclaw` repo, merge it into the existing `listChannelPluginCatalogEntries()` path at low priority, and let the current onboarding flow continue to render `plugin · install` entries and call the existing npm installer.

**Tech Stack:** TypeScript, Node.js, OpenClaw channel catalog pipeline, Vitest, docs site markdown

---

### Task 1: Lock The Scope And Confirm The Existing Plugin Metadata

**Files:**
- Inspect: `../openclaw/src/channels/plugins/catalog.ts`
- Inspect: `../openclaw/src/commands/onboard-channels.ts`
- Inspect: `../openclaw/src/commands/channel-setup/plugin-install.ts`
- Inspect: `package.json`
- Inspect: `openclaw.plugin.json`

- [ ] **Step 1: Confirm the plugin already exposes onboarding-ready package metadata**

Check that this repo already includes:
- `openclaw.channel.id = "dingtalk"`
- `openclaw.channel.label = "DingTalk"`
- `openclaw.channel.selectionLabel = "DingTalk (钉钉)"`
- `openclaw.install.npmSpec = "@soimy/dingtalk"`
- `openclaw.plugin.json.id = "dingtalk"`
- `openclaw.plugin.json.channels = ["dingtalk"]`

Expected result: no plugin-side metadata change is required for the minimal upstream path.

- [ ] **Step 2: Confirm upstream already supports install-on-demand catalog entries**

Verify in upstream code that:
- `resolveChannelSetupEntries()` separates installed and installable catalog entries
- onboarding renders installable entries with `selectionHint: "plugin · install"`
- selecting such an entry calls `ensureChannelSetupPluginInstalled()`
- npm installation already goes through `installPluginFromNpmSpec()`

Expected result: no onboarding UI or installer redesign is required.

- [ ] **Step 3: Record the implementation decision in the PR description or issue**

Decision to record:
- No new plugin-sdk API
- No remote registry fetch
- No marketplace dependency
- Minimal change is an official built-in static community channel catalog merged into the existing catalog resolver

- [ ] **Step 4: Commit the scope lock**

```bash
git add .
git commit -m "docs: add scope notes for community onboarding catalog"
```

### Task 2: Add A Built-In Community Channel Catalog File In Upstream

**Files:**
- Create: `../openclaw/src/channels/plugins/community-channel-catalog.json`
- Reference: `../openclaw/src/channels/plugins/catalog.ts`

- [ ] **Step 1: Create the new built-in catalog JSON file**

Create `../openclaw/src/channels/plugins/community-channel-catalog.json` with this initial payload:

```json
{
  "entries": [
    {
      "name": "@soimy/dingtalk",
      "openclaw": {
        "channel": {
          "id": "dingtalk",
          "label": "DingTalk",
          "selectionLabel": "DingTalk (钉钉)",
          "docsPath": "/channels/dingtalk",
          "docsLabel": "dingtalk",
          "blurb": "钉钉企业内部机器人，使用 Stream 模式，无需公网 IP。",
          "order": 70,
          "aliases": ["dd", "ding"]
        },
        "install": {
          "npmSpec": "@soimy/dingtalk",
          "defaultChoice": "npm"
        }
      }
    }
  ]
}
```

- [ ] **Step 2: Keep the schema identical to the already-supported external catalog format**

Do not invent a new manifest shape. The file must remain compatible with the parser that already accepts:
- `{ entries: [...] }`
- `entry.name`
- `entry.openclaw.channel`
- `entry.openclaw.install`

Expected result: existing `buildExternalCatalogEntry()` logic can be reused with little or no transformation.

- [ ] **Step 3: Add a short code comment near the new file loader callsite**

Comment intent:
- This file is the official built-in community catalog for first-run onboarding discovery.
- It is intentionally lower priority than installed, workspace, config, and bundled plugin discovery.

- [ ] **Step 4: Commit the catalog file**

```bash
git add ../openclaw/src/channels/plugins/community-channel-catalog.json
git commit -m "feat: add built-in community channel catalog"
```

### Task 3: Merge The Built-In Catalog Into The Existing Resolver

**Files:**
- Modify: `../openclaw/src/channels/plugins/catalog.ts`
- Reference: `../openclaw/src/channels/plugins/catalog.ts`

- [ ] **Step 1: Add a small helper to load the built-in community catalog JSON**

Implementation shape:
- Read the JSON from `community-channel-catalog.json`
- Parse it with the existing `parseCatalogEntries()` helper
- Convert entries using the existing `buildExternalCatalogEntry()` helper
- Return `ChannelPluginCatalogEntry[]`
- Fail closed on parse errors by returning `[]`

Keep the helper small and local to `catalog.ts`.

- [ ] **Step 2: Merge built-in community entries inside `listChannelPluginCatalogEntries()`**

Insert the new merge stage after:
- plugin discovery candidates
- bundled metadata catalog entries

And before or alongside current external catalog file entries.

Required merge rule:
- only add a built-in community entry when `resolved` does not already contain that channel id

That preserves current priority behavior:
- config/workspace/global/bundled/plugin-discovered entries always win
- built-in community catalog only fills discovery gaps for first-run onboarding

- [ ] **Step 3: Keep the priority lower than current discovery sources**

Use a low-priority merge path equivalent to the current external catalog behavior:
- do not overwrite existing channel ids
- keep sorting by `meta.order` then `meta.label`

- [ ] **Step 4: Avoid environment or network coupling**

Do not:
- fetch over HTTP
- require `OPENCLAW_PLUGIN_CATALOG_PATHS`
- require MPM
- write files into `~/.openclaw/plugins/catalog.json`

This task should stay purely in-process and package-local.

- [ ] **Step 5: Commit the resolver change**

```bash
git add ../openclaw/src/channels/plugins/catalog.ts
git commit -m "feat: merge built-in community channel catalog into onboarding discovery"
```

### Task 4: Add Tests For Catalog Presence And Install-On-Demand Visibility

**Files:**
- Modify: `../openclaw/src/channels/plugins/plugins-core.test.ts`
- Inspect: `../openclaw/src/commands/onboard-channels.e2e.test.ts`

- [ ] **Step 1: Add a catalog-level test that `dingtalk` appears without local installation**

Add a test in `../openclaw/src/channels/plugins/plugins-core.test.ts` that asserts:
- `listChannelPluginCatalogEntries()` contains an entry whose `id === "dingtalk"`
- `entry.install.npmSpec === "@soimy/dingtalk"`
- `entry.meta.selectionLabel === "DingTalk (钉钉)"`

- [ ] **Step 2: Add a test that built-in community entries do not override discovered plugins**

Test scenario:
- seed a discovered or temp plugin entry with the same channel id `dingtalk`
- assert that the discovered plugin metadata wins over the built-in community catalog

Expected result: the new source is additive, not authoritative.

- [ ] **Step 3: Add or extend an onboarding-flow test for installable catalog entries**

If an existing onboarding test already exercises installable catalog entries, extend it.
Otherwise add a narrow test that asserts:
- `resolveChannelSetupEntries()` puts `dingtalk` in `installableCatalogEntries` when not installed
- onboarding status line becomes `install plugin to enable`

- [ ] **Step 4: Run targeted tests**

Run:

```bash
cd ../openclaw
pnpm test src/channels/plugins/plugins-core.test.ts
pnpm test src/commands/onboard-channels.e2e.test.ts
```

Expected result: both suites pass.

- [ ] **Step 5: Commit the tests**

```bash
git add ../openclaw/src/channels/plugins/plugins-core.test.ts ../openclaw/src/commands/onboard-channels.e2e.test.ts
git commit -m "test: cover built-in community channel catalog onboarding"
```

### Task 5: Add Or Align The Official Docs Page Used By Onboarding

**Files:**
- Inspect: `../openclaw/docs/channels/`
- Create or Modify: `../openclaw/docs/channels/dingtalk.md`
- Reference: `package.json`

- [ ] **Step 1: Check whether `/channels/dingtalk` already exists in upstream docs**

If it exists, verify that it is current enough for first-run setup.
If it does not exist, create it.

- [ ] **Step 2: Keep the doc minimal but onboarding-safe**

Required content:
- what DingTalk plugin is
- npm package name `@soimy/dingtalk`
- basic setup prerequisites
- config fields users will be asked for
- link to the plugin repository for deeper docs

- [ ] **Step 3: Ensure the path matches the catalog metadata**

The catalog entry and plugin package both point at:
- `/channels/dingtalk`

Do not ship a broken docs link from onboarding.

- [ ] **Step 4: Commit the docs update**

```bash
git add ../openclaw/docs/channels/dingtalk.md
git commit -m "docs: add dingtalk onboarding channel page"
```

### Task 6: Verify The End-To-End New-User Path

**Files:**
- Verify: `../openclaw/src/wizard/setup.ts`
- Verify: `../openclaw/src/commands/onboard-channels.ts`
- Verify: `../openclaw/src/commands/channel-setup/plugin-install.ts`

- [ ] **Step 1: Run the relevant upstream test suite**

Run:

```bash
cd ../openclaw
pnpm test
```

Expected result: full test suite remains green.

- [ ] **Step 2: Smoke-test the first-run onboarding path manually**

Suggested manual flow in a clean temp config environment:

```bash
cd ../openclaw
OPENCLAW_CONFIG_DIR="$(mktemp -d)" pnpm openclaw onboard
```

Verify manually that:
- `DingTalk (钉钉)` appears in the channel list
- its hint indicates installability
- selecting it offers `Download from npm (@soimy/dingtalk)`

- [ ] **Step 3: Confirm the installer resolves the plugin id correctly**

After install, verify:
- plugin id is `dingtalk`
- config enablement uses `plugins.entries.dingtalk`
- onboarding proceeds into the existing DingTalk setup flow rather than stopping at install

- [ ] **Step 4: Record any follow-up issues separately instead of expanding this change**

Do not expand scope here into:
- remote community registries
- dynamic updates
- search or ranking
- trust or review badges
- plugin screenshots or richer marketplace UI

Those are follow-up features, not part of the minimum path.

- [ ] **Step 5: Commit the verification-ready branch state**

```bash
git add .
git commit -m "feat: surface dingtalk community channel in first-run onboarding"
```

### Task 7: Publish Coordination And Rollout Notes

**Files:**
- Update if needed: `docs/NPM_PUBLISH.md`
- Update if needed: `README.md`

- [ ] **Step 1: Confirm the published npm version contains the catalog-compatible metadata**

Before merging upstream support, ensure the public npm package version for `@soimy/dingtalk` includes:
- `openclaw.channel`
- `openclaw.install.npmSpec`
- `openclaw.plugin.json`

- [ ] **Step 2: Add a short maintainer note for future catalog edits**

Document:
- where the built-in community catalog lives
- how new community channels should be added
- that catalog additions should be conservative and reviewed

- [ ] **Step 3: Keep community listing governance explicit**

Suggested rule to document:
- package must be public on npm
- repo must be public
- plugin manifest must be valid
- onboarding docs path must exist

- [ ] **Step 4: Commit the rollout notes**

```bash
git add docs/NPM_PUBLISH.md README.md
git commit -m "docs: note rollout and maintenance for onboarding community catalog"
```
