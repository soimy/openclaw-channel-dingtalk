# Ask User Route-Safe Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close PR #589's remaining route, delivery-race, test-organization, and real-device validation gaps without changing normal DingTalk reply delivery semantics.

**Architecture:** Bind every Ask User question to the exact resolved Agent route that created it. Real Stream messages resolve all final routes first, synchronously invalidate matching lifecycle scopes, then dispatch while DingTalk card UI updates run best-effort in parallel. Card delivery uses a post-delivery activation gate so a question that became terminal during the HTTP request cannot return to `pending`.

**Tech Stack:** TypeScript, Vitest, AsyncLocalStorage, existing `cards.ask-user.lifecycle` persistence, DingTalk card APIs, OpenClaw channel runtime.

## Global Constraints

- Base all PR comparisons on `a0eb1c1d6affa3fbc8d207107c136748bbbeacc1` or the official upstream `main`; do not use the fork's diverged `origin/main` as the PR base.
- Preserve the single active DingTalk Stream consumer deployment assumption; do not add a distributed lock or external database.
- Persist lifecycle metadata only. Never persist `sessionWebhook`, credentials, runtime config, logger/functions, route snapshots, or user answer bodies.
- `ResolvedDingTalkRoute` is immutable trusted internal data and must never be populated from DingTalk callback payload fields.
- Real Stream messages invalidate matching `reserved`/`pending` records before command handling, media download, Session Lock, or Agent Dispatch.
- Ask User synthetic messages reuse their captured route and must not invalidate themselves.
- Local lifecycle invalidation is a dispatch precondition; DingTalk card UI synchronization is best-effort and must not block normal Agent Dispatch.
- Do not modify `src/send-service.ts`, `src/reply-strategy*.ts`, or ordinary AI Card streaming semantics for this fix.
- Keep every new focused test file below 500 lines; do not reorganize unrelated oversized test files.
- Before DingTalk real-device validation, read `skills/dingtalk-real-device-testing/SKILL.md`, run `pnpm run build:runtime`, and restart the gateway.
- Keep PR #589 Ready for review; do not convert it back to Draft.

---

## File Map

### Production files

- `src/types.ts`: owns the internal `ResolvedDingTalkRoute` contract and `routeOverride` handler parameter.
- `src/card/ask-user-question-context.ts`: captures the route and safe continuation metadata for the question created in the current Agent run.
- `src/card/ask-user-question.ts`: separates local invalidation from UI sync, reuses the captured route for synthetic answers, and enforces the activation gate.
- `src/targeting/agent-routing.ts`: resolves every sub-Agent target before media download or recursive dispatch and passes exact route overrides downstream.
- `src/inbound-handler.ts`: orchestrates two-phase route resolution/invalidation/dispatch and records the route snapshot in AsyncLocal context.

### Test files

- `tests/unit/inbound-handler-ask-user.test.ts`: default/sub-Agent/multi-Agent invalidation and non-blocking normal dispatch.
- `tests/unit/inbound-handler-ask-user-takeover.test.ts`: question-card takeover, recall, and pause-failure reply preservation extracted from the generic card suite.
- `tests/unit/ask-user-question-lifecycle.test.ts`: activation race and captured-route synthetic reinjection.
- `tests/unit/ask-user-question-form.test.ts`: schema and form construction extracted from the oversized generic Ask User suite.
- `tests/unit/ask-user-question-callback.test.ts`: submit, ownership, duplicate callback, and tombstone behavior.
- `tests/unit/ask-user-question-timeout.test.ts`: cancel, empty, and expiry behavior.
- `tests/unit/inbound-handler-card.test.ts`: retains ordinary AI Card delivery coverage only.

### Documentation

- `docs/spec/2026-07-17-ask-user-question-lifecycle-design.md`: authoritative lifecycle and routing design.
- `docs/user/features/form-interactive-card.md`: user-visible invalidation and restart behavior; change only if final behavior differs from the current text.
- PR #589 description: implementation/validation evidence and remaining real-device results.

---

### Task 1: Split Ask User tests without changing behavior

**Files:**

- Create: `tests/unit/inbound-handler-ask-user.test.ts`
- Create: `tests/unit/inbound-handler-ask-user-takeover.test.ts`
- Create: `tests/unit/ask-user-question-form.test.ts`
- Create: `tests/unit/ask-user-question-callback.test.ts`
- Create: `tests/unit/ask-user-question-timeout.test.ts`
- Modify: `tests/unit/inbound-handler-card.test.ts`
- Delete: `tests/unit/ask-user-question.test.ts`

**Interfaces:**

- Consumes: existing public test helpers from `src/card/ask-user-question.ts`.
- Produces: green focused suites below 500 lines each, ready for behavior-first tests in later tasks.

- [ ] **Step 1: Extract the two existing inbound invalidation tests**

  Move the tests currently named:

  ```text
  invalidates the same-scope Ask User card before dispatching a newer real message
  does not invalidate the question card for its own synthetic answer
  ```

  into `tests/unit/inbound-handler-ask-user.test.ts`. Copy only the mocks required by those tests and keep the production import as:

  ```ts
  import { handleDingTalkMessage } from "../../src/inbound-handler";
  ```

- [ ] **Step 2: Extract existing takeover tests**

  Move these tests from `inbound-handler-card.test.ts` into `inbound-handler-ask-user-takeover.test.ts`:

  ```text
  suppresses normal AI replies after a DingTalk question card successfully takes over the turn
  still suppresses normal AI replies when question card takeover cannot recall the existing AI card
  still takes over when AI card recall throws after targeted pause succeeds
  keeps the normal AI reply path when a DingTalk question card is not sent successfully
  keeps the normal AI reply path when targeted pause fails after the question card is sent
  ```

  Keep the exact assertions around `dispatchDingTalkCardStopCommand`, `recallAICardMessage`, `commitAICardBlocks`, and markdown fallback delivery.

- [ ] **Step 3: Split the generic Ask User suite by responsibility**

  Place the existing describes as follows:

  ```text
  ask-user-question-form.test.ts
    AskUserQuestionSchema
    buildQuestionFormFromFields
    buildQuestionForm
    parseAskUserCardCallback

  ask-user-question-callback.test.ts
    same-scope supersede
    owner rejection
    normal submit and duplicate callback

  ask-user-question-timeout.test.ts
    cancel
    expiry
    optional-field empty submit
  ```

  Every file must retain this cleanup:

  ```ts
  afterEach(() => {
    vi.useRealTimers();
    clearPendingQuestionsForTest();
    vi.clearAllMocks();
  });
  ```

- [ ] **Step 4: Run the extracted suites and confirm no behavior changed**

  Run:

  ```bash
  pnpm vitest run \
    tests/unit/inbound-handler-card.test.ts \
    tests/unit/inbound-handler-ask-user.test.ts \
    tests/unit/inbound-handler-ask-user-takeover.test.ts \
    tests/unit/ask-user-question-form.test.ts \
    tests/unit/ask-user-question-callback.test.ts \
    tests/unit/ask-user-question-timeout.test.ts
  ```

  Expected: all moved tests pass; each new file is below 500 lines.

- [ ] **Step 5: Commit the behavior-neutral split**

  ```bash
  git add tests/unit
  git commit -m "test(card): isolate ask-user lifecycle coverage"
  ```

---

### Task 2: Capture and replay the exact resolved route

**Files:**

- Modify: `src/types.ts`
- Modify: `src/card/ask-user-question-context.ts`
- Modify: `src/card/ask-user-question.ts`
- Modify: `src/inbound-handler.ts`
- Test: `tests/unit/ask-user-question-lifecycle.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export interface ResolvedDingTalkRoute {
    agentId: string;
    sessionKey: string;
    mainSessionKey: string;
  }
  ```

  `HandleDingTalkMessageParams.routeOverride?: ResolvedDingTalkRoute` and runtime-only route fields on `DingTalkQuestionContext`.

- [ ] **Step 1: Write a failing synthetic-route test**

  Register a pending sub-Agent question with:

  ```ts
  resolvedRoute: {
    agentId: "expert",
    sessionKey: "agent:expert:dingtalk:direct:user_1",
    mainSessionKey: "",
  },
  continuationSubAgentOptions: {
    agentId: "expert",
    responsePrefix: "> 🤖 **Expert**:\n\n",
    matchedName: "Expert",
  },
  ```

  Submit the callback and assert the mocked `handleDingTalkMessage` receives:

  ```ts
  expect.objectContaining({
    inboundOrigin: "ask-user",
    routeOverride: {
      agentId: "expert",
      sessionKey: "agent:expert:dingtalk:direct:user_1",
      mainSessionKey: "",
    },
    subAgentOptions: expect.objectContaining({
      agentId: "expert",
      matchedName: "Expert",
    }),
  });
  ```

  Also assert `subAgentOptions.commandText` is `undefined`.

- [ ] **Step 2: Run the focused test and confirm RED**

  Run:

  ```bash
  pnpm vitest run tests/unit/ask-user-question-lifecycle.test.ts
  ```

  Expected: failure because the synthetic call currently has no `routeOverride`.

- [ ] **Step 3: Add the route contracts**

  Add to `src/types.ts`:

  ```ts
  export interface ResolvedDingTalkRoute {
    agentId: string;
    sessionKey: string;
    mainSessionKey: string;
  }

  export interface HandleDingTalkMessageParams {
    // existing fields
    routeOverride?: ResolvedDingTalkRoute;
  }
  ```

  Add to `DingTalkQuestionContext`:

  ```ts
  resolvedRoute?: ResolvedDingTalkRoute;
  continuationSubAgentOptions?: Omit<SubAgentOptions, "commandText">;
  ```

- [ ] **Step 4: Capture only safe continuation metadata**

  After `inbound-handler.ts` has the final `route`, write:

  ```ts
  if (questionContext) {
    questionContext.resolvedRoute = route;
    questionContext.questionScopeKey = `${accountId}:${route.sessionKey}:${senderId}`;
    questionContext.storePath = accountStorePath;
    questionContext.continuationSubAgentOptions = subAgentOptions
      ? {
          agentId: subAgentOptions.agentId,
          responsePrefix: subAgentOptions.responsePrefix,
          matchedName: subAgentOptions.matchedName,
        }
      : undefined;
  }
  ```

  Do not copy `commandText` because a card answer is content, not a replay of the command that opened the Agent run.

- [ ] **Step 5: Replay the snapshot during synthetic reinjection**

  Extend `injectAnswerSyntheticMessage`:

  ```ts
  await handleDingTalkMessage({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    data: syntheticData,
    sessionWebhook: ctx.sessionWebhook,
    log: ctx.log,
    dingtalkConfig: ctx.dingtalkConfig,
    inboundOrigin: "ask-user",
    routeOverride: ctx.resolvedRoute,
    subAgentOptions: ctx.continuationSubAgentOptions,
  });
  ```

  In `handleDingTalkMessageInner`, choose the route in this order:

  ```ts
  const route =
    routeOverride ??
    (subAgentOptions
      ? build the existing sub-Agent route
      : rt.channel.routing.resolveAgentRoute(...));
  ```

- [ ] **Step 6: Run tests and confirm GREEN**

  Run:

  ```bash
  pnpm vitest run \
    tests/unit/ask-user-question-lifecycle.test.ts \
    tests/unit/inbound-handler-ask-user.test.ts \
    tests/unit/inbound-handler-subagent.test.ts
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add src/types.ts src/card/ask-user-question-context.ts src/card/ask-user-question.ts src/inbound-handler.ts tests/unit/ask-user-question-lifecycle.test.ts
  git commit -m "fix(card): bind ask-user answers to resolved routes"
  ```

---

### Task 3: Separate local invalidation from card UI synchronization

**Files:**

- Modify: `src/card/ask-user-question.ts`
- Modify: `src/inbound-handler.ts`
- Test: `tests/unit/ask-user-question-lifecycle.test.ts`
- Test: `tests/unit/inbound-handler-ask-user.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export function invalidateAskUserQuestionsForScope(params: {
    storePath: string;
    accountId: string;
    questionScopeKey: string;
    reason: "superseded_by_message";
    log?: Logger;
  }): AskUserLifecycleRecord[];

  export async function syncInvalidatedAskUserQuestionCards(params: {
    records: AskUserLifecycleRecord[];
    config: DingTalkConfig;
    log?: Logger;
  }): Promise<void>;
  ```

- [ ] **Step 1: Write failing non-blocking dispatch tests**

  In `inbound-handler-ask-user.test.ts`, make `syncInvalidatedAskUserQuestionCards` return a deferred promise. Assert this order before resolving it:

  ```ts
  expect(order).toEqual(["invalidate-local", "sync-start", "dispatch"]);
  expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  ```

  Add a second test where UI sync rejects and assert the ordinary Agent dispatcher still runs once.

- [ ] **Step 2: Run the focused test and confirm RED**

  ```bash
  pnpm vitest run tests/unit/inbound-handler-ask-user.test.ts
  ```

  Expected: the current combined invalidation awaits card network completion before dispatch.

- [ ] **Step 3: Make local invalidation synchronous**

  Change `invalidateAskUserQuestionsForScope` so it only:

  ```ts
  const invalidated = invalidateAskUserQuestionsInStore(...);
  for (const record of invalidated) {
    consumeLifecyclePendingContext(record);
  }
  return invalidated;
  ```

  It must not call `getAccessToken`, `updateCardVariables`, or await a Promise.

- [ ] **Step 4: Add parallel best-effort UI synchronization**

  Implement:

  ```ts
  export async function syncInvalidatedAskUserQuestionCards(params: {
    records: AskUserLifecycleRecord[];
    config: DingTalkConfig;
    log?: Logger;
  }): Promise<void> {
    await Promise.allSettled(
      params.records.map((record) =>
        updateLifecycleRecordCardBestEffort({
          record,
          config: params.config,
          log: params.log,
        }),
      ),
    );
  }
  ```

  Start it from the inbound handler without awaiting before dispatch:

  ```ts
  const records = invalidateAskUserQuestionsForScope(...);
  void syncInvalidatedAskUserQuestionCards({ records, config: dingtalkConfig, log }).catch(
    (error) => log?.warn?.(`[DingTalk][AskUser] Card invalidation sync failed: ${String(error)}`),
  );
  ```

- [ ] **Step 5: Update lifecycle integration expectations**

  Tests that assert card variables must now call local invalidation followed by `syncInvalidatedAskUserQuestionCards`. Tests that only assert state transition call local invalidation alone.

- [ ] **Step 6: Run tests and confirm GREEN**

  ```bash
  pnpm vitest run \
    tests/unit/ask-user-question-lifecycle.test.ts \
    tests/unit/inbound-handler-ask-user.test.ts
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add src/card/ask-user-question.ts src/inbound-handler.ts tests/unit/ask-user-question-lifecycle.test.ts tests/unit/inbound-handler-ask-user.test.ts
  git commit -m "fix(inbound): decouple ask-user invalidation UI sync"
  ```

---

### Task 4: Resolve all sub-Agent routes before invalidation and dispatch

**Files:**

- Modify: `src/targeting/agent-routing.ts`
- Modify: `src/inbound-handler.ts`
- Test: `tests/unit/inbound-handler-ask-user.test.ts`

**Interfaces:**

- Consumes: `ResolvedDingTalkRoute`, `ResolvedDingTalkSessionPeer`, and the synchronous invalidation API from Task 3.
- Produces:

  ```ts
  export interface ResolvedSubAgentTarget {
    agent: AgentNameMatch;
    route: ResolvedDingTalkRoute;
  }
  ```

  `dispatchSubAgents` accepts `sessionPeer` and an optional synchronous `onRoutesResolved` hook.

- [ ] **Step 1: Add failing route-matrix tests**

  Cover these exact cases:

  ```text
  @expert content        -> invalidate expert scope only
  @expert /new           -> invalidate expert scope only
  @agent1 @agent2 text   -> invalidate both scopes before first dispatch
  unmatched @name        -> fall through and invalidate default scope
  synthetic answer       -> invalidate no scope
  missing host helper    -> show existing warning and invalidate no invented scope
  ```

  For the multi-Agent case, have `buildAgentSessionKey` return a session key derived from `agentId` and assert:

  ```ts
  expect(order).toEqual([
    "invalidate:main:agent:agent1:user_1",
    "invalidate:main:agent:agent2:user_1",
    "dispatch:agent1",
    "dispatch:agent2",
  ]);
  ```

- [ ] **Step 2: Run the focused suite and confirm RED**

  ```bash
  pnpm vitest run tests/unit/inbound-handler-ask-user.test.ts
  ```

  Expected: the existing outer call invalidates the default scope and recursive calls skip the actual sub-Agent scope.

- [ ] **Step 3: Pre-resolve targets inside `dispatchSubAgents`**

  Extend the function parameters:

  ```ts
  sessionPeer: ResolvedDingTalkSessionPeer;
  onRoutesResolved?: (targets: readonly ResolvedSubAgentTarget[]) => void;
  ```

  Before media download, compute:

  ```ts
  const rt = getDingTalkRuntime();
  const resolvedTargets = matchedAgents.map((agent) => ({
    agent,
    route: {
      agentId: agent.agentId,
      sessionKey: buildAgentSessionKey({
        rt,
        cfg,
        accountId,
        agentId: agent.agentId,
        peerKind: sessionPeer.kind,
        peerId: sessionPeer.peerId,
      }),
      mainSessionKey: "",
    },
  }));
  onRoutesResolved?.(resolvedTargets);
  ```

  Preserve the current one-time user warning when `HostRoutingHelperUnavailableError` is thrown. In that case return before media download and before `onRoutesResolved`.

- [ ] **Step 4: Dispatch using the exact pre-resolved route**

  Iterate `resolvedTargets` sequentially and pass:

  ```ts
  routeOverride: target.route,
  subAgentOptions: {
    agentId: target.agent.agentId,
    responsePrefix: commandText
      ? ""
      : `> 🤖 **${sanitizeAgentName(target.agent.matchedName)}**:\n\n`,
    matchedName: target.agent.matchedName,
    commandText,
  },
  ```

  Keep media pre-download once per outer message.

- [ ] **Step 5: Move invalidation to the final route boundary**

  In `inbound-handler.ts`:

  1. Resolve `messageTarget`.
  2. For sub-Agent targets, call `dispatchSubAgents` with `sessionPeer` and `onRoutesResolved`.
  3. In `onRoutesResolved`, deduplicate `sessionKey`, synchronously invalidate all resulting scope keys, and schedule UI sync.
  4. Return after sub-Agent dispatch.
  5. Only then resolve/invalidate the default route for messages that actually fall through to default.

  Keep recursive sub-Agent invalidation disabled because the outer preflight owns it. Keep `inboundOrigin === "ask-user"` disabled for both default and sub-Agent invalidation.

- [ ] **Step 6: Run focused routing and ordinary-send regressions**

  ```bash
  pnpm vitest run \
    tests/unit/inbound-handler-ask-user.test.ts \
    tests/unit/inbound-handler-subagent.test.ts \
    tests/unit/inbound-handler-commands.test.ts \
    tests/unit/inbound-handler-media.test.ts \
    tests/unit/inbound-handler-abort.test.ts
  ```

  Expected: all pass; sub-Agents remain sequential; `/stop` still bypasses the Session Lock; media downloads once.

- [ ] **Step 7: Commit**

  ```bash
  git add src/targeting/agent-routing.ts src/inbound-handler.ts tests/unit/inbound-handler-ask-user.test.ts
  git commit -m "fix(targeting): invalidate ask-user cards on final routes"
  ```

---

### Task 5: Add the post-delivery activation gate

**Files:**

- Modify: `src/card/ask-user-question.ts`
- Test: `tests/unit/ask-user-question-lifecycle.test.ts`

**Interfaces:**

- Consumes: `activateAskUserQuestion`, which returns `{ record, superseded }`.
- Produces: a tool result can be `pending` only when `activation.record.state === "pending"`.

- [ ] **Step 1: Write the failing delivery-race test**

  Make the mocked `createAndDeliver` request wait on a deferred promise. Start tool execution, read the reserved record from the lifecycle store, invalidate its scope as `superseded_by_message`, then resolve delivery successfully.

  Assert:

  ```ts
  expect(result.details.status).toBe("failed");
  expect(resolveAskUserQuestion(store, { questionId })).toMatchObject({
    state: "terminal",
    terminalReason: "superseded_by_message",
  });
  expect(onQuestionCardSent).not.toHaveBeenCalled();
  ```

  Submit a callback for the delivered `outTrackId` and assert `handleDingTalkMessage` is not called.

- [ ] **Step 2: Run the focused test and confirm RED**

  ```bash
  pnpm vitest run tests/unit/ask-user-question-lifecycle.test.ts
  ```

  Expected: the current tool returns `status: pending` even though activation finds a terminal record.

- [ ] **Step 3: Enforce the activation result**

  Keep `storePendingQuestion` immediately before activation with no intervening `await`, then add:

  ```ts
  const activation = activateAskUserQuestion(storeOptions, questionId);
  if (activation.record?.state !== "pending") {
    const terminalReason =
      activation.record?.state === "terminal"
        ? activation.record.terminalReason
        : "superseded_by_message";
    pendingQuestion.submitted = true;
    consumePendingQuestion(pendingQuestion);
    await updateQuestionCardBestEffort(
      pendingQuestion,
      terminalCardVariables(terminalReason ?? "superseded_by_message"),
    );
    return jsonToolResult({
      status: "failed",
      questionId,
      outTrackId,
      error: "问题卡片在发送期间已失效，请重新发起。",
    });
  }
  ```

  Process `activation.superseded` only after the pending-state check. Do not start the takeover hook or leave a TTL timer when the gate fails.

- [ ] **Step 4: Add the missing-record fail-closed test**

  Mock or arrange activation lookup to return no record after successful delivery. Assert a failed result, no takeover hook, no synthetic callback dispatch, and a visible invalid card state.

- [ ] **Step 5: Run lifecycle tests and confirm GREEN**

  ```bash
  pnpm vitest run \
    tests/unit/ask-user-question-store.test.ts \
    tests/unit/ask-user-question-lifecycle.test.ts \
    tests/unit/ask-user-question-callback.test.ts \
    tests/unit/ask-user-question-timeout.test.ts
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add src/card/ask-user-question.ts tests/unit/ask-user-question-lifecycle.test.ts
  git commit -m "fix(card): gate ask-user activation after delivery"
  ```

---

### Task 6: Verify the complete source change and update documentation

**Files:**

- Modify: `docs/spec/2026-07-17-ask-user-question-lifecycle-design.md` only if implementation names differ from the approved interfaces.
- Modify: `docs/user/features/form-interactive-card.md` only if user-visible failure wording changes.
- Review: every file in `git diff a0eb1c1d6affa3fbc8d207107c136748bbbeacc1...HEAD`.

**Interfaces:**

- Consumes: Tasks 1-5.
- Produces: a source-complete, test-complete branch ready for real-device validation.

- [ ] **Step 1: Run focused Ask User and inbound tests**

  ```bash
  pnpm vitest run \
    tests/unit/ask-user-question-store.test.ts \
    tests/unit/ask-user-question-lifecycle.test.ts \
    tests/unit/ask-user-question-form.test.ts \
    tests/unit/ask-user-question-callback.test.ts \
    tests/unit/ask-user-question-timeout.test.ts \
    tests/unit/inbound-handler-ask-user.test.ts \
    tests/unit/inbound-handler-ask-user-takeover.test.ts \
    tests/unit/inbound-handler-subagent.test.ts \
    tests/unit/inbound-handler-abort.test.ts \
    tests/unit/inbound-handler-media.test.ts
  ```

  Expected: all pass with no skipped tests introduced for the new behaviors.

- [ ] **Step 2: Run repository validation**

  ```bash
  git diff --check
  npm run type-check
  npm run lint
  pnpm run build:runtime
  pnpm test
  pnpm docs:build
  node scripts/verify-runtime-package.mjs
  ```

  Expected: type-check/build/tests/docs/package verification pass; lint has zero new errors.

- [ ] **Step 3: Verify normal-message boundaries**

  Inspect the diff and confirm no changes exist in:

  ```text
  src/send-service.ts
  src/reply-strategy.ts
  src/reply-strategy-card.ts
  src/reply-strategy-markdown.ts
  src/reply-strategy-with-reaction.ts
  ```

  Confirm tests prove slow/failed invalidation UI sync does not delay or swallow ordinary Agent dispatch.

- [ ] **Step 4: Verify persisted data remains minimal**

  Search the lifecycle namespace output and production diff:

  ```bash
  rg -n "resolvedRoute|routeOverride|sessionWebhook|clientSecret|answer" src/card/ask-user-question-store.ts tests/unit/ask-user-question-store.test.ts
  ```

  Expected: route snapshots, webhooks, credentials, and answers are absent from persisted lifecycle records.

- [ ] **Step 5: Commit documentation corrections if present**

  ```bash
  git add docs/spec/2026-07-17-ask-user-question-lifecycle-design.md docs/user/features/form-interactive-card.md
  git commit -m "docs(card): finalize ask-user route guarantees"
  ```

  Skip this commit when those files have no remaining diff after the implementation commits.

---

### Task 7: Complete deterministic and real-device validation

**Files:**

- Read: `skills/dingtalk-real-device-testing/SKILL.md`
- Temporary local-only fault injection: `src/card/ask-user-question.ts` or `src/inbound-handler.ts`
- Evidence only: gateway logs, lifecycle namespace JSON, and the target OpenClaw `session.jsonl`

**Interfaces:**

- Consumes: a clean, built Task 6 branch and configured local DingTalk/OpenClaw credentials.
- Produces: evidence for all three reviewer-requested validation gaps without committing fault-injection code or secrets.

- [ ] **Step 1: Prepare the real-device runtime**

  Read the repository skill completely, then run:

  ```bash
  pnpm run build:runtime
  openclaw gateway restart
  ```

  Verify the configured DingTalk account reports `running=true` and `connected=true`. Do not print credentials.

- [ ] **Step 2: Validate group same-session different-user isolation**

  In one DingTalk group, user A and user B each create an Ask User card under the same Agent/session. Have user A send a new ordinary message.

  Confirm:

  ```text
  user A card -> superseded_by_message
  user B card -> remains pending and answerable
  user A late click -> no synthetic inbound
  user B submit -> exactly one continuation in the same group Agent session
  ```

  This step requires a real second DingTalk user. If unavailable, report it as the only remaining merge blocker and do not mark the validation complete.

- [ ] **Step 3: Validate restart during dispatching**

  Apply a local-only delay immediately after callback claim and before `injectAnswerSyntheticMessage`, for example:

  ```ts
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  ```

  Build and restart, submit the card, verify the lifecycle record is `dispatching`, then restart the gateway during the delay. Confirm restart recovery writes `restart_during_dispatch`, updates the card reason, and does not append a duplicate answer to `session.jsonl`.

  Remove the delay, rebuild, and restart before the next scenario. Verify `git diff` contains no fault-injection line.

- [ ] **Step 4: Validate targeted `/stop` failure preserves normal reply**

  Apply a local-only forced error immediately before the targeted stop call:

  ```ts
  throw new Error("e2e forced pause failure");
  ```

  Build and restart, trigger an Ask User question, and confirm:

  ```text
  question card -> terminal(pause_failed)
  question card text -> 当前任务未能暂停，此卡已失效，请重新发起。
  current Agent run -> normal final reply remains visible
  questionCardTookOver -> false
  ```

  Remove the forced error, rebuild, and restart. Verify the worktree is clean except for intended source/docs/test changes.

- [ ] **Step 5: Re-run the normal submit smoke test on the restored build**

  Generate a fresh card, choose an option, confirm no callback is handled until the card's confirm button is clicked, then submit once. Verify exactly one synthetic continuation reaches the captured Agent/session.

---

### Task 8: Push and close the PR review loop

**Files:**

- Update: PR #589 description and maintainer review thread.
- Push: `fix/ask-user-question-lifecycle`.

**Interfaces:**

- Consumes: Tasks 1-7 with all available evidence.
- Produces: updated Ready PR with reviewer findings explicitly resolved.

- [ ] **Step 1: Review the final PR-scoped diff**

  ```bash
  git status --short --branch
  git diff --stat a0eb1c1d6affa3fbc8d207107c136748bbbeacc1...HEAD
  git diff --check a0eb1c1d6affa3fbc8d207107c136748bbbeacc1...HEAD
  ```

  Confirm no credential, temporary E2E injection, unrelated file, or generated local artifact is present.

- [ ] **Step 2: Push the branch**

  ```bash
  git push origin fix/ask-user-question-lifecycle
  ```

- [ ] **Step 3: Update the PR description**

  Keep the English title `fix(card): harden ask-user question lifecycle`. In the Simplified Chinese body, retain the required sections `背景`, `目标`, `实现`, `实现 TODO`, and `验证 TODO`; mark only actually completed source and E2E items complete.

- [ ] **Step 4: Reply to the maintainer review**

  Summarize with direct evidence:

  ```text
  P1：子 Agent content、定向命令和多 Agent 均在最终路由上预失效；synthetic answer 复用 route snapshot。
  P2：Ask User 入站和 takeover 测试已拆分到独立且小于 500 行的文件。
  普通消息：本地状态先失效，卡片 UI 同步不阻塞 Agent dispatch；发送策略文件未修改。
  真机：列出 dispatching restart、同群不同用户、stop failure 和恢复后的正常 submit 证据。
  ```

- [ ] **Step 5: Verify live PR state**

  ```bash
  gh pr view 589 --repo soimy/openclaw-channel-dingtalk --json isDraft,mergeable,state,headRefOid,statusCheckRollup
  gh pr checks 589 --repo soimy/openclaw-channel-dingtalk
  ```

  Expected: PR remains Ready, head SHA matches the pushed branch, required checks pass, and no unresolved requested behavior remains.

---

## Final Acceptance Matrix

| Requirement | Source proof | Automated proof | Real-device proof |
| --- | --- | --- | --- |
| Default new message invalidates old card | default route scope invalidation | focused inbound test | existing newer-message E2E |
| Sub-Agent new message invalidates the correct card | pre-resolved route + route override | content/command/multi-Agent tests | fresh sub-Agent submit smoke |
| Answer returns to the exact original session | runtime route snapshot | synthetic route assertion | target `session.jsonl` |
| Ordinary replies are not delayed by card UI sync | local/UI split | deferred/rejected UI sync tests | normal response observation |
| Delivery race cannot revive terminal card | activation gate | deferred delivery race test | covered deterministically |
| Same group/session users remain isolated | sender in scope key | store/inbound isolation tests | two-user group E2E |
| Restart during answer is fail-closed | restart recovery | lifecycle recovery tests | dispatching restart E2E |
| Pause failure preserves normal reply | takeover remains false | takeover focused test | forced-failure E2E |
| Tests follow repository limits | focused files | line-count check | not applicable |
| No sensitive runtime context is persisted | lifecycle record schema | persistence content assertion | namespace inspection |

