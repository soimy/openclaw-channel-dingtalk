# Contributor TODO Page And Sidebar Scrollbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the repository `TODO.md` inside the contributor docs via symlink and make the docs sidebar scrollbar display only when needed.

**Architecture:** Keep `TODO.md` as the single content source by linking `docs/contributor/todo.md` to the repository root file. Update the VitePress contributor sidebar and contributor landing page to surface that page, and use a small CSS override to switch sidebar overflow to dynamic behavior.

**Tech Stack:** VitePress config (`docs/.vitepress/config.mts`), VitePress theme CSS, Markdown docs pages, Vitest filesystem/config assertions, filesystem symlink

---

### Task 1: Add a red test for contributor TODO docs exposure

**Files:**
- Create: `tests/unit/docs-contributor-todo.test.ts`
- Test: `tests/unit/docs-contributor-todo.test.ts`

- [ ] **Step 1: Write the failing test**

Cover these expectations:
- `docs/contributor/todo.md` exists as a symlink to `../../TODO.md`
- contributor sidebar includes `/contributor/todo`
- contributor landing page links to `todo.md`
- docs custom CSS sets `overflow-y: auto` on `.VPSidebar`

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/docs-contributor-todo.test.ts`

Expected: FAIL because the symlink and contributor nav entry do not exist yet.

### Task 2: Implement contributor docs TODO exposure

**Files:**
- Create: `docs/contributor/todo.md` (symlink)
- Modify: `docs/.vitepress/config.mts`
- Modify: `docs/contributor/index.md`

- [ ] **Step 1: Create the symlink**

Point `docs/contributor/todo.md` to `../../TODO.md`.

- [ ] **Step 2: Add contributor sidebar entry**

Add a `仓库 TODO` entry that links to `/contributor/todo`.

- [ ] **Step 3: Add contributor landing-page entry**

Add a matching link in `docs/contributor/index.md`.

### Task 3: Implement the scrollbar fix and verify green

**Files:**
- Modify: `docs/.vitepress/theme/custom.css`
- Test: `tests/unit/docs-contributor-todo.test.ts`

- [ ] **Step 1: Add the minimal sidebar overflow rule**

Set `.VPSidebar` to use dynamic vertical overflow.

- [ ] **Step 2: Run the focused test**

Run: `pnpm test tests/unit/docs-contributor-todo.test.ts`

Expected: PASS

- [ ] **Step 3: Run docs build validation**

Run: `pnpm run docs:build`

Expected: PASS
