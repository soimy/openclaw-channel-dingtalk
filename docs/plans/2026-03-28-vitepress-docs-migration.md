# VitePress Docs Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Specs belong in `docs/spec/` and plans belong in `docs/plans/`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current MkDocs-based documentation site with a VitePress-based docs system while preserving the existing `docs/` content tree and removing Python/MkDocs leftovers from the repository.

**Architecture:** Keep all user and contributor Markdown pages where they are today, introduce `docs/.vitepress/` as the only new site-config root, and use VitePress `nav`, `sidebar`, and `srcExclude` to present the same public information architecture while excluding internal docs. Replace the current branch-publishing Pages workflow with GitHub Actions artifact deployment to match VitePress’s official deployment path.

**Tech Stack:** VitePress, Vite, TypeScript config (`config.mts`), pnpm, GitHub Actions Pages artifact deployment

---

### Task 1: Replace Docs Tooling With VitePress

**Files:**
- Modify: `package.json`
- Create: `docs/.vitepress/config.mts`
- Delete: `mkdocs.yml`
- Delete: `requirements-docs.txt`
- Delete: `scripts/docs-mkdocs.sh`
- Delete: `hooks/copy_simple_blog_assets.py`
- Delete: `theme-overrides/` (if present)
- Modify: `.gitignore`

- [ ] **Step 1: Define the failing verification target**

Run: `pnpm run docs:build`
Expected: FAIL because `vitepress` is not installed and no VitePress config exists yet

- [ ] **Step 2: Add VitePress dependency and scripts**

Update `package.json` to:
- add `vitepress` as a dev dependency
- replace MkDocs scripts with:
  - `docs:dev`
  - `docs:build`
  - `docs:preview`
  - `docs:serv` as a compatibility alias to dev mode

- [ ] **Step 3: Add VitePress config**

Create `docs/.vitepress/config.mts` with:
- correct `base` for GitHub Pages repo path
- site metadata
- edit link configuration
- top-level nav for 用户文档 / 参与贡献 / 发布记录 / English
- sidebars matching the current docs sections
- `srcExclude` rules for `spec/**`, `plans/**`, `archive/**`, and `assets/**`

- [ ] **Step 4: Remove MkDocs/Python docs tooling**

Delete:
- `mkdocs.yml`
- `requirements-docs.txt`
- `scripts/docs-mkdocs.sh`
- `hooks/copy_simple_blog_assets.py`
- any theme override files used only by MkDocs

Also remove `.venv-docs` handling and ignore rules from `.gitignore`.

- [ ] **Step 5: Run VitePress build to verify green**

Run: `pnpm install`
Then run: `pnpm run docs:build`
Expected: PASS and emit `docs/.vitepress/dist`

### Task 2: Replace Pages Deployment With GitHub Actions Artifact Deployment

**Files:**
- Modify: `.github/workflows/docs-pages.yml`

- [ ] **Step 1: Define the failing verification target**

Review current workflow and identify MkDocs-specific / `gh-pages` branch-publishing steps that must be removed.

- [ ] **Step 2: Replace workflow with official-style VitePress Pages deployment**

Update `.github/workflows/docs-pages.yml` to:
- use `actions/configure-pages`
- use Node setup instead of Python setup
- install JS dependencies
- run `pnpm run docs:build`
- upload `docs/.vitepress/dist` via `actions/upload-pages-artifact`
- deploy with `actions/deploy-pages`

- [ ] **Step 3: Align Pages source expectation**

Ensure the workflow reflects that repository Pages settings should use:
- `Build and deployment > Source: GitHub Actions`

- [ ] **Step 4: Validate workflow syntax**

Run a local YAML sanity check by reading the file and confirming all referenced scripts and paths exist.

### Task 3: Update Contributor Docs And Clean References

**Files:**
- Modify: `docs/contributor/development.md`
- Modify: `README.md` if docs command references need adjustment
- Modify: any docs page or repo file that still references MkDocs-specific commands or Python docs tooling

- [ ] **Step 1: Define the failing verification target**

Run: `rg -n "mkdocs|requirements-docs|docs-mkdocs|\\.venv-docs|python3 -m mkdocs" README.md docs .github package.json .gitignore`
Expected: find MkDocs-era references that must be removed

- [ ] **Step 2: Update contributor instructions**

Replace MkDocs/Python instructions with VitePress commands:
- `pnpm run docs:dev`
- `pnpm run docs:build`
- `pnpm run docs:preview`

- [ ] **Step 3: Clean remaining references**

Update repo docs and workflow references so they consistently point to the VitePress workflow.

- [ ] **Step 4: Re-run reference scan**

Run: `rg -n "mkdocs|requirements-docs|docs-mkdocs|\\.venv-docs|python3 -m mkdocs" README.md docs .github package.json .gitignore`
Expected: no stale operational references remain

### Task 4: Verify Local Build, Preview, And Public-Docs Exclusions

**Files:**
- Modify: `docs/.vitepress/config.mts` if exclusion or nav fixes are needed

- [ ] **Step 1: Verify site build output**

Run: `pnpm run docs:build`
Expected: PASS with output under `docs/.vitepress/dist`

- [ ] **Step 2: Verify preview server pathing**

Run: `pnpm run docs:serv`
Expected: local dev server starts and serves the site under the configured base path

- [ ] **Step 3: Verify excluded internal docs are not built**

Run: `find docs/.vitepress/dist -maxdepth 6 | rg 'spec|plans|archive|assets/card-template'`
Expected: internal docs and non-site asset files are not part of the generated site

- [ ] **Step 4: Review git scope**

Run: `git status --short`
Run: `git diff --stat`
Expected: changes limited to docs tooling, workflow, and docs command references

- [ ] **Step 5: Prepare completion summary**

Summarize:
- VitePress config and scripts
- artifact-based Pages deployment
- removed MkDocs/Python residue
- local verification evidence
