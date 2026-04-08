# Repository Workflow

This file is the repository-wide workflow summary for maintainers, contributors, and coding agents.

## Start Here

Read in this order when you begin work:

1. `WORKFLOW.md`
2. `docs/contributor/agent-workflow.md`
3. `docs/contributor/architecture.zh-CN.md` or `docs/contributor/architecture.en.md`
4. `docs/contributor/testing.md`
5. `docs/contributor/release-process.md` when preparing a release-related change

## Base Workflow

1. Understand the task and read the relevant files and docs.
2. Assess impact before editing by checking affected callers, imports, and execution paths.
3. Keep changes within the requested scope and follow the documented architecture boundaries.
4. Run validation that matches the change, including docs build for docs or workflow changes.
5. Summarize the changed scope, validation, and any follow-up before handoff.

## Detailed Guides

- Base contributor and agent workflow: `docs/contributor/agent-workflow.md`
- Architecture: `docs/contributor/architecture.zh-CN.md`
- English architecture guide: `docs/contributor/architecture.en.md`
- Testing and validation: `docs/contributor/testing.md`
- Release process: `docs/contributor/release-process.md`
- GitNexus-first navigation and impact workflow: `docs/contributor/gitnexus-optional.md`
- Manual fallback navigation without GitNexus: `docs/contributor/fallback-navigation.md`

## Documentation Placement

- Specs: `docs/spec/`
- Plans: `docs/plans/`
- User-facing docs: `docs/user/`
- Contributor and process docs: `docs/contributor/`
- Release notes: `docs/releases/`

Keep `README.md` concise. Long-form user, contributor, troubleshooting, and process documentation belongs under `docs/`.

## Optional Tooling

GitNexus is an optional enhancement for repository understanding, impact analysis, and change-scope review.

- If GitNexus is available locally, treat `docs/contributor/gitnexus-optional.md` as the preferred path for repository navigation and impact analysis.
- If GitNexus is not available locally, use `docs/contributor/fallback-navigation.md` together with the base workflow in this file and `docs/contributor/agent-workflow.md`.
- Optional tooling must never be the only documented way to complete a required engineering step.
