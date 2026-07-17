# Ask User Question Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DingTalk Ask User cards fail closed when a newer real message arrives, the gateway restarts, pausing the current Agent run fails, or synthetic answer dispatch fails.

**Architecture:** Add a persistence-backed lifecycle store in the Card domain while keeping callback-only runtime objects ephemeral. All lifecycle transitions are synchronous from the caller's perspective and persisted atomically; network operations happen after state ownership is established. Real inbound messages invalidate cards before command/session-lock/Agent dispatch, and gateway startup converts unfinished records into terminal tombstones.

**Tech Stack:** TypeScript, Vitest, existing namespace persistence helpers, DingTalk card APIs, OpenClaw channel runtime.

## Global Constraints

- Use namespace `cards.ask-user.lifecycle` and account-scoped persistence.
- Persist only lifecycle metadata; never persist webhook URLs, access tokens, config objects, logger/functions, or user answer bodies.
- Pending cards expire after 5 minutes; terminal tombstones expire after 30 minutes.
- A terminal transition is final. The first valid transition wins.
- New real inbound messages invalidate matching cards before command handling and Agent dispatch.
- Synthetic Ask User answers must not invalidate themselves.
- Gateway restart is fail-closed: unfinished cards become terminal and are visibly updated.
- Preserve callback acknowledgement latency: claim synchronously, launch synthetic dispatch without `setImmediate`, and do not await the Agent run.
- Keep new focused test files below 500 lines.

---

## Task 1: Add the persistent lifecycle state machine

**Files:**

- Create: `src/card/ask-user-question-store.ts`
- Create: `tests/unit/ask-user-question-store.test.ts`

- [ ] Write failing tests for:
  - reserve then activate;
  - only one active card per `questionScopeKey` after activation;
  - claim changes `pending` to `dispatching` exactly once;
  - terminal states cannot be reclaimed;
  - pending and tombstone TTL cleanup;
  - persisted records exclude runtime callback context and answer values;
  - restart recovery maps `reserved`/`pending` to `restart_invalidated` and `dispatching` to `restart_during_dispatch`.

- [ ] Run the focused test and confirm RED:

  `pnpm vitest run tests/unit/ask-user-question-store.test.ts`

- [ ] Implement these public types and operations:

  ```ts
  type AskUserActiveState = "reserved" | "pending" | "dispatching";

  type AskUserTerminalReason =
      | "delivery_failed"
      | "superseded_by_question"
      | "superseded_by_message"
      | "expired"
      | "cancelled"
      | "empty"
      | "submitted"
      | "pause_failed"
      | "restart_invalidated"
      | "restart_during_dispatch"
      | "dispatch_failed";

  interface AskUserLifecycleRecord {
      questionId: string;
      accountId: string;
      questionScopeKey: string;
      outTrackId: string;
      title: string;
      state: AskUserActiveState | "terminal";
      terminalReason?: AskUserTerminalReason;
      createdAt: number;
      updatedAt: number;
      expiresAt: number;
  }
  ```

  Export reserve, activate, claim, terminate, scope invalidation, lookup, restart recovery, and test reset helpers. Use `readNamespaceJson` and `writeNamespaceJsonAtomic` from `src/persistence-store.ts`.

- [ ] Run the focused test and confirm GREEN.

- [ ] Commit:

  `git commit -m "feat(card): add ask-user lifecycle store"`

---

## Task 2: Integrate reserve, activation, callback claiming, and dispatch outcome

**Files:**

- Modify: `src/card/ask-user-question.ts`
- Modify: `src/types.ts`
- Modify: `tests/unit/ask-user-question.test.ts`
- Create: `tests/unit/ask-user-question-lifecycle.test.ts`

- [ ] Add failing tests proving:
  - lifecycle reservation happens before `createAndDeliver`;
  - delivery failure terminates the reservation as `delivery_failed`;
  - a newly delivered card supersedes the previous active card only after successful delivery;
  - duplicate or late callbacks resolve to the persisted tombstone reason;
  - callback claim occurs before answer dispatch;
  - `setImmediate` is no longer used to create an extra scheduling window;
  - successful synthetic dispatch terminates as `submitted`;
  - failed synthetic dispatch terminates as `dispatch_failed` and updates the card with the recovery message.

- [ ] Run focused tests and confirm RED:

  `pnpm vitest run tests/unit/ask-user-question.test.ts tests/unit/ask-user-question-lifecycle.test.ts`

- [ ] Add `storePath` to the Ask User question context and pass it into lifecycle operations.

- [ ] Keep full callback runtime context in an in-memory registry keyed by question/outTrack ID. Store only lifecycle metadata on disk.

- [ ] Reserve before card delivery, mark `delivery_failed` on errors, activate after delivery succeeds, then invalidate the previous pending card as `superseded_by_question`.

- [ ] On callback, atomically claim the record before reading form answers. Return the exact terminal explanation for late callbacks.

- [ ] Launch synthetic dispatch immediately with a handled promise chain. Do not await the Agent run before returning the callback acknowledgement.

- [ ] Use these exact messages:
  - dispatch failed: `回答已收到，但未能继续会话，请发送一条普通消息继续。`
  - expired: retain the existing timeout semantics while persisting `expired`.

- [ ] Run focused tests and confirm GREEN.

- [ ] Commit:

  `git commit -m "fix(card): persist ask-user callback lifecycle"`

---

## Task 3: Invalidate cards on newer real inbound messages

**Files:**

- Modify: `src/inbound-handler.ts`
- Create: `tests/unit/inbound-handler-ask-user.test.ts`

- [ ] Add failing tests proving:
  - a real user message invalidates an active card in the same `questionScopeKey` before command dispatch;
  - the card is updated with `你在问题卡片发出后发送了新消息，此卡已失效。请重新发起需要填写的问题。`;
  - a message in a different scope does not invalidate the card;
  - an Ask User synthetic inbound answer does not invalidate itself;
  - invalidation failure is logged but does not swallow the new real user message.

- [ ] Run and confirm RED:

  `pnpm vitest run tests/unit/inbound-handler-ask-user.test.ts`

- [ ] Add an explicit inbound origin marker such as `stream` versus `ask-user`.

- [ ] After route/session resolution and before command handling, lock acquisition, or Agent dispatch, invalidate pending lifecycle records for the real message's scope and update their cards.

- [ ] Set the synthetic answer origin to `ask-user` so it bypasses this invalidation step.

- [ ] Run the focused test and confirm GREEN.

- [ ] Commit:

  `git commit -m "fix(inbound): invalidate stale ask-user cards"`

---

## Task 4: Fail closed when targeted Agent pause fails

**Files:**

- Modify: `src/inbound-handler.ts`
- Modify: `src/card/ask-user-question.ts`
- Modify: `tests/unit/inbound-handler-ask-user.test.ts`

- [ ] Add a failing test where the targeted `/stop` request rejects or reports failure.

- [ ] Assert that:
  - the new card becomes terminal with `pause_failed`;
  - the card text becomes `当前任务未能暂停，此卡已失效，请重新发起。`;
  - `questionCardTookOver` remains false;
  - the Agent's normal response is delivered instead of being suppressed.

- [ ] Run the focused test and confirm RED.

- [ ] Change the question-card-sent hook to report takeover success explicitly. Only mark takeover after targeted pause succeeds. On failure, terminate the card and allow the normal reply path.

- [ ] Run the focused test and confirm GREEN.

- [ ] Commit:

  `git commit -m "fix(card): rollback ask-user takeover on pause failure"`

---

## Task 5: Fail closed across gateway restart

**Files:**

- Modify: `src/card/card-action-handler.ts`
- Modify: `src/gateway/channel-gateway.ts`
- Modify: `tests/unit/card-action-handler.test.ts`
- Create: `tests/unit/channel-gateway-ask-user-recovery.test.ts`

- [ ] Add failing tests proving:
  - `storePath` reaches the card callback handler;
  - startup recovery turns `reserved`/`pending` into `restart_invalidated`;
  - startup recovery turns `dispatching` into `restart_during_dispatch`;
  - recovered cards receive the exact restart explanation;
  - startup does not inject a synthetic timeout/restart message into OpenClaw.

- [ ] Run focused tests and confirm RED:

  `pnpm vitest run tests/unit/card-action-handler.test.ts tests/unit/channel-gateway-ask-user-recovery.test.ts`

- [ ] Thread `accountStorePath` from the gateway into card callback handling.

- [ ] During gateway startup, recover unfinished lifecycle records before accepting callbacks and update cards with:
  - `服务已重启，原问题上下文已失效，请重新发起。`
  - `服务在处理回答期间重启，本次处理结果可能未完成，请发送新消息继续。`

- [ ] Do not restore ephemeral callback objects and do not enqueue synthetic Agent messages during recovery.

- [ ] Run focused tests and confirm GREEN.

- [ ] Commit:

  `git commit -m "fix(gateway): invalidate ask-user cards on restart"`

---

## Task 6: Documentation and complete regression

**Files:**

- Modify: `docs/user/features/form-interactive-card.md`
- Modify: `docs/spec/2026-07-17-ask-user-question-lifecycle-design.md` only if implementation details require an explicit correction

- [ ] Document the immediate-invalid-on-new-message rule, restart behavior, timeout, pause failure, and dispatch failure in user-facing language.

- [ ] Run formatting and static checks:

  ```bash
  git diff --check
  npm run type-check
  npm run lint
  pnpm run build:runtime
  ```

- [ ] Run the full test suite:

  `pnpm test`

- [ ] Review `git diff --check`, the full patch, and confirm no secrets or runtime callback payloads are persisted.

- [ ] Commit remaining documentation/test cleanup:

  `git commit -m "docs(card): explain ask-user invalidation behavior"`

---

## Task 7: Publish the branch and open a Draft PR

- [ ] Fetch official `main` and confirm the branch is based on the expected current upstream state. Rebase only if necessary and safe.

- [ ] Run the verification commands from Task 6 again after the final history change.

- [ ] Push `fix/ask-user-question-lifecycle` to the fork.

- [ ] Open a Draft PR against `soimy/openclaw-channel-dingtalk:main` with title:

  `fix(card): harden ask-user question lifecycle`

- [ ] Write the PR body in Simplified Chinese with sections `背景`, `目标`, `实现`, `实现 TODO`, and `验证 TODO`, and link the created Issue using `Fixes #<number>`.

- [ ] Inspect the created Draft PR, changed files, and current CI/check state before reporting completion.
