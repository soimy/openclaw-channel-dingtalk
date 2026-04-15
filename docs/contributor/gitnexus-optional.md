# GitNexus Optional Workflow

GitNexus is the preferred repository-understanding and impact-analysis path when it is available locally. This document describes the GitNexus-first workflow for this repository and the corresponding fallback path when GitNexus is unavailable.

## Purpose

Use GitNexus when it is available locally and you want graph-aware help for repository exploration, impact analysis, refactor safety, and change-scope review. This document complements the base workflow in `WORKFLOW.md` and `docs/contributor/agent-workflow.md`.

## GitNexus-First Workflow

When GitNexus is available locally, prefer it for the parts of the workflow that involve repository navigation, execution-flow tracing, blast-radius analysis, or change-scope verification.

### 1. Understand the task

Use GitNexus first when you need to answer questions such as:

- Where does this behavior live?
- Which execution flow handles this request?
- Which modules participate in this feature?
- Which file should I read first?

Recommended approach:

- Start with repository context and index freshness.
- Use concept-oriented query to find relevant flows and symbols.
- Use symbol context when you need a focused view of callers, callees, and participating processes.

### 2. Assess impact before editing

Use GitNexus first when you need to answer:

- What breaks if I change this function, class, or method?
- Which direct callers and indirect dependents are affected?
- Is this rename or refactor riskier than it looks?

Recommended approach:

- Run graph-aware impact analysis before editing symbols with multiple callers or cross-module usage.
- Treat HIGH or CRITICAL impact results as a cue to expand validation and communicate blast radius clearly.
- For refactors and symbol renames, prefer graph-aware rename and context-aware review over blind repository-wide text replacement.

### 3. Validate and prepare handoff

Use GitNexus first when you need to answer:

- Did this change affect the scope I expected?
- Did I accidentally touch unrelated execution flows?
- Do I need broader regression testing before commit?

Recommended approach:

- Review the diff as usual.
- Then use change detection to confirm affected symbols and execution paths.
- If the detected scope is broader than expected, either reduce the change or expand the validation plan.

## When to Use GitNexus

GitNexus is especially helpful for:

- Exploring unfamiliar architecture or execution paths
- Assessing blast radius before editing a function, class, or method
- Tracing likely callers and affected flows during debugging
- Reviewing rename or refactor safety
- Verifying that change scope matches the intended symbols and flows before commit

## Recommended Usage Notes

- Start by checking repository context and index freshness.
- If the index is stale, re-run analysis before relying on graph results.
- Prefer GitNexus over manually maintaining long `Where to find` lists when local GitNexus is available.
- Prefer graph-aware rename workflows over blind repository-wide text replacement when you are renaming symbols.
- Treat GitNexus as the first stop for codebase navigation when available, not merely as an optional afterthought.

## Indexing This Repository

When running `gitnexus analyze` on this repository, **always use the `--skip-agents-md` flag**:

```bash
gitnexus analyze --skip-agents-md
```

This repository maintains detailed GitNexus guidance in this document rather than in the root `AGENTS.md` / `CLAUDE.md` entry files. The `--skip-agents-md` flag prevents GitNexus from injecting its standard usage block into those thin entry documents, preserving the repository's documentation layering strategy.

If you accidentally run `gitnexus analyze` without this flag and the entry files are modified, remove the injected `<!-- gitnexus:start --> ... <!-- gitnexus:end -->` block before committing.

## Relationship to Manual Navigation Guides

This repository may still provide manual navigation and fallback guidance for contributors who do not have GitNexus locally. Those guides are secondary disclosure and should mainly be used when GitNexus is unavailable.

If GitNexus is available locally, use this document first. If GitNexus is unavailable, use `docs/contributor/fallback-navigation.md`.

## Fallback

If GitNexus is unavailable locally:

- Continue with `WORKFLOW.md` and `docs/contributor/agent-workflow.md`.
- Use `docs/contributor/fallback-navigation.md` for manual navigation, file entry points, and hand-traced impact exploration.
- Read the affected files directly.
- Search for callers, imports, and nearby tests manually.
- Run the same repository validation steps that you would run with GitNexus available.

Lack of GitNexus must not block normal development, review, or documentation work in this repository.
