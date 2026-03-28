# Persistence Namespace Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a unified, backward-compatible persistence namespace framework for DingTalk plugin state, then migrate restart-critical and high-value caches with zero behavior regression.

**Architecture:** Introduce a shared persistence module (`src/persistence-store.ts`) that centralizes namespace path resolution, tolerant JSON read, and atomic write. Migrate existing file-persisted state first (`card-service` pending cards + `group-members-store` roster), then optionally migrate selected in-memory caches to persisted namespaces through explicit adapters. Keep process-local runtime/lock/dedup semantics unchanged.

**Tech Stack:** TypeScript, Node.js `fs/path`, Vitest, existing plugin runtime storePath conventions.

---

### Task 1: Add persistence core module and namespace types

**Files:**
- Create: `src/persistence-store.ts`
- Modify: `src/types.ts` (add persistence namespace/scope types)
- Test: `tests/unit/persistence-store.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveNamespacePath } from "../../src/persistence-store";

describe("resolveNamespacePath", () => {
    it("builds account-scoped namespace path under dirname(storePath)", () => {
        const p = resolveNamespacePath("cards.active.pending", {
            storePath: "/tmp/openclaw/session/main/session.json",
            scope: { accountId: "main" },
            format: "json",
        });
        expect(p).toContain("dingtalk-state");
        expect(p).toContain("cards.active.pending");
        expect(p.endsWith(".json")).toBe(true);
    });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/persistence-store.test.ts`
Expected: FAIL with module/function not found.

**Step 3: Write minimal implementation**

```ts
export function resolveNamespacePath(namespace: string, opts: {
    storePath: string;
    scope?: { accountId?: string; agentId?: string; conversationId?: string };
    format?: "json";
}): string {
    // 1) root = path.join(path.dirname(storePath), "dingtalk-state")
    // 2) namespace -> safe filename segment
    // 3) append scope suffix segments when present
    // 4) default extension .json
}
```

Also add:
- `readNamespaceJson<T>()` with tolerant parse + default fallback
- `writeNamespaceJsonAtomic<T>()` with `tmp + rename`

**Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/persistence-store.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/persistence-store.ts src/types.ts tests/unit/persistence-store.test.ts
git commit -m "feat: add persistence namespace core with atomic json io"
```

---

### Task 2: Migrate pending card persistence to persistence-store

**Files:**
- Modify: `src/card-service.ts`
- Modify: `src/types.ts` (if needed for namespace constants)
- Test: `tests/unit/card-service.test.ts`

**Step 1: Write/adjust failing test**

Add assertions that pending card persistence still:
1. Writes on create (inbound card path)
2. Removes on finish/fail
3. Recovers on startup and finalizes correctly

```ts
it("keeps pending-card recover/finalize semantics after persistence-store migration", async () => {
    // Arrange legacy/new file fixture as needed
    // Act recoverPendingCardsForAccount + finalizeActiveCardsForAccount
    // Assert same behavior as before
});
```

**Step 2: Run targeted test to verify failure**

Run: `pnpm test tests/unit/card-service.test.ts -t "pending card"`
Expected: FAIL after test expectations updated.

**Step 3: Refactor implementation**

Replace direct file helper internals:
- `getCardStateFilePath`
- `readPendingCardState`
- `writePendingCardState`

With persistence-store wrappers while preserving:
- File format compatibility
- Version field handling
- Account-scoped filtering
- Error logging behavior

**Step 4: Verify tests pass**

Run: `pnpm test tests/unit/card-service.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/card-service.ts tests/unit/card-service.test.ts src/types.ts
git commit -m "refactor: route pending card persistence through namespace store"
```

---

### Task 3: Migrate group member roster persistence with backward-compatible dual-read

**Files:**
- Modify: `src/group-members-store.ts`
- Modify: `src/inbound-handler.ts` (scope input if accountId needed)
- Test: `tests/unit/group-members-store.test.ts`

**Step 1: Write failing migration test**

```ts
it("reads legacy dingtalk-members file then rewrites into new namespace path", () => {
    // seed legacy file
    // call formatGroupMembers/noteGroupMember
    // assert legacy still readable and new namespace written
});
```

**Step 2: Run test to verify failure**

Run: `pnpm test tests/unit/group-members-store.test.ts`
Expected: FAIL for migration behavior.

**Step 3: Implement dual-read / new-write**

Behavior:
1. Try new namespace path first
2. Fallback to legacy `dingtalk-members/<safeGroupId>.json`
3. On successful legacy read, write through to new path

Optional hardening:
- Include `accountId` in new path scope to avoid multi-account bleed.

**Step 4: Re-run tests**

Run: `pnpm test tests/unit/group-members-store.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/group-members-store.ts src/inbound-handler.ts tests/unit/group-members-store.test.ts
git commit -m "refactor: migrate group member roster to namespace persistence with dual-read"
```

---

### Task 4: Add persisted quoted-message namespace adapter (optional feature-flagged)

**Files:**
- Modify: `src/quoted-msg-cache.ts`
- Modify: `src/inbound-handler.ts`
- Test: `tests/unit/quoted-msg-cache.test.ts`

**Step 1: Add failing restart-survival test**

```ts
it("restores quoted download code cache after simulated restart when persistence enabled", () => {
    // write persisted record
    // clear process memory
    // assert getCachedDownloadCode can recover via persisted namespace
});
```

**Step 2: Run test and confirm fail**

Run: `pnpm test tests/unit/quoted-msg-cache.test.ts`
Expected: FAIL prior to adapter implementation.

**Step 3: Implement adapter**

Keep current in-memory fast path + persisted fallback:
- Write-through on `cacheInboundDownloadCode`
- Read-through on cache miss in `getCachedDownloadCode`
- Preserve TTL and max-entry constraints

Guard with config flag (default off/on based on decision).

**Step 4: Re-run tests**

Run: `pnpm test tests/unit/quoted-msg-cache.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/quoted-msg-cache.ts src/inbound-handler.ts tests/unit/quoted-msg-cache.test.ts
git commit -m "feat: add optional persisted quoted-message namespace adapter"
```

---

### Task 5: Add persisted card-content namespace adapter for quoted card lookup (optional)

**Files:**
- Modify: `src/card-service.ts`
- Modify: `src/inbound-handler.ts`
- Test: `tests/unit/card-content-cache.test.ts`

**Step 1: Write failing test**

```ts
it("findCardContent can recover persisted entries after process restart", () => {
    // seed persisted namespace record
    // clear in-memory store
    // assert retrieval by match window still works
});
```

**Step 2: Run test to confirm fail**

Run: `pnpm test tests/unit/card-content-cache.test.ts`
Expected: FAIL.

**Step 3: Implement adapter preserving existing semantics**

Maintain:
- 24h TTL
- max per conversation / max conversations constraints
- match window behavior

**Step 4: Re-run test**

Run: `pnpm test tests/unit/card-content-cache.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/card-service.ts src/inbound-handler.ts tests/unit/card-content-cache.test.ts
git commit -m "feat: add optional persisted card-content namespace adapter"
```

---

### Task 6: Explicitly freeze process-local namespaces (no persistence)

**Files:**
- Modify: `src/dedup.ts`
- Modify: `src/session-lock.ts`
- Modify: `src/channel.ts`
- Modify: `README.md`
- Test: `tests/unit/dedup.test.ts` (if needed)

**Step 1: Write a failing docs/guard test (if project supports)**

If no doc test framework, skip to implementation and verify behavior tests unchanged.

**Step 2: Add explicit guard comments and optional runtime assertions**

Document and enforce that these namespaces stay in-memory:
- dedup window
- in-flight processing locks
- session lock queue

**Step 3: Verify no behavior regressions**

Run: `pnpm test tests/unit/dedup.test.ts` (or related suite)
Expected: PASS.

**Step 4: Commit**

```bash
git add src/dedup.ts src/session-lock.ts src/channel.ts README.md
git commit -m "docs: mark process-local namespaces as intentionally non-persistent"
```

---

### Task 7: End-to-end verification and migration validation

**Files:**
- Modify (if needed): `tests/integration/*.test.ts`
- Verify: all changed files

**Step 1: Run typecheck**

Run: `npm run type-check`
Expected: exit code 0.

**Step 2: Run lint**

Run: `npm run lint`
Expected: no new lint errors from changed lines.

**Step 3: Run full tests**

Run: `pnpm test`
Expected: all tests pass, including migration/restart scenarios.

**Step 4: Manual migration sanity check**

1. Seed legacy files
2. Start plugin path (or call migration entry points)
3. Verify new namespace files created and behavior preserved

**Step 5: Commit final test/doc touch-ups**

```bash
git add tests docs/ README.md
git commit -m "test: add migration and restart recovery coverage for persistence namespaces"
```

---

## Namespace Plan (Target)

- `cards.active.pending` (persistent, account-scoped, restart-critical)
- `members.group-roster` (persistent, account+group scoped)
- `quoted.msg-download-code` (optional persistent, account+conversation scoped)
- `cards.content.quote-lookup` (optional persistent, account+conversation scoped)
- `auth.token` (optional persistent)
- `risk.proactive-target` (optional persistent)
- `dedup.processed-message` (memory-only)
- `session.lock` (memory-only)
- `channel.inflight` (memory-only)
- `peer-id.registry` (memory-only)
- `runtime.ref` (memory-only)
- `logger.context` (memory-only)

## Rollback & Safety Rules

1. Do not delete legacy files until dual-read has shipped for at least one release cycle.
2. If new namespace read fails, fallback to legacy and log warning with namespace/scope.
3. Never change startup recovery ordering in `channel.ts` without integration coverage.
4. Keep card pending state format backward-compatible (`version` + tolerant parser).

## Verification Commands (Final)

```bash
npm run type-check
npm run lint
pnpm test
```
