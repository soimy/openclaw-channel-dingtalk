# DingTalk Wide-Screen Card Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make DingTalk AI card creation always include the wide-screen template parameter so PC clients can auto-layout the card.

**Architecture:** Keep the change at the `createAndDeliver` assembly point in `src/card-service.ts`. The payload already owns `cardData.cardParamMap`, so injecting `config` there keeps behavior local, testable, and backward-compatible for non-card modes.

**Tech Stack:** TypeScript, Vitest, Zod-free runtime payload assembly, README docs

---

### Task 1: Lock behavior with a failing payload test

**Files:**
- Modify: `tests/unit/card-service.test.ts`

**Step 1: Write the failing test**

Update the existing `createAICard returns card instance` test so it expects:

```ts
expect(body.cardData?.cardParamMap).toEqual({
    config: '{"autoLayout":true}',
    content: '',
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/card-service.test.ts`
Expected: FAIL because current payload only includes `content`.

### Task 2: Add the minimal implementation

**Files:**
- Modify: `src/card-service.ts`

**Step 1: Write minimal implementation**

Build `cardParamMap` with both the content key and the wide-screen config key:

```ts
cardData: {
    cardParamMap: {
        config: JSON.stringify({ autoLayout: true }),
        [cardTemplateKey]: "",
    },
},
```

**Step 2: Run focused test to verify it passes**

Run: `pnpm test tests/unit/card-service.test.ts`
Expected: PASS.

### Task 3: Document the default behavior

**Files:**
- Modify: `README.md`

**Step 1: Document template requirement and runtime default**

Add short notes in the card template setup and card mode sections:
- template should include `config.autoLayout`
- plugin now sends `config={"autoLayout":true}` by default in card mode

**Step 2: Verify docs stay accurate**

Read the updated sections and ensure they match runtime behavior exactly.

### Task 4: Full verification

**Files:**
- Verify modified files only

**Step 1: Run diagnostics**

Run LSP diagnostics for:
- `src/card-service.ts`
- `tests/unit/card-service.test.ts`

Expected: zero errors.

**Step 2: Run project checks**

Run:
- `pnpm test tests/unit/card-service.test.ts`
- `npm run type-check`
- `npm run lint`

Expected: all pass.

**Step 3: Do not commit**

The user did not request a commit.
