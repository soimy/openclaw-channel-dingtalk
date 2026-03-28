# PR #380 HTTP Callback Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR #380 safe to merge by hardening HTTP callback mode, preserving config through schema/account resolution, and explicitly resolving the current HTTP-vs-card compatibility gap.

**Architecture:** Keep the existing `handleDingTalkMessage()` pipeline as the single inbound processing path, but harden the HTTP ingress layer before it reaches that pipeline. Reuse one shared dedup/inflight guard for both Stream and HTTP, and de-scope unsupported behavior instead of shipping ambiguous capability claims.

**Tech Stack:** TypeScript, Node.js `http`, Vitest, Zod, GitHub PR workflow

---

### Task 1: Lock the HTTP config contract end-to-end

**Files:**
- Modify: `src/config-schema.ts`
- Modify: `src/types.ts`
- Test: `tests/unit/config-schema.test.ts`
- Test: `tests/unit/types.test.ts`

- [ ] **Step 1: Write failing schema tests for the new HTTP fields**

Add assertions in `tests/unit/config-schema.test.ts` that:
- top-level `mode: "http"` survives parse
- top-level `httpPort` survives parse
- top-level `webhookPath` survives parse
- account-level overrides for those fields survive parse

- [ ] **Step 2: Run the focused schema tests and verify they fail**

Run: `pnpm vitest run tests/unit/config-schema.test.ts`
Expected: FAIL because parsed output drops `mode`, `httpPort`, or `webhookPath`.

- [ ] **Step 3: Write failing account-resolution tests**

Add assertions in `tests/unit/types.test.ts` that:
- `resolveDingTalkAccount(cfg, "default")` returns `mode`, `httpPort`, `webhookPath`
- named accounts inherit channel-level HTTP defaults unless overridden

- [ ] **Step 4: Run the focused type helper tests and verify they fail**

Run: `pnpm vitest run tests/unit/types.test.ts`
Expected: FAIL because `DingTalkChannelConfig` and default-account resolution do not expose the new fields.

- [ ] **Step 5: Implement the minimal config contract fixes**

Update `src/config-schema.ts` to include:

```ts
mode: z.enum(["stream", "http"]).optional().default("stream"),
httpPort: z.number().int().min(1).max(65535).optional().default(3000),
webhookPath: z.string().optional().default("/dingtalk/callback"),
```

Update `src/types.ts` to:
- add the same three fields to `DingTalkChannelConfig`
- include them in the explicit `resolveDingTalkAccount()` mapping for the default account

- [ ] **Step 6: Re-run the focused tests and verify they pass**

Run:
- `pnpm vitest run tests/unit/config-schema.test.ts`
- `pnpm vitest run tests/unit/types.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the config contract fix**

```bash
git add src/config-schema.ts src/types.ts tests/unit/config-schema.test.ts tests/unit/types.test.ts
git commit -m "fix: preserve dingtalk http callback config fields"
```

### Task 2: Harden the HTTP ingress path before dispatch

**Files:**
- Modify: `src/http-receiver.ts`
- Modify: `src/signature.ts`
- Test: `tests/unit/http-receiver.test.ts`
- Test: `tests/unit/sign.test.ts`

- [ ] **Step 1: Write failing signature verification tests**

Extend `tests/unit/sign.test.ts` with coverage for a verify helper, for example:

```ts
expect(verifyDingTalkSignature({ timestamp, sign, secret, now: fixedNow })).toBe(true);
expect(verifyDingTalkSignature({ timestamp, sign: "bad", secret, now: fixedNow })).toBe(false);
expect(verifyDingTalkSignature({ timestamp: oldTs, sign, secret, now: fixedNow })).toBe(false);
```

- [ ] **Step 2: Write failing HTTP receiver tests for ingress hardening**

Extend `tests/unit/http-receiver.test.ts` with cases for:
- missing or invalid signature returns `401` or `403`
- oversized body returns `413`
- `handleDingTalkMessage()` rejection does not change the HTTP response body/status

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:
- `pnpm vitest run tests/unit/sign.test.ts`
- `pnpm vitest run tests/unit/http-receiver.test.ts`

Expected: FAIL because no verification helper exists and the receiver currently accepts any body.

- [ ] **Step 4: Implement minimal signature verification utilities**

Add a helper in `src/signature.ts`, for example:

```ts
export function verifyDingTalkSignature(params: {
  timestamp: string;
  sign: string;
  secret: string;
  now?: number;
  maxSkewMs?: number;
}): boolean
```

Implementation rules:
- reject empty `timestamp`, `sign`, or `secret`
- reject stale timestamps outside `maxSkewMs`
- compute expected signature with the existing HMAC helper
- use a timing-safe string compare when lengths match

- [ ] **Step 5: Implement ingress hardening in `src/http-receiver.ts`**

Add:
- signature header extraction and validation before dispatch
- request size accounting with a hard cap such as `1_048_576`
- explicit error logs for invalid signature and oversized payload
- stable response codes and JSON payloads

- [ ] **Step 6: Re-run the focused tests and verify they pass**

Run:
- `pnpm vitest run tests/unit/sign.test.ts`
- `pnpm vitest run tests/unit/http-receiver.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the HTTP ingress hardening**

```bash
git add src/http-receiver.ts src/signature.ts tests/unit/http-receiver.test.ts tests/unit/sign.test.ts
git commit -m "fix: harden dingtalk http callback ingress"
```

### Task 3: Reuse dedup and inflight protection across Stream and HTTP

**Files:**
- Create: `src/inbound-dispatch-guard.ts`
- Modify: `src/channel.ts`
- Modify: `src/http-receiver.ts`
- Test: `tests/integration/gateway-inbound-flow.test.ts`
- Test: `tests/unit/http-receiver.test.ts`

- [ ] **Step 1: Write a focused HTTP duplicate test**

Add a test in `tests/unit/http-receiver.test.ts` that posts the same `msgId` twice and expects the second request to return success but skip `handleDingTalkMessage()`.

- [ ] **Step 2: Write a focused retry-on-failure test**

Add a test that makes `handleDingTalkMessage()` fail once, then retry the same `msgId`, and verify the second attempt is still processed. This preserves the existing Stream behavior.

- [ ] **Step 3: Run the receiver tests and verify they fail**

Run: `pnpm vitest run tests/unit/http-receiver.test.ts`
Expected: FAIL because HTTP currently bypasses dedup and in-flight protection.

- [ ] **Step 4: Extract the reusable guard**

Create `src/inbound-dispatch-guard.ts` with one helper that:
- derives `dedupKey` from `robotCode || clientId || accountId` and `msgId`
- checks `isMessageProcessed()`
- manages the existing in-flight TTL map behavior
- calls `handleDingTalkMessage()`
- only marks processed after successful completion

Suggested shape:

```ts
export async function guardedDispatchInboundMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  data: DingTalkInboundMessage;
  dingtalkConfig: DingTalkConfig;
  log?: Logger;
  onDuplicate?: () => void;
  onInFlightDuplicate?: () => void;
  onNoMessageId?: () => void;
  onProcessed?: () => void;
})
```

- [ ] **Step 5: Switch Stream mode to the shared guard without behavior drift**

Replace the duplicate inline logic in `src/channel.ts` with the shared helper, keeping existing counters and ACK behavior intact.

- [ ] **Step 6: Switch HTTP mode to the shared guard**

Update `src/http-receiver.ts` to call the same helper after request validation succeeds.

- [ ] **Step 7: Re-run focused duplicate tests**

Run:
- `pnpm vitest run tests/unit/http-receiver.test.ts`
- `pnpm vitest run tests/integration/gateway-inbound-flow.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the shared dedup/inflight guard**

```bash
git add src/inbound-dispatch-guard.ts src/channel.ts src/http-receiver.ts tests/unit/http-receiver.test.ts tests/integration/gateway-inbound-flow.test.ts
git commit -m "refactor: share inbound dispatch guard between stream and http"
```

### Task 4: Make the HTTP/card compatibility explicit and merge-safe

**Files:**
- Modify: `src/channel.ts`
- Modify: `src/card-service.ts`
- Modify: `README.md`
- Modify: `docs/connection-troubleshooting.md`
- Test: `tests/integration/gateway-start-flow.test.ts`

- [ ] **Step 1: Decide the merge-safe scope**

Use this rule:
- if DingTalk HTTP card callback semantics can be proven and implemented quickly, do that in a follow-up branch
- for this PR, assume HTTP mode is `markdown`-safe first and do not ship implied card-interaction parity

- [ ] **Step 2: Write a failing startup/behavior test for HTTP + card mode**

Add a test in `tests/integration/gateway-start-flow.test.ts` that starts an HTTP-mode account with `messageType: "card"` and expects one of:
- a startup warning plus forced markdown fallback, or
- a fast startup error explaining the unsupported combination

- [ ] **Step 3: Run the focused start-flow test and verify it fails**

Run: `pnpm vitest run tests/integration/gateway-start-flow.test.ts`
Expected: FAIL because current code neither blocks nor warns on the unsupported combination.

- [ ] **Step 4: Implement the explicit compatibility policy**

Recommended merge-safe behavior:
- in HTTP mode, detect `messageType === "card"`
- log a high-signal warning
- force reply mode to markdown for now
- update any capability wording that currently implies full card parity

Optional follow-up note in code:

```ts
// TODO(pr-followup): support DingTalk HTTP card callbacks end-to-end before
// advertising parity with Stream mode.
```

- [ ] **Step 5: Re-run the focused test**

Run: `pnpm vitest run tests/integration/gateway-start-flow.test.ts`
Expected: PASS.

- [ ] **Step 6: Document the temporary limitation**

Update `README.md` and `docs/connection-troubleshooting.md` to state:
- HTTP mode is intended for multi-instance inbound delivery
- request signing is required
- multi-account HTTP needs unique ports
- card interaction parity is not part of this PR unless a follow-up lands

- [ ] **Step 7: Commit the compatibility decision**

```bash
git add src/channel.ts src/card-service.ts README.md docs/connection-troubleshooting.md tests/integration/gateway-start-flow.test.ts
git commit -m "docs: narrow dingtalk http mode scope for safe merge"
```

### Task 5: Add multi-account startup validation and operator guidance

**Files:**
- Modify: `src/channel.ts`
- Modify: `src/onboarding.ts`
- Modify: `README.md`
- Test: `tests/integration/channel-config-status.test.ts`
- Test: `tests/integration/gateway-start-flow.test.ts`

- [ ] **Step 1: Write a failing multi-account conflict test**

Add a test that configures multiple HTTP-mode accounts with the same `httpPort` and expects a fast, descriptive error before `listen()` is attempted.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:
- `pnpm vitest run tests/integration/gateway-start-flow.test.ts`
- `pnpm vitest run tests/integration/channel-config-status.test.ts`

Expected: FAIL because there is no port-collision validation or user-facing guidance today.

- [ ] **Step 3: Implement port-collision validation**

In `src/channel.ts`, before starting an HTTP listener:
- inspect all resolved DingTalk accounts
- collect `httpPort` for accounts with `mode === "http"`
- throw a descriptive error when more than one enabled account resolves to the same port

- [ ] **Step 4: Update onboarding/operator messaging**

Adjust `src/onboarding.ts` and `README.md` so setup text no longer says only “Stream mode”; it should mention:
- Stream mode for simple/private deployments
- HTTP mode for reverse-proxy / multi-instance deployments
- unique port requirement for multiple local HTTP listeners

- [ ] **Step 5: Re-run the focused tests**

Run:
- `pnpm vitest run tests/integration/gateway-start-flow.test.ts`
- `pnpm vitest run tests/integration/channel-config-status.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the startup validation and docs**

```bash
git add src/channel.ts src/onboarding.ts README.md tests/integration/gateway-start-flow.test.ts tests/integration/channel-config-status.test.ts
git commit -m "fix: validate dingtalk http listener ports"
```

### Task 6: Final verification and PR hygiene

**Files:**
- Modify: `README.md`
- Modify: PR description / review thread (GitHub, no file)

- [ ] **Step 1: Run the full repository verification**

Run:
- `pnpm test`
- `pnpm run type-check`
- `pnpm run lint`

Expected:
- tests: PASS
- type-check: PASS
- lint: no new errors; warnings count does not increase because of this work

- [ ] **Step 2: Manually verify the documented operator path**

Check that docs now answer:
- how to enable HTTP mode
- what reverse-proxy path to expose
- what headers/signing are required
- why card mode is temporarily narrowed or what follow-up implements it
- how to avoid multi-account port conflicts

- [ ] **Step 3: Update the PR conversation**

Post a concise follow-up comment summarizing:
- which review items are fixed
- whether card mode was narrowed or fully implemented
- what risks remain
- exact verification command results

- [ ] **Step 4: Final commit if docs or copy changed during verification**

```bash
git add README.md docs/connection-troubleshooting.md
git commit -m "docs: finalize dingtalk http callback rollout guidance"
```

## Recommended execution order

1. Task 1
2. Task 2
3. Task 3
4. Task 4
5. Task 5
6. Task 6

## Scope note

This plan deliberately optimizes for a safe merge of PR #380, not for perfect feature parity. The recommended path is:
- merge a hardened HTTP inbound mode with explicit limitations
- open a dedicated follow-up for full HTTP card-callback parity once the DingTalk callback contract is verified end-to-end
