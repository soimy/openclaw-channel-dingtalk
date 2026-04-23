# Channel Assembly Thin Wrapper Design

**Date:** 2026-04-14
**Author:** AI Agent
**Status:** Approved

## Summary

Refactor `src/channel.ts` back into a thin assembly layer by moving action handling, outbound delivery, gateway startup lifecycle, and status probing/snapshot logic into domain-aligned modules.

## Background

`CONTRIBUTING.md` and `docs/contributor/architecture.en.md` both define `src/channel.ts` as an assembly root that should wire runtime, gateway, outbound entry points, and exports without accumulating business logic. The current file mixes assembly concerns with:

- DingTalk tool-action request parsing and delivery dispatch
- Outbound send orchestration
- Stream client lifecycle, callback registration, and inflight/dedup coordination
- Account probe and runtime snapshot composition

That erosion makes it harder to reason about ownership, increases the risk of accidental coupling, and conflicts with the repository's domain-first architecture guidance.

## Goals

1. Restore `src/channel.ts` to a thin composition layer
2. Move logic into modules that follow the documented domains
3. Preserve public behavior and existing test entry points
4. Keep the refactor incremental: no broad repo-wide file moves beyond what directly improves `channel.ts`

## Non-Goals

- Rewriting DingTalk runtime behavior
- Changing callback ack semantics, dedup policy, or AI card lifecycle
- Performing broad physical migrations of neighboring legacy modules
- Changing public plugin shape or caller-facing return payloads

## Design

### Domain Placement

#### `src/messaging/channel-actions.ts`

Owns message tool behavior currently embedded in `channel.ts`:

- `describeDingTalkMessageTool`
- `supportsAction`
- `handleAction`
- action-scoped helper parsing such as audio-as-voice normalization, session-key conversation extraction, and card owner inference

This belongs in `messaging/` because it is responsible for translating tool-send parameters into outbound text/media delivery through the existing unified send hub.

#### `src/messaging/channel-outbound.ts`

Owns the `outbound` block currently embedded in `channel.ts`:

- `resolveTarget`
- `sendText`
- `sendMedia`

This keeps proactive/outbound delivery rules in the messaging domain, while `channel.ts` only references the assembled adapter object.

#### `src/gateway/channel-gateway.ts`

Owns the gateway `startAccount` implementation and its supporting helpers:

- connection-stage instrumentation
- inbound callback inflight safety map and counters
- DingTalk callback registration
- abort/stop handling
- connection-manager vs native reconnect wiring
- card callback feedback ack handling

`CHANNEL_INFLIGHT_NAMESPACE_POLICY` remains exported for tests and status expectations, but its source of truth moves to this gateway module. `channel.ts` will re-export the constant to preserve existing imports.

#### `src/platform/channel-status.ts`

Owns the `status` block logic:

- `collectStatusIssues`
- `buildChannelSummary`
- `probeAccount`
- `buildAccountSnapshot`

This keeps probing and runtime projection alongside other platform-oriented concerns such as auth and timestamp helpers.

### `src/channel.ts` Responsibilities After Refactor

`src/channel.ts` should keep:

- plugin metadata
- config/account resolution block
- security and group policy declarations
- directory wiring
- imports/re-exports of low-level public helpers
- assembly of `actions`, `outbound`, `gateway`, and `status` from the new modules

It should not keep custom helper functions that exist only to support those moved domains.

### Compatibility Strategy

To avoid breaking the rest of the codebase during the refactor:

- `dingtalkPlugin` remains exported from `src/channel.ts`
- `CHANNEL_INFLIGHT_NAMESPACE_POLICY` stays importable from `src/channel.ts`
- existing tests that reach behavior through `dingtalkPlugin.actions`, `dingtalkPlugin.outbound`, and `dingtalkPlugin.gateway` remain valid
- no changes are made to `send-service`, `inbound-handler`, `connection-manager`, or card APIs beyond import-path adjustments

## Testing Strategy

1. Add new tests that import the planned modules directly so the new boundaries are exercised explicitly
2. Keep existing integration and unit tests for `dingtalkPlugin` behavior green
3. Run targeted suites for:
   - action handling
   - outbound delivery
   - gateway startup and inbound callback flow
   - status probing
4. Run `npm run type-check` after refactor to catch wiring mistakes across the new modules

## Risks And Mitigations

### Import cycle risk

`channel.ts` will depend on new modules, so the new modules must not import `channel.ts`.

Mitigation:
- have new modules depend only on shared services/types
- keep re-exports one-way from `channel.ts`

### Behavior drift risk in gateway startup

`startAccount` is large and stateful.

Mitigation:
- preserve logic structure during extraction
- rely on existing `gateway-start-flow` and `gateway-inbound-flow` coverage

### Test fragility risk

Some tests import `CHANNEL_INFLIGHT_NAMESPACE_POLICY` from `src/channel.ts`.

Mitigation:
- re-export the constant from `src/channel.ts`
- add direct coverage for the new gateway module export as well
