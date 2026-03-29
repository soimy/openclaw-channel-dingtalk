# Docs Homepage And Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Specs belong in `docs/spec/` and plans belong in `docs/plans/`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the VitePress homepage render `README.md`, expose GitHub in the top nav, and wire DingClaw branding into the docs site and README.

**Architecture:** Keep `README.md` as the single homepage content source, use `docs/index.md` as a wrapper include page, publish a public copy of the logo asset for VitePress runtime use, and add minimal Markdown link/image rewriting in VitePress config so README-origin links still resolve correctly inside the docs site.

**Tech Stack:** VitePress, Markdown include, VitePress theme config, static public assets

---

### Task 1: Rewire The Homepage To README

**Files:**
- Modify: `docs/index.md`
- Modify: `docs/.vitepress/config.mts`

- [ ] Replace docs homepage body with a README include wrapper
- [ ] Add Markdown link/image rewriting for README-origin `docs/...` links and `docs/assets/dingclaw.svg`
- [ ] Verify `pnpm run docs:build`

### Task 2: Apply DingClaw Branding

**Files:**
- Create: `docs/public/assets/dingclaw.svg`
- Modify: `docs/.vitepress/config.mts`
- Modify: `README.md`

- [ ] Publish a site-facing copy of the SVG logo
- [ ] Configure favicon and navbar logo in VitePress
- [ ] Add logo to the top of `README.md`
- [ ] Verify local build output contains the public asset

### Task 3: Improve Top Navigation Discoverability

**Files:**
- Modify: `docs/.vitepress/config.mts`

- [ ] Add a top-level `GitHub` nav item as the last navbar entry
- [ ] Remove duplicate or less discoverable GitHub placement if needed
- [ ] Verify `pnpm run docs:serv` renders the nav correctly
