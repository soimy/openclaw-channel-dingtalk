# DingTalk Real-Device Testing Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Specs belong in `docs/spec/` and plans belong in `docs/plans/`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a contributor-facing DingTalk real-device testing workflow and a project-local skill that helps agents prepare and report PR-scoped real-device validation.

**Architecture:** Keep human guidance in `docs/contributor/testing.md`, place the reusable agent workflow in `skills/dingtalk-real-device-testing/SKILL.md`, and wire skill discovery through short repository instructions in `AGENTS.md` and `CLAUDE.md`. Favor PR-scoped, environment-aware guidance over toggle-specific troubleshooting.

**Tech Stack:** Markdown, repository guidance docs, project-local skill metadata

---

### Task 1: Rewrite Contributor Real-Device Testing Guidance

**Files:**
- Modify: `docs/contributor/testing.md`

- [ ] **Step 1: Define the failing verification target**

Run: `rg -n "LLM|Prompt|项目级 SKILL|验证 TODO" docs/contributor/testing.md`
Expected: FAIL to find the new contributor guidance structure because the page still contains the older real-device section.

- [ ] **Step 2: Rewrite the real-device testing section**

Update the page so it:
- states which DingTalk-message-path PRs require real-device validation before merge
- explains the recommended global `openclaw` environment and config switching flow
- uses a PR-scoped execution checklist instead of a fixed baseline matrix
- gives broad pass/fail judgment and lightweight diagnosis guidance
- includes a short `验证 TODO` example

- [ ] **Step 3: Re-run a focused content check**

Run: `rg -n "项目级 skill|验证 TODO|openclaw gateway restart|复原插件目录指向" docs/contributor/testing.md`
Expected: PASS with matches for the new contributor guidance.

### Task 2: Add The Repository-Level Real-Device Testing Skill

**Files:**
- Create: `skills/dingtalk-real-device-testing/SKILL.md`

- [ ] **Step 1: Define the failing verification target**

Run: `test -f skills/dingtalk-real-device-testing/SKILL.md`
Expected: FAIL because the project-local skill does not exist yet.

- [ ] **Step 2: Write the skill**

Create `skills/dingtalk-real-device-testing/SKILL.md` with:
- frontmatter `name` and trigger-only `description`
- a concise overview of when to use the skill
- environment preparation steps for global `openclaw`, plugin path switching, config updates, and restart
- workflow for deriving PR-scoped real-device scenarios and objective probes
- instructions for drafting PR `验证 TODO` wording
- cleanup guidance for restoring plugin path and temporary config changes

- [ ] **Step 3: Re-run the existence and content checks**

Run: `test -f skills/dingtalk-real-device-testing/SKILL.md`
Run: `rg -n "openclaw|验证 TODO|复原" skills/dingtalk-real-device-testing/SKILL.md`
Expected: PASS with the key workflow phrases present.

### Task 3: Wire Skill Discovery Through Repository Instructions

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Define the failing verification target**

Run: `rg -n "dingtalk-real-device-testing" AGENTS.md CLAUDE.md`
Expected: FAIL because the repository guidance files do not mention the new skill yet.

- [ ] **Step 2: Add project-local skill references**

Add a short rule in both files telling agents to read `skills/dingtalk-real-device-testing/SKILL.md` when the task involves DingTalk message-path real-device validation, testing-checklist generation, `验证 TODO` drafting, or contributor-guide updates for that workflow.

- [ ] **Step 3: Re-run the discovery check**

Run: `rg -n "dingtalk-real-device-testing" AGENTS.md CLAUDE.md`
Expected: PASS with one mention in each file.

### Task 4: Run Final Verification And Scope Review

**Files:**
- Verify: `docs/contributor/testing.md`
- Verify: `skills/dingtalk-real-device-testing/SKILL.md`
- Verify: `AGENTS.md`
- Verify: `CLAUDE.md`

- [ ] **Step 1: Build the docs site**

Run: `npm run docs:build`
Expected: PASS with no docs build failures.

- [ ] **Step 2: Review the changed files for consistency**

Run: `git diff -- docs/contributor/testing.md skills/dingtalk-real-device-testing/SKILL.md AGENTS.md CLAUDE.md docs/spec/2026-03-31-dingtalk-real-device-testing-design.md docs/plans/2026-03-31-dingtalk-real-device-testing.md`
Expected: contributor docs stay human-facing, skill stays agent-facing, and both repository guidance files point to the same skill path.

- [ ] **Step 3: Review workspace scope**

Run: `git status --short`
Expected: only the intended files plus any pre-existing unrelated untracked files are present.
