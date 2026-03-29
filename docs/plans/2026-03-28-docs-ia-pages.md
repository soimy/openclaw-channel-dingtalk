# DingTalk Docs IA And Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Specs belong in `docs/spec/` and plans belong in `docs/plans/`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the repository docs into a Chinese-first user/contributor information architecture, slim down `README.md`, and deploy a MkDocs-based GitHub Pages site from `main` to `gh-pages`.

**Architecture:** Keep `README.md` as a concise repository landing page, move expanded feature content into focused Markdown pages under a new `docs/` hierarchy, and add a curated MkDocs navigation that excludes internal planning material. Preserve high-value legacy doc paths during phase one to avoid breaking existing links while still presenting the new structure through the site.

**Tech Stack:** Markdown, MkDocs, Material for MkDocs, GitHub Actions, GitHub Pages

---

### Task 1: Set Up Docs Tooling And Site Skeleton

**Files:**
- Create: `mkdocs.yml`
- Create: `requirements-docs.txt`
- Create: `.github/workflows/docs-pages.yml`
- Create: `docs/index.md`
- Create: `docs/user/index.md`
- Create: `docs/contributor/index.md`
- Create: `docs/releases/index.md`
- Create: `docs/en/index.md`
- Create: `docs/en/todo.md`

- [ ] **Step 1: Define the failing verification target**

Run: `python3 -m mkdocs build --strict`
Expected: FAIL because `mkdocs.yml` and site dependencies do not exist yet

- [ ] **Step 2: Add MkDocs configuration and dependency manifest**

Create `mkdocs.yml` with:
- site name and repo metadata
- Chinese-first navigation
- `docs_dir: docs`
- `site_dir: site`
- Material theme
- search plugin
- `exclude_docs` rules for `plans/**`, `spec/**`, `.DS_Store`, and `assets/card-template.json`
- nav entries for 用户文档, 参与贡献, 发布记录, English

Create `requirements-docs.txt` with:
- `mkdocs`
- `mkdocs-material`

- [ ] **Step 3: Add docs entry pages**

Create lightweight landing pages for:
- docs home
- user docs home
- contributor docs home
- releases home
- English home
- English TODO page

- [ ] **Step 4: Add GitHub Pages workflow**

Create `.github/workflows/docs-pages.yml` that:
- triggers on pushes to `main` affecting docs sources, `README.md`, workflow config, or MkDocs config
- installs Python
- installs dependencies from `requirements-docs.txt`
- runs `mkdocs build --strict`
- deploys built site to `gh-pages`

- [ ] **Step 5: Run docs build to verify green**

Run: `python3 -m pip install -r requirements-docs.txt`
Then run: `python3 -m mkdocs build --strict`
Expected: PASS with generated `site/`

### Task 2: Create User Docs Pages And Move README Expansions

**Files:**
- Create: `docs/user/getting-started/install.md`
- Create: `docs/user/getting-started/update.md`
- Create: `docs/user/getting-started/configure.md`
- Create: `docs/user/getting-started/permissions.md`
- Create: `docs/user/features/message-types.md`
- Create: `docs/user/features/reply-modes.md`
- Create: `docs/user/features/ai-card.md`
- Create: `docs/user/features/dingtalk-docs-api.md`
- Create: `docs/user/features/feedback-learning.md`
- Create: `docs/user/features/multi-agent-bindings.md`
- Create: `docs/user/features/at-agent-routing.md`
- Create: `docs/user/reference/configuration.md`
- Create: `docs/user/reference/security-policies.md`
- Create: `docs/user/reference/api-usage-and-cost.md`
- Create: `docs/user/troubleshooting/index.md`
- Create: `docs/user/troubleshooting/connection.md`
- Modify: `README.md`

- [ ] **Step 1: Define the failing verification target**

Run: `python3 -m mkdocs build --strict`
Expected: FAIL because navigation points to user docs pages that do not exist yet

- [ ] **Step 2: Create getting-started docs**

Write focused pages for:
- installation methods and trust allowlist
- update flows
- configuration methods
- DingTalk permission and credential setup

Keep tone concise and user-facing.

- [ ] **Step 3: Create feature and reference docs**

Write focused pages for:
- message type support
- reply modes
- AI card details
- DingTalk docs API
- feedback learning
- multi-agent bindings
- `@多助手路由`
- configuration reference
- security policies
- API usage and cost

Split the current README content by topic rather than duplicating the long original flow.

- [ ] **Step 4: Create troubleshooting entry pages**

Add a user troubleshooting hub page and a connection troubleshooting bridge page that links to the existing detailed troubleshooting docs.

- [ ] **Step 5: Rewrite `README.md` into a concise entry page**

Keep only:
- overview
- key features
- install/update/config quickstart
- short docs directory
- brief development quickstart
- links to detailed docs

Replace long deep-dive sections with links to the new docs pages.

- [ ] **Step 6: Run docs build to verify green**

Run: `python3 -m mkdocs build --strict`
Expected: PASS with all new pages resolved

### Task 3: Add Contributor, Release, And English Entry Pages

**Files:**
- Create: `docs/contributor/development.md`
- Create: `docs/contributor/testing.md`
- Create: `docs/contributor/release-process.md`
- Create: `docs/contributor/npm-publish.md`
- Create: `docs/contributor/architecture.md`
- Modify: `docs/en/index.md`
- Modify: `docs/releases/index.md`

- [ ] **Step 1: Define the failing verification target**

Run: `python3 -m mkdocs build --strict`
Expected: FAIL if contributor nav entries or release links reference pages that do not exist yet

- [ ] **Step 2: Create contributor guides**

Create contributor-focused pages for:
- local development setup
- common commands
- testing workflow
- release workflow
- npm publish guidance
- architecture guide entry linking Chinese and English architecture docs

- [ ] **Step 3: Create releases landing**

Add a releases index page that links to existing version notes and clarifies that release notes remain in the repo.

- [ ] **Step 4: Finalize English entry**

Make `docs/en/index.md` explicitly state:
- English docs are partial
- existing English pages are linked
- missing translations are tracked in `docs/en/todo.md`
- Chinese docs are currently the authoritative first destination

- [ ] **Step 5: Run docs build to verify green**

Run: `python3 -m mkdocs build --strict`
Expected: PASS with contributor, release, and English entries rendering cleanly

### Task 4: Validate Links, Exclusions, And Repo Status

**Files:**
- Modify: `mkdocs.yml` if needed
- Modify: any docs page with broken internal links discovered during verification

- [ ] **Step 1: Run site build and inspect warnings**

Run: `python3 -m mkdocs build --strict`
Expected: PASS with no broken nav or link errors

- [ ] **Step 2: Verify excluded internal content stays out of the site**

Run: `find site -maxdepth 4 | rg 'plans|spec|assets/card-template|\\.DS_Store'`
Expected: no public-site copies of excluded internal docs

- [ ] **Step 3: Run repo quality checks relevant to this change**

Run: `pnpm test`
Expected: existing tests remain green

- [ ] **Step 4: Review git diff for scope control**

Run: `git status --short`
Run: `git diff --stat`
Expected: changes limited to docs, README, MkDocs config, and workflow files

- [ ] **Step 5: Prepare completion summary**

Summarize:
- README simplification
- new docs IA
- Pages deployment setup
- verification evidence
