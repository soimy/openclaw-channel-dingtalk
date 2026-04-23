# OpenClaw sibling SDK resolution design

Date: 2026-04-08

## Summary

This design fixes a worktree-specific TypeScript path resolution problem in `openclaw-channel-dingtalk` while preserving a zero-configuration experience for CI and normal contributors.

The core change is to stop hardcoding sibling `openclaw` repository paths in the shared `tsconfig.json`. Instead, local development can opt into a generated local override config that points to a sibling `openclaw` checkout when available and valid. All standard environments continue to fall back to `node_modules/openclaw`.

## Problem

The current shared `tsconfig.json` contains `paths` entries such as:

- `../openclaw/dist/plugin-sdk/*.d.ts`
- `../../dist/plugin-sdk/*.d.ts`
- `../openclaw/src/plugin-sdk/*.ts`
- `../../src/plugin-sdk/*.ts`

These assumptions are fragile because they encode a specific repository layout. They may work in a normal checkout but fail in a worktree layout like:

- `openclaw-channel-dingtalk/.worktrees/card-template-v2`

When these path mappings fail, TypeScript falls back to `node_modules/openclaw`. That fallback is acceptable in principle, but in practice it can expose stale installed versions and create confusing type-check failures that appear unrelated to the actual code change.

## Goals

### Primary goals

1. Make SDK resolution stable in both normal checkouts and git worktrees.
2. Prefer a local sibling `openclaw` checkout for advanced local development when available.
3. Preserve zero-configuration behavior for CI and normal contributors.
4. Keep `node_modules/openclaw` as a safe fallback instead of a hard requirement for local sibling-based development.

### Non-goals

1. Do not remove the standard fallback to installed `openclaw` in this phase.
2. Do not require all developers to clone a sibling `openclaw` repository.
3. Do not solve dependency size reduction in the same implementation phase.
4. Do not introduce broad directory searching that can silently bind to the wrong repository.

## Recommended approach

Use a two-layer TypeScript configuration model:

1. A shared, committed `tsconfig.json` that contains only portable configuration and relies on normal package resolution.
2. A generated, local-only `tsconfig.local.json` that is created when a valid sibling `openclaw` repository is detected.

Under this design:

- CI and standard contributors use `tsconfig.json` directly.
- Local advanced development can generate `tsconfig.local.json` to override `openclaw/plugin-sdk/*` resolution.
- If sibling detection fails or the sibling repository is incompatible, the local override is not used and the project continues to resolve through `node_modules/openclaw`.

## Configuration model

### Shared config

`tsconfig.json` should:

- remain committed to the repository
- contain only stable compiler options
- stop hardcoding sibling-repository-specific `paths`
- allow `openclaw/plugin-sdk/*` imports to resolve through the installed package by default

This ensures that:

- CI remains deterministic
- normal contributors do not need local repository topology knowledge
- worktrees no longer inherit broken relative assumptions from the shared config

### Local override config

`tsconfig.local.json` should:

- be generated locally
- extend `./tsconfig.json`
- inject `compilerOptions.paths` for `openclaw/plugin-sdk/*`
- not be committed

Its only job is to redirect SDK imports to the sibling `openclaw` checkout when local development explicitly opts into that mode.

## Sibling repository detection

### Detection principle

Detection must start from the repository root of `openclaw-channel-dingtalk`, not from the current working directory path inside `.worktrees/...`.

This avoids worktree path drift and normalizes both of these cases to the same base:

- main checkout directory
- git worktree directory

### Detection candidates

The first implementation should keep candidates narrow and explicit. The preferred candidate is:

- `<current-repo-parent>/openclaw`

Optional future support may include an explicit environment variable override, but that is not required for the first implementation.

### Validation rules

A sibling candidate must only be accepted if all of the following are true:

1. `package.json` exists and declares `name: "openclaw"`
2. the repository exposes the required SDK layout, such as `src/plugin-sdk` or `dist/plugin-sdk`
3. the detected version is compatible with this plugin's declared OpenClaw compatibility range

If any validation step fails, the candidate must be rejected and the system must fall back to standard package resolution.

## Fallback behavior

Fallback behavior must be non-disruptive.

### If no sibling repository is found

- do not fail
- do not block development
- use the installed `node_modules/openclaw`

### If the sibling repository exists but is invalid

- emit a clear explanation
- do not generate or use a broken local override
- continue with installed package resolution

### If the sibling repository exists but is version-incompatible

- reject it explicitly
- explain the mismatch in a developer-friendly message
- continue with installed package resolution

This is important because the local enhancement must never make the standard workflow less reliable.

## Command model

### Standard commands

The existing commands remain the canonical defaults:

- `pnpm run type-check`
- `pnpm test`

These must continue to work in CI and for contributors without a sibling checkout.

### Local preparation step

Add a lightweight local preparation step whose responsibility is to:

1. detect a sibling `openclaw` checkout
2. validate it
3. generate or clean `tsconfig.local.json`

This step should be explicit in the first version rather than silently embedded inside every developer command.

That keeps the system easier to debug and makes it obvious when local override mode is active.

### Command resolution behavior

Local development should prefer:

- `tsconfig.local.json` when it exists and is valid
- otherwise `tsconfig.json`

CI should always use:

- `tsconfig.json`

## Why this approach is preferred

### Compared with more `paths` entries in shared config

Adding more relative `paths` patterns for worktree layouts would only encode additional fragile assumptions. It would remain hard to maintain and easy to break with future directory changes.

### Compared with removing `node_modules/openclaw`

Completely removing the installed fallback would conflict with the requirement that CI and normal contributors remain zero-configuration. It would make the project more coupled to a specific local multi-repository setup.

### Compared with always using installed package resolution

Always using `node_modules` would be simpler, but it would give up the local sibling-repo workflow that is valuable when developing the plugin and parent project together.

## Validation plan

The implementation should be verified in these scenarios.

### Scenario 1: Standard checkout without sibling `openclaw`

Expected outcome:

- no special setup is required
- `type-check` succeeds
- imports resolve through installed `openclaw`

### Scenario 2: Standard checkout with valid sibling `openclaw`

Expected outcome:

- local preparation detects sibling repo
- local override config is generated correctly
- `type-check` uses sibling SDK exports

### Scenario 3: Worktree checkout with valid sibling `openclaw`

Expected outcome:

- detection still succeeds because it is rooted at repository root, not worktree leaf path
- local override config points to the correct sibling repo
- `type-check` succeeds

### Scenario 4: Sibling repo present but invalid or incompatible

Expected outcome:

- local preparation prints a clear reason
- local override is skipped or cleaned up
- standard package resolution still works

## Rollout guidance

### Phase 1

Implement only the stability fix:

- remove fragile shared `paths`
- add local override generation
- document standard mode versus local sibling mode
- keep installed `openclaw` fallback

### Phase 2 (optional, separate decision)

Evaluate whether dependency footprint can be reduced further without harming reliability.

This phase should be a separate decision because it changes the operational model and would mix two concerns if done now:

1. stable SDK resolution
2. dependency size optimization

## Developer documentation expectations

Documentation should clearly distinguish:

### Standard mode

- default for CI and contributors
- no sibling repository required
- normal install and command flow

### Local sibling mode

- optional advanced workflow
- intended for developers editing both `openclaw` and this plugin
- enabled through the local preparation step

This makes the feature discoverable without turning it into a hidden team-wide requirement.

## Final recommendation

Adopt a local-override design centered on generated `tsconfig.local.json`.

This preserves the current standard workflow, fixes worktree fragility, supports sibling-repo development, and avoids coupling the shared repository configuration to one specific local directory layout.
