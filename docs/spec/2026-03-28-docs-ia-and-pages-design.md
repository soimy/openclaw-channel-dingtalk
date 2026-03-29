# DingTalk Plugin Docs IA And GitHub Pages Design

## Summary

This design restructures the repository documentation into two clear tracks:

- **User docs** for installation, configuration, features, troubleshooting, and day-to-day usage
- **Contributor docs** for development, testing, architecture, and release work

The first release of the docs site is **Chinese-first**. Existing English documents remain accessible through a dedicated English entry, while untranslated pages are represented with explicit TODO placeholders instead of pretending full parity exists.

The repository root `README.md` becomes a concise project entry page instead of a long-form manual. Detailed feature expansions move into focused Markdown documents under `docs/`, and a GitHub Pages site is generated from `main` and published by GitHub Actions to the `gh-pages` branch.

## Goals

1. Reduce `README.md` complexity so new users can quickly understand the plugin and get started.
2. Reorganize `docs/` into a stable, discoverable information architecture.
3. Split feature-heavy sections from `README.md` into dedicated Markdown pages with durable permalinks.
4. Publish a searchable docs site from Markdown sources in `main`.
5. Keep the first phase Chinese-first while preserving English entry points.
6. Exclude internal planning documents from the public site.

## Non-Goals

1. Do not fully translate all documents into English in phase one.
2. Do not publish `docs/plans/**`, `docs/spec/**`, or other internal process notes on the docs site.
3. Do not rewrite all existing architecture or troubleshooting content if current files can be reused.
4. Do not introduce a custom frontend docs app unless the Markdown-first approach proves insufficient.

## Audience Model

### User Docs

For plugin users who need to:

- understand what the plugin does
- install or update it
- configure DingTalk permissions and OpenClaw settings
- choose reply modes and feature options
- troubleshoot common failures

### Contributor Docs

For maintainers or contributors who need to:

- understand project architecture
- set up a local development environment
- run tests and validation
- publish packages and maintain releases

### English Entry

For English readers who need:

- access to the English docs that already exist
- a clear statement that the English docs are partial in phase one
- an explicit TODO page for missing translations

## README Scope

The root `README.md` should be reduced to a repository landing page.

### Keep In README

- project overview
- top-level feature summary
- installation paths
- update paths
- configuration entry guidance
- quick links to detailed docs
- brief developer quickstart
- architecture and troubleshooting links
- license link

### Move Out Of README

- full configuration reference
- detailed policy and security behavior
- detailed message type matrix
- API usage and cost explanations
- reply mode deep dives
- DingTalk docs API details
- feedback learning workflow
- multi-agent binding guide
- `@多助手路由` details
- full troubleshooting procedures
- expanded development and testing guide

## Target Documentation Tree

Phase one uses the following structure:

```text
docs/
  index.md
  user/
    index.md
    getting-started/
      install.md
      update.md
      configure.md
      permissions.md
    features/
      message-types.md
      reply-modes.md
      ai-card.md
      dingtalk-docs-api.md
      feedback-learning.md
      multi-agent-bindings.md
      at-agent-routing.md
    reference/
      configuration.md
      security-policies.md
      api-usage-and-cost.md
    troubleshooting/
      index.md
      connection.md
  contributor/
    index.md
    development.md
    testing.md
    release-process.md
    npm-publish.md
    architecture.md
    architecture.en.md
    architecture.zh-CN.md
    reference/
      persistence-api-usage.zh-CN.md
  releases/
    index.md
    v3.2.0.md
    v3.3.0.md
  en/
    index.md
    todo.md
  spec/
    2026-03-28-docs-ia-and-pages-design.md
  plans/
    2026-03-28-docs-ia-pages.md
```

## Compatibility Strategy

After the second-pass cleanup, the docs tree uses normalized lowercase kebab-case paths inside audience-specific directories. Legacy top-level docs are moved into their final locations instead of being kept at the root.

## Content Migration Map

The current `README.md` content should be redistributed as follows:

| Current README Section | Target Page |
| --- | --- |
| 安装 | `docs/user/getting-started/install.md` |
| 更新 | `docs/user/getting-started/update.md` |
| 配置 | `docs/user/getting-started/configure.md` |
| 钉钉开发者后台权限说明 | `docs/user/getting-started/permissions.md` |
| 配置选项 | `docs/user/reference/configuration.md` |
| 安全策略 | `docs/user/reference/security-policies.md` |
| 消息类型支持 | `docs/user/features/message-types.md` |
| 消息类型选择 | `docs/user/features/reply-modes.md` and `docs/user/features/ai-card.md` |
| API 消耗说明 | `docs/user/reference/api-usage-and-cost.md` |
| 钉钉文档 API | `docs/user/features/dingtalk-docs-api.md` |
| 反馈学习与共享知识 | `docs/user/features/feedback-learning.md` |
| 多 Agent 与多个机器人绑定 | `docs/user/features/multi-agent-bindings.md` |
| @多助手路由 | `docs/user/features/at-agent-routing.md` |
| 故障排除 | `docs/user/troubleshooting/index.md` plus `docs/user/troubleshooting/connection.md` |
| 开发指南 | `docs/contributor/development.md` |
| 测试 | `docs/contributor/testing.md` |
| 架构与职责边界 | `docs/contributor/architecture.md` |

## Site Generator Decision

### Recommended Stack

- **MkDocs**
- **Material for MkDocs**
- Markdown source files committed on `main`
- GitHub Actions builds and publishes to `gh-pages`

### Why This Stack

1. It is optimized for project documentation rather than blog-style publishing.
2. Navigation, search, and section grouping match the repository’s needs well.
3. It handles Chinese-first docs cleanly.
4. It supports explicit nav control and file exclusion, which is important for internal plans.
5. It keeps authoring in plain Markdown with low operational overhead.

### Alternatives Considered

- **Jekyll**: native to GitHub Pages, but weaker fit for a multi-section technical docs center and adds Ruby tooling.
- **VitePress**: strong presentation, but heavier than needed for a phase-one Markdown migration.

## GitHub Pages Publishing Design

### Source Of Truth

- `main` stores all Markdown source files and docs config

### Publication Target

- GitHub Actions deploys the built site to `gh-pages`

### Expected Repo Additions

- `mkdocs.yml`
- `requirements-docs.txt`
- `.github/workflows/docs-pages.yml`

### Workflow Shape

1. Trigger on pushes to `main` that affect docs, README, or MkDocs config.
2. Install Python and docs dependencies.
3. Run `mkdocs build --strict`.
4. Publish the built site to `gh-pages`.

### GitHub Repository Setting

GitHub Pages should be configured to publish from:

- branch: `gh-pages`
- folder: `/ (root)`

## Public-Site Exclusions

The docs site must exclude:

- `docs/plans/**`
- `docs/spec/**`
- `docs/assets/card-template.json`
- hidden system files such as `.DS_Store`

These files may remain in the repository, but they must not appear in the public docs site.

## Navigation Model

Top-level navigation should be limited to:

1. 用户文档
2. 参与贡献
3. 发布记录
4. English

This keeps the first impression focused and prevents users from landing inside internal maintenance material.

## Chinese-First And English Placeholder Strategy

Phase-one language rules:

1. Chinese is the default site language.
2. Existing English docs remain accessible.
3. English docs do not need one-to-one parity yet.
4. Missing English pages should point to a TODO page rather than silently disappearing.

The English landing page should clearly say that English documentation is partial and link to:

- existing English pages
- a TODO page listing untranslated areas
- the Chinese docs landing page for the most complete version

## Implementation Phases

### Phase 1: IA And Infrastructure

- add MkDocs configuration
- add GitHub Pages workflow
- add docs index pages and top-level nav structure
- add English landing and TODO pages

### Phase 2: README Reduction And Split Pages

- rewrite `README.md` into a concise entry page
- create user and contributor docs pages from the long-form README content
- replace long README sections with links

### Phase 3: Fit And Finish

- verify all links
- ensure excluded files stay out of the site
- validate local build and GitHub workflow
- confirm release notes and existing English docs render correctly

## Risks And Mitigations

### Risk: Broken Existing Links

Mitigation:

- preserve legacy high-value files in place for phase one
- prefer additive structured pages before destructive moves

### Risk: README Rewrite Drops Important Operational Details

Mitigation:

- use an explicit section-to-page migration map
- keep all important setup and update paths linked from README

### Risk: Internal Docs Accidentally Published

Mitigation:

- define explicit exclusions in `mkdocs.yml`
- keep public nav manually curated

### Risk: Chinese And English Navigation Drift

Mitigation:

- make English explicitly partial for phase one
- centralize missing translation tracking in one TODO page

## Acceptance Criteria

This design is successful when:

1. `README.md` reads as a concise project entry page instead of a long manual.
2. The docs tree clearly separates user docs and contributor docs.
3. Feature expansions are moved into dedicated Markdown pages.
4. A GitHub Pages workflow builds from `main` and publishes to `gh-pages`.
5. `docs/plans/**`, `docs/spec/**`, and similar internal files are not published.
6. Chinese docs are primary and English pages are partial but discoverable.

## Open Decisions Already Resolved

- Audience split: user docs and contributor docs
- Default language: Chinese-first
- English strategy: partial entry plus TODO placeholders
- Publishing mode: source on `main`, built site published to `gh-pages`
- Internal plans: excluded from the public site
