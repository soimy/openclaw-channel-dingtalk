# AGENTS / CLAUDE 文档分层与 GitNexus 可选增强实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 精简并同步 `AGENTS.md` 与 `CLAUDE.md`，引入共享工作流与 GitNexus 可选增强文档，使公开仓库在无 GitNexus 环境下也能完整协作。

**Architecture:** 采用“双入口 + 共享规则 + 可选增强”的文档分层模型：`AGENTS.md` 作为通用入口，`CLAUDE.md` 作为 Claude 兼容入口，`WORKFLOW.md` 提供摘要导航，`docs/contributor/agent-workflow.md` 承载基础规则，`docs/contributor/gitnexus-optional.md` 承载工具增强说明。

**Tech Stack:** Markdown, VitePress docs, pnpm scripts

---

### Task 1: 新增共享工作流文档

**Files:**
- Create: `WORKFLOW.md`
- Create: `docs/contributor/agent-workflow.md`
- Test: `docs/contributor/index.md`

- [ ] **Step 1: 写出 `WORKFLOW.md` 初稿**

```md
# Repository Workflow

## Start Here
- Read this file first for a repository-wide summary.
- Then follow the detailed contributor workflow and architecture docs.

## Base Workflow
1. Understand the task and read the relevant files.
2. Assess impact before editing.
3. Keep changes within scope and follow architecture boundaries.
4. Run validation that matches the change.
5. Summarize scope, validation, and any follow-up.

## Detailed Guides
- Base workflow: `docs/contributor/agent-workflow.md`
- Architecture: `docs/contributor/architecture.zh-CN.md`
- Testing: `docs/contributor/testing.md`
- Release process: `docs/contributor/release-process.md`

## Optional Tooling
- GitNexus is an optional enhancement for repository understanding and impact analysis.
- If it is unavailable locally, continue with the base workflow.
- See `docs/contributor/gitnexus-optional.md`.
```

- [ ] **Step 2: 写出 `docs/contributor/agent-workflow.md` 初稿**

```md
# Contributor and Agent Workflow

## Purpose
This document defines the shared base workflow for contributors and coding agents in this repository. It must remain usable without optional local tools such as GitNexus.

## Core Principles
- Read before editing.
- Keep changes scoped to the request.
- Prefer existing architecture boundaries.
- Validate before claiming completion.
- Do not make optional tools the only documented path.

## Workflow
### 1. Understand the task
### 2. Assess impact before editing
### 3. Make the change
### 4. Validate the change
### 5. Prepare handoff
```

- [ ] **Step 3: 在 contributor 入口页加入新文档链接**

```md
- [仓库工作流](../../WORKFLOW.md)
- [贡献者与 Agent 工作流](agent-workflow.md)
```

- [ ] **Step 4: 运行文档构建验证新链接**

Run: `pnpm run docs:build`
Expected: docs build succeeds without broken links caused by the new workflow documents.

### Task 2: 新增 GitNexus 可选增强文档

**Files:**
- Create: `docs/contributor/gitnexus-optional.md`
- Modify: `docs/contributor/index.md`
- Test: `docs/contributor/gitnexus-optional.md`

- [ ] **Step 1: 写出 GitNexus 可选增强文档**

```md
# GitNexus Optional Workflow

## Purpose
GitNexus is an optional enhancement for code understanding, impact analysis, and change-scope review in this repository.

## When to Use
- Exploring unfamiliar architecture
- Assessing impact before editing
- Tracing execution paths during debugging
- Verifying change scope before commit

## Mapping to the Base Workflow
- Understand context -> `query`, `context`
- Assess impact -> `impact`
- Verify scope -> `detect_changes`

## Fallback
If GitNexus is unavailable locally, continue with `WORKFLOW.md` and `docs/contributor/agent-workflow.md`. Lack of GitNexus must not block normal development or review.
```

- [ ] **Step 2: 在 contributor 入口页加入 GitNexus 可选增强链接**

```md
- [GitNexus 可选增强工作流](gitnexus-optional.md)
```

- [ ] **Step 3: 运行文档构建确认 GitNexus 文档收录正常**

Run: `pnpm run docs:build`
Expected: docs build succeeds and includes the new optional GitNexus page.

### Task 3: 精简并同步 `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`
- Test: `WORKFLOW.md`

- [ ] **Step 1: 将 `AGENTS.md` 重写为短入口骨架**

```md
# PROJECT KNOWLEDGE BASE

## Overview
DingTalk enterprise bot channel plugin for OpenClaw. Use the contributor architecture docs as the source of truth for module boundaries.

## Start Here
- `WORKFLOW.md`
- `docs/contributor/agent-workflow.md`
- `docs/contributor/architecture.zh-CN.md`
- `docs/contributor/architecture.en.md`

## Documentation Placement
- Specs -> `docs/spec/`
- Plans -> `docs/plans/`
- User docs -> `docs/user/`
- Contributor docs -> `docs/contributor/`
- Release notes -> `docs/releases/`

## Collaboration Conventions
- Prefer issue templates in `.github/ISSUE_TEMPLATE/`
- Keep issue discussion primarily in Simplified Chinese
- Use an English Conventional-style PR title
- Write the PR body in Simplified Chinese with `背景`, `目标`, `实现`, `实现 TODO`, `验证 TODO`

## Optional Tooling
GitNexus is an optional enhancement. The base workflow must remain usable without it. See `docs/contributor/gitnexus-optional.md`.
```

- [ ] **Step 2: 删除超长 `STRUCTURE`、`CODE MAP` 与 GitNexus 手册段**

Run: manual edit in `AGENTS.md`
Expected: the file keeps only the high-value project summary, links, conventions, and high-priority repository rules.

- [ ] **Step 3: 校对 `AGENTS.md` 与新工作流文档的一致性**

Run: review `AGENTS.md`, `WORKFLOW.md`, and `docs/contributor/agent-workflow.md`
Expected: shared rules are consistent and `AGENTS.md` does not contradict the new base workflow.

### Task 4: 精简并同步 `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`
- Test: `AGENTS.md`

- [ ] **Step 1: 用与 `AGENTS.md` 相同的主骨架重写 `CLAUDE.md`**

```md
# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Overview
DingTalk enterprise bot channel plugin for OpenClaw. This file intentionally stays closely aligned with `AGENTS.md`.

## Start Here
- `WORKFLOW.md`
- `docs/contributor/agent-workflow.md`
- `docs/contributor/architecture.zh-CN.md`
- `docs/contributor/architecture.en.md`

## Optional Tooling
GitNexus is an optional enhancement. If available locally, prefer it for impact analysis and change-scope review. If unavailable, continue with the base workflow.
```

- [ ] **Step 2: 保留最少量 Claude Code 专属说明**

```md
## Claude Code Notes
- Prefer dedicated Claude Code tools over shell equivalents when possible.
- Follow repository workflow documents before editing.
- Keep changes scoped to the request.
```

- [ ] **Step 3: 删除内嵌 GitNexus 详细段并检查与 `AGENTS.md` 同步程度**

Run: manual review of `CLAUDE.md` and `AGENTS.md`
Expected: both files share the same core structure, with only minimal Claude-specific additions.

### Task 5: 统一措辞并完成验证

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `WORKFLOW.md`
- Modify: `docs/contributor/agent-workflow.md`
- Modify: `docs/contributor/gitnexus-optional.md`
- Modify: `docs/contributor/index.md`

- [ ] **Step 1: 将工具绑定型强约束改写为“目标强制、工具可选”**

```md
Before editing a function, class, or method, contributors must assess the blast radius by reviewing direct callers, importers, and affected flows. If GitNexus is available locally, prefer graph-aware tools for this step.
```

- [ ] **Step 2: 运行文档构建**

Run: `pnpm run docs:build`
Expected: PASS

- [ ] **Step 3: 运行类型检查、lint 与测试的最小必要验证**

Run: `pnpm run type-check && pnpm run lint`
Expected: PASS

- [ ] **Step 4: 检查工作区变化范围**

Run: `git diff -- AGENTS.md CLAUDE.md WORKFLOW.md docs/contributor/index.md docs/contributor/agent-workflow.md docs/contributor/gitnexus-optional.md docs/spec/2026-04-08-agents-claude-doc-layering-and-gitnexus-optional-design.md docs/plans/2026-04-08-agents-claude-doc-layering-and-gitnexus-optional-plan.md`
Expected: only the intended documentation files are changed.
