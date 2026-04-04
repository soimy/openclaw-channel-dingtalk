# Vercel CI Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current GitHub Pages docs deployment automation with a GitHub Actions driven Vercel deployment flow, and disable Vercel's built-in Git auto deployments.

**Architecture:** Keep VitePress as the docs build system, but move deployment ownership to a dedicated GitHub Actions workflow that performs `vercel pull`, `vercel build`, and `vercel deploy --prebuilt`. Update `vercel.json` so Vercel no longer starts deployments directly from pushes or pull requests.

**Tech Stack:** GitHub Actions, Vercel CLI, `vercel.json`, VitePress, Vitest file-based tests.

---

### Task 1: Lock the deployment contract with failing tests

**Files:**
- Create: `tests/unit/docs-deployment-config.test.ts`
- Read: `vercel.json`
- Read: `.github/workflows/docs-vercel.yml`
- Read: `README.md`
- Read: `docs/contributor/development.md`

- [ ] **Step 1: Write failing tests for the desired deployment state**

Add focused assertions for:

- `vercel.json` includes `git.deploymentEnabled: false`
- the docs deployment workflow contains `vercel pull`, `vercel build`, and `vercel deploy --prebuilt`
- the workflow is triggered for `pull_request`, `push` to `main`, and `workflow_dispatch`
- `README.md` and contributor docs no longer reference the old Pages deployment workflow

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm test tests/unit/docs-deployment-config.test.ts`

Expected: FAIL because the repository still uses the old GitHub Pages workflow and `vercel.json` does not yet disable Git auto deployments.

### Task 2: Replace Pages deployment with Vercel CI deployment

**Files:**
- Delete: `.github/workflows/docs-pages.yml`
- Create: `.github/workflows/docs-vercel.yml`
- Modify: `vercel.json`

- [ ] **Step 1: Implement the Vercel deployment workflow**

Create a workflow that:

- installs dependencies with pnpm
- uses Vercel project secrets from GitHub Actions
- builds locally with `vercel build`
- deploys preview builds on pull requests
- deploys production builds on `main`

- [ ] **Step 2: Disable Vercel Git auto deployments**

Add the documented `git.deploymentEnabled: false` switch to `vercel.json`.

- [ ] **Step 3: Re-run the focused deployment test**

Run: `pnpm test tests/unit/docs-deployment-config.test.ts`

Expected: PASS.

### Task 3: Update repository-facing docs and badges

**Files:**
- Modify: `README.md`
- Modify: `docs/contributor/development.md`
- Optionally modify: `tests/unit/docs-homepage-badges.test.ts` if badge assertions need to expand

- [ ] **Step 1: Update docs workflow references**

Replace the old docs workflow badge and contributor wording so they point to the new Vercel deployment workflow and no longer describe GitHub Pages automation as the active publishing path.

- [ ] **Step 2: Run focused tests again**

Run: `pnpm test tests/unit/docs-deployment-config.test.ts tests/unit/docs-homepage-badges.test.ts`

Expected: PASS.

### Task 4: Verify the docs build and final repository state

**Files:**
- Read-only verification

- [ ] **Step 1: Build the docs site**

Run: `pnpm run docs:build`

Expected: PASS and emit VitePress output successfully.

- [ ] **Step 2: Summarize required repository secrets**

Document in the final handoff that the repository now expects:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

- [ ] **Step 3: Confirm no old Pages deployment workflow remains**

Run: `git ls-files .github/workflows`

Expected: no `docs-pages.yml`; the Vercel workflow file is present instead.
