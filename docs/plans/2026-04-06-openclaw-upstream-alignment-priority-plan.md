# OpenClaw Upstream Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the DingTalk plugin with the most relevant OpenClaw upstream changes from `v2026.3.31` through `v2026.4.5`, prioritizing behavior correctness over speculative feature adoption.

**Architecture:** Keep this alignment small and behavior-focused. First close the two direct user-facing gaps introduced by newer host behavior: `audioAsVoice` compatibility and `contextVisibility` config exposure. Then remove low-risk routing debt and add docs/tests so future host upgrades are easier to reason about.

**Tech Stack:** TypeScript, Zod, OpenClaw plugin SDK, Vitest, JSON manifest metadata

---

## Priority Summary

### P0

- `audioAsVoice` 兼容修复
- `contextVisibility` schema / manifest / onboarding / docs 对齐

### P1

- sub-agent session-key fallback 清理
- 宿主版本行为变更文档补充

### P2

- `runtime.taskFlow` 采用评估或显式暂缓说明

### P2 Decision Frame

- Option A: 暂不采用 TaskFlow，只记录后续触发条件
- Option B: 仅把 AI Card run / stop lifecycle 迁到 TaskFlow
- Option C: reply 主路径全面 TaskFlow 化

Recommendation:

- 本计划只要求完成 Option A 或 Option B 的决策，不直接推进 Option C。

## File Map

### Behavior / runtime

- Modify: `src/channel.ts`
  - 对齐 outbound adapter 的音频语义读取。
- Modify: `src/inbound-handler.ts`
  - 对齐 reply runtime 到 DingTalk 的媒体/语音桥接。
- Modify: `src/targeting/agent-routing.ts`
  - 收敛 sub-agent session-key helper 使用。

### Config surfaces

- Modify: `src/config-schema.ts`
  - 新增 `contextVisibility` 顶层与 account-scoped 支持。
- Modify: `openclaw.plugin.json`
  - 把 `contextVisibility` 暴露到 `channelConfigs.dingtalk` 与账号子 schema。
- Modify: `src/onboarding.ts`
  - 在 setup flow 中给出最小可用的 `contextVisibility` 引导或说明。

### Tests

- Modify: `tests/unit/config-schema.test.ts`
- Modify: `tests/unit/plugin-manifest.test.ts`
- Modify: `tests/unit/message-actions.test.ts`
- Modify: `tests/unit/inbound-handler.test.ts`
- Modify: `tests/integration/send-media-flow.test.ts`
- Optional modify: `tests/unit/sdk-import-structure.test.ts`

### Docs

- Modify: `docs/user/`
  - 新增或补充用户侧配置说明。
- Modify: `docs/contributor/`
  - 如有需要，补宿主版本行为说明。

## Task 1: Lock The Current Upstream Alignment In Tests

**Files:**

- Modify: `tests/unit/config-schema.test.ts`
- Modify: `tests/unit/plugin-manifest.test.ts`
- Modify: `tests/unit/message-actions.test.ts`
- Modify: `tests/unit/inbound-handler.test.ts`
- Modify: `tests/integration/send-media-flow.test.ts`

- [ ] **Step 1: Add a failing schema regression for `contextVisibility`**

Add coverage that asserts `DingTalkConfigSchema` accepts:

```ts
{
  contextVisibility: "allowlist_quote",
  accounts: {
    main: {
      contextVisibility: "allowlist",
    },
  },
}
```

- [ ] **Step 2: Add a failing manifest regression for `contextVisibility`**

Assert both top-level and account-level manifest schema expose:

```ts
expect(manifest.channelConfigs?.dingtalk?.schema?.properties?.contextVisibility).toBeDefined();
expect(
  manifest.channelConfigs?.dingtalk?.schema?.properties?.accounts?.additionalProperties?.properties
    ?.contextVisibility,
).toBeDefined();
```

- [ ] **Step 3: Add a failing outbound adapter regression for shared voice semantics**

In `tests/unit/message-actions.test.ts`, add a case proving DingTalk outbound `sendMedia` works when the host passes `audioAsVoice: true`, not only `asVoice`.

- [ ] **Step 4: Add a failing reply-bridge regression for runtime media voice payloads**

In `tests/unit/inbound-handler.test.ts`, add a case where reply payload carries:

```ts
{ mediaUrl: "file:///tmp/clip.mp3", audioAsVoice: true }
```

Expected:

- DingTalk resolves media type as `voice`
- DingTalk does not silently downgrade to plain file

- [ ] **Step 5: Add or extend an integration path for media send voice compatibility**

In `tests/integration/send-media-flow.test.ts`, assert the final `sendProactiveMedia` call receives `voice` when upstream context sets the shared voice flag.

- [ ] **Step 6: Run the targeted failing tests**

Run:

```bash
pnpm vitest run tests/unit/config-schema.test.ts tests/unit/plugin-manifest.test.ts tests/unit/message-actions.test.ts tests/unit/inbound-handler.test.ts tests/integration/send-media-flow.test.ts
```

Expected:

- `contextVisibility` assertions fail before implementation.
- `audioAsVoice` assertions fail before implementation.

- [ ] **Step 7: Commit the test-only baseline**

```bash
git add tests/unit/config-schema.test.ts tests/unit/plugin-manifest.test.ts tests/unit/message-actions.test.ts tests/unit/inbound-handler.test.ts tests/integration/send-media-flow.test.ts
git commit -m "test: capture upstream alignment regressions"
```

## Task 2: Align `contextVisibility` With Host Support

**Files:**

- Modify: `src/config-schema.ts`
- Modify: `openclaw.plugin.json`
- Modify: `src/onboarding.ts`
- Test: `tests/unit/config-schema.test.ts`
- Test: `tests/unit/plugin-manifest.test.ts`

- [ ] **Step 1: Extend runtime config schema**

Add `contextVisibility` to the DingTalk account config shape with:

```ts
z.enum(["all", "allowlist", "allowlist_quote"]).optional()
```

Apply it both:

- on the top-level DingTalk config
- inside `accounts.*`

- [ ] **Step 2: Extend manifest schema**

Add `contextVisibility` to:

- `channelConfigs.dingtalk.schema.properties`
- `channelConfigs.dingtalk.schema.properties.accounts.additionalProperties.properties`

Use the same enum:

```json
["all", "allowlist", "allowlist_quote"]
```

- [ ] **Step 3: Add `uiHints` copy if the field is surfaced in UI**

If `openclaw.plugin.json` already contains DingTalk UI hints, add a short description clarifying:

- `all`: preserve current behavior
- `allowlist`: filter supplemental context
- `allowlist_quote`: keep explicit quote/reply context only

- [ ] **Step 4: Update onboarding with the smallest safe surface**

Do one of the following, but not both:

- either add a simple select prompt for `contextVisibility`
- or add a note that this advanced option is host-supported and should be set manually

Recommendation:

- prefer a short note in this pass unless prompt expansion is clearly valuable

- [ ] **Step 5: Run the focused config tests**

Run:

```bash
pnpm vitest run tests/unit/config-schema.test.ts tests/unit/plugin-manifest.test.ts tests/unit/onboarding.test.ts
```

Expected:

- all pass

- [ ] **Step 6: Commit the config-surface alignment**

```bash
git add src/config-schema.ts openclaw.plugin.json src/onboarding.ts tests/unit/config-schema.test.ts tests/unit/plugin-manifest.test.ts tests/unit/onboarding.test.ts
git commit -m "feat(config): expose dingtalk context visibility"
```

## Task 3: Align Shared `audioAsVoice` Semantics

**Files:**

- Modify: `src/channel.ts`
- Modify: `src/inbound-handler.ts`
- Test: `tests/unit/message-actions.test.ts`
- Test: `tests/unit/inbound-handler.test.ts`
- Test: `tests/integration/send-media-flow.test.ts`

- [ ] **Step 1: Update outbound adapter argument parsing**

In `src/channel.ts`, make `sendMedia` accept both:

- `audioAsVoice`
- `asVoice`

Use shared host semantics first, then fall back to legacy alias.

- [ ] **Step 2: Keep legacy compatibility**

Do not remove `asVoice` support. Normalize the two fields into one internal boolean.

- [ ] **Step 3: Update reply-runtime media delivery bridge**

In `src/inbound-handler.ts`, when translating reply payloads into DingTalk media sends, preserve `audioAsVoice` and pass it into `resolveOutboundMediaType(...)`.

- [ ] **Step 4: Keep extension-based fallback as a safety net**

Do not remove file-extension detection in `src/media-utils.ts`; it should remain the secondary safety layer, not the primary contract.

- [ ] **Step 5: Run the focused media tests**

Run:

```bash
pnpm vitest run tests/unit/message-actions.test.ts tests/unit/inbound-handler.test.ts tests/integration/send-media-flow.test.ts
```

Expected:

- all pass
- voice sends use `voice` explicitly when host payload sets the shared flag

- [ ] **Step 6: Run full test suite**

Run:

```bash
pnpm test
```

Expected:

- full suite passes

- [ ] **Step 7: Commit the voice-semantics fix**

```bash
git add src/channel.ts src/inbound-handler.ts tests/unit/message-actions.test.ts tests/unit/inbound-handler.test.ts tests/integration/send-media-flow.test.ts
git commit -m "fix(media): honor shared audioAsVoice semantics"
```

## Task 4: Remove Sub-Agent Session-Key Fallback Debt

**Files:**

- Modify: `src/targeting/agent-routing.ts`
- Test: `tests/unit/targeting/dm-subagent-routing.test.ts`
- Optional test: `tests/unit/sdk-import-structure.test.ts`

- [ ] **Step 1: Verify current SDK helper path**

Prefer importing or routing through the stable SDK session-key helper instead of checking `rt.channel.routing.buildAgentSessionKey` dynamically.

- [ ] **Step 2: Replace fallback string concatenation**

Remove or minimize this branch:

```ts
return `${fallbackRoute.sessionKey}:subagent:${agentId}`;
```

Only keep a fallback if the current supported host floor can genuinely require it.

- [ ] **Step 3: Add routing regression coverage**

Assert sub-agent session keys still:

- isolate by `agentId`
- preserve DM/group peer identity
- do not regress slash-command bypass behavior

- [ ] **Step 4: Run routing-focused tests**

Run:

```bash
pnpm vitest run tests/unit/targeting/dm-subagent-routing.test.ts tests/unit/sdk-import-structure.test.ts
```

Expected:

- all pass

- [ ] **Step 5: Commit the routing cleanup**

```bash
git add src/targeting/agent-routing.ts tests/unit/targeting/dm-subagent-routing.test.ts tests/unit/sdk-import-structure.test.ts
git commit -m "refactor(routing): drop dingtalk subagent session fallback"
```

## Task 5: Document Host-Version-Aware Behavior

**Files:**

- Modify: `docs/user/` relevant DingTalk config page(s)
- Modify: `docs/contributor/` relevant architecture or compatibility page(s)

- [ ] **Step 1: Document `contextVisibility` behavior**

Add a short user-facing note covering:

- what the field does
- why `allowlist_quote` is often the safest advanced mode
- how it differs from DingTalk `displayNameResolution`

- [ ] **Step 2: Document host-version-dependent behavior**

Add contributor-facing notes for:

- `before_agent_reply` is host-driven and applies automatically on newer hosts
- `audioAsVoice` is the shared outbound voice flag
- `taskFlow` is currently not consumed directly by this plugin

- [ ] **Step 3: Build docs if the touched pages are published**

Run:

```bash
pnpm docs:build
```

Expected:

- docs build succeeds

- [ ] **Step 4: Commit the docs update**

```bash
git add docs
git commit -m "docs: note upstream alignment behavior changes"
```

## Task 6: Evaluate `taskFlow` Adoption And Either Land Or Defer Explicitly

**Files:**

- Modify: `docs/spec/2026-04-06-openclaw-upstream-2026-3-31-to-2026-4-5-impact-design.md`
- Optional modify: contributor docs if needed

- [ ] **Step 1: Check whether any current DingTalk pain point needs `runtime.taskFlow`**

Evaluate only these concrete areas:

- async card/media lifecycle
- stop-button orchestration
- long-running media generation follow-up delivery

- [ ] **Step 1.5: Compare the two realistic adoption options**

Write down a short comparison between:

- Option A: defer TaskFlow adoption
- Option B: use TaskFlow only for AI Card run / stop lifecycle

Expected:

- clear statement of benefits
- clear statement of migration cost
- explicit rejection of full reply-lifecycle migration in this plan

- [ ] **Step 2: If no immediate benefit, record explicit deferral**

If Option A wins, document:

- why current reply mainline should stay outside TaskFlow
- why `card-run-registry` debt is not urgent enough for this branch

- [ ] **Step 3: If immediate benefit is discovered, split it into a new dedicated spec/plan**

If Option B wins:

- create a follow-up spec/plan for card lifecycle only
- do not piggyback the implementation onto this alignment branch

- [ ] **Step 4: Commit the evaluation note if changed**

```bash
git add docs/spec/2026-04-06-openclaw-upstream-2026-3-31-to-2026-4-5-impact-design.md docs/contributor
git commit -m "docs: record taskflow alignment decision"
```

## Verification Checklist

- [ ] `pnpm vitest run tests/unit/config-schema.test.ts tests/unit/plugin-manifest.test.ts tests/unit/onboarding.test.ts`
- [ ] `pnpm vitest run tests/unit/message-actions.test.ts tests/unit/inbound-handler.test.ts tests/integration/send-media-flow.test.ts`
- [ ] `pnpm vitest run tests/unit/targeting/dm-subagent-routing.test.ts tests/unit/sdk-import-structure.test.ts`
- [ ] `pnpm test`
- [ ] `pnpm docs:build` if published docs changed

## Exit Criteria

This plan is complete when:

1. DingTalk accepts and advertises `contextVisibility`.
2. DingTalk honors shared `audioAsVoice` semantics directly.
3. Sub-agent routing no longer depends on avoidable session-key fallback glue.
4. Docs clearly separate “宿主自动受益” 和 “插件主动对齐”。
5. `taskFlow` adoption status is explicitly decided instead of left ambiguous.
