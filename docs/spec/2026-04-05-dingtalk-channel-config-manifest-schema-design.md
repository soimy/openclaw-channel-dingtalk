# DingTalk Channel Config Manifest Schema Design

**Date:** 2026-04-05

## Goal

Fix the OpenClaw WebUI DingTalk channel form so `频道 -> DingTalk` renders a normal editable form instead of `Unsupported type: . Use Raw mode.`, and surface DingTalk-specific `uiHints` labels/help in the same channel card.

## Confirmed Root Cause

Real-host investigation on OpenClaw `2026.4.1` showed:

1. `src/config-schema.ts` and `buildChannelConfigSchema(DingTalkConfigSchema)` both produce Zod/JSON Schema output that OpenClaw's `analyzeConfigSchema()` accepts locally.
2. The gateway `config.schema` response delivered to the real browser does **not** include `channels.dingtalk`.
3. The external plugin manifest [openclaw.plugin.json](../../openclaw.plugin.json) currently contains only a top-level empty `configSchema` and no `channelConfigs.dingtalk` entry.
4. OpenClaw host code builds channel config metadata for the WebUI from manifest registry channel metadata, specifically `record.channelConfigs`, not from the plugin runtime's `configSchema` field alone.

Therefore the missing or unsupported DingTalk form is not primarily caused by `src/config-schema.ts`. The host never receives DingTalk channel metadata in the path the channels page consumes.

## Host Compatibility Constraint

OpenClaw `v2026.3.24` does not yet support manifest `channelConfigs` in the external plugin registry path.

OpenClaw `v2026.3.28` and later do support:

- manifest `channelConfigs`
- channel-level `uiHints`
- runtime collection through `collectChannelSchemaMetadata()`

This fix therefore requires raising the minimum supported OpenClaw version to `>=2026.3.28`.

## Design

### 1. Manifest Becomes The WebUI Channel Schema Source

Add a `channelConfigs.dingtalk` block to [openclaw.plugin.json](../../openclaw.plugin.json) containing:

- `label`
- `description`
- `schema`
- `uiHints`

This is the metadata path the host uses when constructing `config.schema` for external channel plugins.

### 2. Runtime Zod Schema Remains The Validation Source Of Truth

Keep [src/config-schema.ts](../../src/config-schema.ts) as the canonical runtime validation schema. Use it to guide the manifest structure and, where useful, align key field coverage.

The runtime schema may still be improved later for parity and maintainability, but that is no longer the first-order fix for the broken DingTalk channel form.

### 3. Version Floor Moves To `2026.3.28`

Update [package.json](../../package.json) so:

- `peerDependencies.openclaw`
- `openclaw.compat.pluginApi`
- `openclaw.build.openclawVersion`
- `openclaw.install.minHostVersion`

all reflect `>=2026.3.28` / `2026.3.28`.

### 4. UI Hints Ship In The Manifest

Put the first round of DingTalk `uiHints` in `openclaw.plugin.json` alongside `channelConfigs.dingtalk`.

Focus on the fields most visible in the channel card:

- `clientId`
- `clientSecret`
- `messageType`
- `ackReaction`
- `displayNameResolution`
- `cardTemplateId`
- `proactivePermissionHint.enabled`
- `proactivePermissionHint.cooldownHours`

### 5. Manifest May Keep Legacy Compatibility Keys

The manifest schema may intentionally include a small set of legacy DingTalk keys that appear in real user configs even if the current runtime Zod schema does not rely on all of them directly.

Initial compatibility keep-set:

- `agentId`
- `corpId`
- `showThinkingStream`
- `asyncMode`

Rationale:

- preserve existing host-side config editing experience
- avoid hiding or silently dropping keys already present in deployed user configs
- keep the WebUI form aligned with what operators already see in their config snapshots

## Non-Goals

- Do not hand-build a second full validation layer outside the manifest scope needed for WebUI.
- Do not try to fix this only in `src/channel.ts`; that does not populate manifest channel metadata for external plugins.
- Do not keep the old compatibility floor if it blocks the manifest path the host actually uses.

## Verification

Success requires all of the following:

1. Plugin tests confirm `openclaw.plugin.json` contains `channelConfigs.dingtalk` with schema + `uiHints`.
2. Plugin tests confirm the manifest still preserves the intended legacy compatibility keys.
3. Local runtime validation still passes.
4. In a real OpenClaw host, `config.schema` now includes `channels.dingtalk`.
5. In `频道 -> DingTalk`, the unsupported error disappears and DingTalk fields render normally.
