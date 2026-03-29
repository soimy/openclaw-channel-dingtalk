# DingTalk Plugin SDK Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align this plugin with the latest upstream `openclaw` channel-plugin entry and scoped `plugin-sdk` surfaces, while fixing the `rootDir` type-check failures.

**Architecture:** Keep `src/channel.ts` as the assembly root per `docs/contributor/architecture.en.md`, but migrate the public plugin entry to `defineChannelPluginEntry`, move onboarding onto standard `setup` / `setupWizard` surfaces, and replace broad `openclaw/plugin-sdk` root imports with focused subpaths. Fix TypeScript path resolution so this repo consumes upstream declarations without pulling the whole `../openclaw` source tree under the local `rootDir`.

**Tech Stack:** TypeScript, Vitest, OpenClaw channel plugin SDK, `apply_patch`, `npm` / `pnpm`

---

### Task 1: Stabilize Type Resolution Against Upstream SDK

**Files:**
- Modify: `tsconfig.json`
- Test: `npm run type-check`

- [ ] **Step 1: Write the failing verification target**

Current failing command:

```bash
npm run type-check
```

Expected failure patterns:
- `TS6059` complaining that `../openclaw/src/...` is outside `rootDir`
- missing root-surface exports like `readStringParam`, `jsonResult`, `buildChannelConfigSchema`

- [ ] **Step 2: Update TypeScript path resolution to prefer built declarations**

Edit `tsconfig.json` so `openclaw/plugin-sdk` and `openclaw/plugin-sdk/*` resolve to upstream `dist/plugin-sdk/*.d.ts` first, with source fallbacks kept only as a last resort for local development.

- [ ] **Step 3: Run type-check to confirm rootDir noise is reduced**

Run:

```bash
npm run type-check
```

Expected:
- `TS6059` rootDir explosions disappear or are reduced to only direct local incompatibilities
- remaining errors should now point to this repo's outdated API usage

- [ ] **Step 4: Commit the tsconfig-only fix**

```bash
git add tsconfig.json
git commit -m "build: prefer upstream plugin-sdk declarations"
```

### Task 2: Migrate Plugin Entry to Upstream Channel Entry Pattern

**Files:**
- Modify: `index.ts`
- Modify: `src/types.ts`
- Test: `tests/unit/runtime-peer-index.test.ts`

- [ ] **Step 1: Write or update failing entrypoint tests**

Cover:
- entry uses `defineChannelPluginEntry`
- channel registration still occurs
- docs gateway methods only register in `registerFull`

Target command:

```bash
pnpm test tests/unit/runtime-peer-index.test.ts
```

Expected initial failure:
- tests still assume direct `register` implementation or old import surface

- [ ] **Step 2: Implement new entrypoint shape**

Refactor `index.ts` to:
- import `defineChannelPluginEntry` and `OpenClawPluginApi` from scoped SDK subpaths
- export the existing channel/runtime helpers
- register docs gateway methods inside `registerFull`
- keep runtime wiring behavior unchanged

- [ ] **Step 3: Update local plugin module typing**

Adjust `src/types.ts` so local plugin entry types no longer depend on a hand-rolled old shape when upstream `defineChannelPluginEntry` covers it.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm test tests/unit/runtime-peer-index.test.ts
```

Expected:
- entrypoint tests pass with the new registration flow

- [ ] **Step 5: Commit the entry migration**

```bash
git add index.ts src/types.ts tests/unit/runtime-peer-index.test.ts
git commit -m "refactor: migrate dingtalk plugin entry to channel entry helper"
```

### Task 3: Replace Legacy Onboarding With Standard Setup / Setup Wizard

**Files:**
- Modify: `src/onboarding.ts`
- Modify: `src/channel.ts`
- Modify: `tests/unit/onboarding.test.ts`
- Test: `tests/unit/onboarding.test.ts`

- [ ] **Step 1: Write or update failing setup tests**

Cover:
- status/configure flow still exposes the same DingTalk prompts and writes config correctly
- channel plugin now exposes `setup` / `setupWizard` instead of legacy `onboarding`

Run:

```bash
pnpm test tests/unit/onboarding.test.ts
```

Expected initial failure:
- tests reference removed legacy types or plugin shape

- [ ] **Step 2: Port onboarding implementation onto setup surfaces**

Refactor `src/onboarding.ts` to use scoped setup-related SDK types and helpers, preserving current DingTalk-specific prompts and config patch behavior.

- [ ] **Step 3: Wire setup surfaces into the channel assembly layer**

Update `src/channel.ts` to:
- remove unsupported `onboarding`
- expose `setup` and `setupWizard`
- keep assembly-only responsibility; do not move unrelated business logic into the file

- [ ] **Step 4: Run focused setup tests**

Run:

```bash
pnpm test tests/unit/onboarding.test.ts
```

Expected:
- setup/onboarding behavior still works
- plugin shape matches upstream channel contract

- [ ] **Step 5: Commit the setup migration**

```bash
git add src/onboarding.ts src/channel.ts tests/unit/onboarding.test.ts
git commit -m "refactor: migrate dingtalk setup to channel wizard surfaces"
```

### Task 4: Migrate Broad SDK Imports to Scoped Subpaths

**Files:**
- Modify: `src/channel.ts`
- Modify: `src/config.ts`
- Modify: `src/runtime.ts`
- Modify: `src/targeting/agent-name-matcher.ts`
- Modify: `src/targeting/agent-routing.ts`
- Modify: `src/targeting/target-directory-adapter.ts`
- Modify: `src/onboarding.ts`
- Modify: `src/types.ts`
- Test: `npm run type-check`

- [ ] **Step 1: Write the failing verification target**

Run:

```bash
npm run type-check
```

Expected failures:
- missing types/helpers from `openclaw/plugin-sdk` root
- old broad imports still referencing removed exports

- [ ] **Step 2: Replace imports with precise SDK subpaths**

Map each usage to the upstream-recommended surface, for example:
- entry helpers from `openclaw/plugin-sdk/core`
- setup helpers from `openclaw/plugin-sdk/setup` or `channel-setup`
- channel contract types from focused channel subpaths
- param helpers from the SDK subpath that still publicly exports them

- [ ] **Step 3: Run full type-check**

Run:

```bash
npm run type-check
```

Expected:
- zero TypeScript errors

- [ ] **Step 4: Commit the import-surface migration**

```bash
git add src/channel.ts src/config.ts src/runtime.ts src/targeting/agent-name-matcher.ts src/targeting/agent-routing.ts src/targeting/target-directory-adapter.ts src/onboarding.ts src/types.ts
git commit -m "refactor: align dingtalk sdk imports with scoped subpaths"
```

### Task 5: End-to-End Verification and Cleanup

**Files:**
- Modify: any touched tests if follow-up fixes are needed
- Test: `npm run lint`
- Test: `pnpm test`
- Test: `npm run type-check`

- [ ] **Step 1: Run lint**

```bash
npm run lint
```

Expected:
- exit code 0

- [ ] **Step 2: Run full test suite**

```bash
pnpm test
```

Expected:
- all unit and integration tests pass

- [ ] **Step 3: Re-run final type-check**

```bash
npm run type-check
```

Expected:
- pass with zero errors

- [ ] **Step 4: Commit verification follow-ups**

```bash
git add .
git commit -m "test: verify sdk alignment migration"
```
