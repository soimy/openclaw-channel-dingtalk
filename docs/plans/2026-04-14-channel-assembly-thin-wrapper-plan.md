# Channel Assembly Thin Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `src/channel.ts` into a thin assembly layer without changing DingTalk plugin behavior.

**Architecture:** Extract action handling and outbound adapters into `messaging/`, gateway lifecycle into `gateway/`, and status probing into `platform/`, then reassemble the plugin object in `src/channel.ts` using those domain modules.

**Tech Stack:** TypeScript, Vitest, DingTalk Stream SDK, OpenClaw plugin SDK

---

## File Structure

| File | Purpose |
|------|---------|
| `src/messaging/channel-actions.ts` | Message tool descriptor and send action handling |
| `src/messaging/channel-outbound.ts` | Outbound delivery adapter for text/media |
| `src/gateway/channel-gateway.ts` | `startAccount` lifecycle and callback wiring |
| `src/platform/channel-status.ts` | Status issue collection, probe, and snapshot building |
| `src/channel.ts` | Thin assembly root using the extracted modules |
| `tests/unit/channel-actions-module.test.ts` | Direct coverage for extracted action module |
| `tests/integration/channel-outbound-module.test.ts` | Direct coverage for extracted outbound module |
| `tests/integration/channel-gateway-module.test.ts` | Direct coverage for extracted gateway module |
| `tests/integration/channel-status-module.test.ts` | Direct coverage for extracted status module |

## Task 1: Lock the new module boundaries with failing tests

**Files:**
- Create: `tests/unit/channel-actions-module.test.ts`
- Create: `tests/integration/channel-outbound-module.test.ts`
- Create: `tests/integration/channel-gateway-module.test.ts`
- Create: `tests/integration/channel-status-module.test.ts`

- [ ] **Step 1: Write the failing action-module test**

Add a test that imports `createDingTalkMessageActions` from `src/messaging/channel-actions.ts` and verifies card capability description plus media send delegation.

- [ ] **Step 2: Run the action-module test and verify it fails**

Run: `pnpm vitest run tests/unit/channel-actions-module.test.ts`
Expected: FAIL because `src/messaging/channel-actions.ts` does not exist yet.

- [ ] **Step 3: Write the failing outbound/gateway/status module tests**

Add tests that import:
- `createDingTalkOutbound` from `src/messaging/channel-outbound.ts`
- `createDingTalkGateway` and `CHANNEL_INFLIGHT_NAMESPACE_POLICY` from `src/gateway/channel-gateway.ts`
- `createDingTalkStatus` from `src/platform/channel-status.ts`

- [ ] **Step 4: Run the new module tests and verify they fail**

Run: `pnpm vitest run tests/integration/channel-outbound-module.test.ts tests/integration/channel-gateway-module.test.ts tests/integration/channel-status-module.test.ts`
Expected: FAIL because the extracted modules do not exist yet.

## Task 2: Extract messaging adapters

**Files:**
- Create: `src/messaging/channel-actions.ts`
- Create: `src/messaging/channel-outbound.ts`
- Modify: `src/channel.ts`
- Test: `tests/unit/channel-actions-module.test.ts`
- Test: `tests/unit/message-actions.test.ts`
- Test: `tests/integration/send-lifecycle.test.ts`
- Test: `tests/integration/send-media-flow.test.ts`

- [ ] **Step 1: Implement `createDingTalkMessageActions` with current behavior**

Move the tool description, send action handler, and local helper functions out of `src/channel.ts` into `src/messaging/channel-actions.ts`.

- [ ] **Step 2: Implement `createDingTalkOutbound` with current behavior**

Move outbound target resolution plus `sendText` and `sendMedia` behavior into `src/messaging/channel-outbound.ts`.

- [ ] **Step 3: Rewire `src/channel.ts` to assemble the extracted messaging adapters**

Replace in-file action/outbound logic with imports from the new messaging modules.

- [ ] **Step 4: Run messaging tests**

Run: `pnpm vitest run tests/unit/channel-actions-module.test.ts tests/unit/message-actions.test.ts tests/integration/send-lifecycle.test.ts tests/integration/send-media-flow.test.ts`
Expected: PASS

## Task 3: Extract gateway lifecycle

**Files:**
- Create: `src/gateway/channel-gateway.ts`
- Modify: `src/channel.ts`
- Test: `tests/integration/channel-gateway-module.test.ts`
- Test: `tests/integration/gateway-start-flow.test.ts`
- Test: `tests/integration/gateway-inbound-flow.test.ts`

- [ ] **Step 1: Implement `createDingTalkGateway` and move `startAccount` helpers**

Extract the connection instrumentation, inflight tracking, callback registration, and stop/abort lifecycle into the new gateway module.

- [ ] **Step 2: Re-export inflight policy constant from `src/channel.ts`**

Preserve existing imports by re-exporting `CHANNEL_INFLIGHT_NAMESPACE_POLICY`.

- [ ] **Step 3: Run gateway tests**

Run: `pnpm vitest run tests/integration/channel-gateway-module.test.ts tests/integration/gateway-start-flow.test.ts tests/integration/gateway-inbound-flow.test.ts`
Expected: PASS

## Task 4: Extract status adapter

**Files:**
- Create: `src/platform/channel-status.ts`
- Modify: `src/channel.ts`
- Test: `tests/integration/channel-status-module.test.ts`
- Test: `tests/integration/channel-config-status.test.ts`
- Test: `tests/integration/status-probe.test.ts`

- [ ] **Step 1: Implement `createDingTalkStatus`**

Move status issue collection, account probing, summary building, and snapshot projection into the platform module.

- [ ] **Step 2: Rewire `src/channel.ts` to use the extracted status adapter**

Keep only plugin assembly in `src/channel.ts`.

- [ ] **Step 3: Run status tests**

Run: `pnpm vitest run tests/integration/channel-status-module.test.ts tests/integration/channel-config-status.test.ts tests/integration/status-probe.test.ts`
Expected: PASS

## Task 5: Final verification

**Files:**
- Modify: `src/channel.ts`
- Modify: `src/messaging/channel-actions.ts`
- Modify: `src/messaging/channel-outbound.ts`
- Modify: `src/gateway/channel-gateway.ts`
- Modify: `src/platform/channel-status.ts`

- [ ] **Step 1: Run focused refactor validation**

Run: `pnpm vitest run tests/unit/channel-actions-module.test.ts tests/unit/message-actions.test.ts tests/integration/channel-outbound-module.test.ts tests/integration/send-lifecycle.test.ts tests/integration/send-media-flow.test.ts tests/integration/channel-gateway-module.test.ts tests/integration/gateway-start-flow.test.ts tests/integration/gateway-inbound-flow.test.ts tests/integration/channel-status-module.test.ts tests/integration/channel-config-status.test.ts tests/integration/status-probe.test.ts`
Expected: PASS

- [ ] **Step 2: Run type-check**

Run: `npm run type-check`
Expected: exit code 0

- [ ] **Step 3: Review `src/channel.ts` shape**

Confirm `src/channel.ts` no longer contains extracted helper functions or large lifecycle implementations, and now primarily assembles plugin sections from imported modules.
