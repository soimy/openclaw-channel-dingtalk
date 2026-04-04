# Vercel CI Deployment Design

This change replaces the repository's docs publishing path from GitHub Pages artifact deployment to a Vercel deployment flow driven entirely by GitHub Actions.

## Goals

- Turn off Vercel's built-in Git auto deployment for both branch pushes and pull requests.
- Build the VitePress docs inside GitHub Actions instead of on Vercel.
- Upload prebuilt artifacts to Vercel with preview deployments for pull requests and production deployments for `main`.
- Remove the current GitHub Pages deployment workflow so there is a single docs publishing path.
- Keep the existing VitePress root-path support from commit `7d4299d3b3dc579d49a8bd01b9f9adccd8a6f1ab`.

## Non-Goals

- Reworking the docs content structure or the VitePress theme.
- Changing package publishing or npm release workflows.
- Hardcoding a new public docs domain in repository metadata when the active Vercel production domain is not declared in the repository itself.

## Current Problem

The repository currently has split deployment behavior:

- `vercel.json` supports root-path builds for Vercel.
- `.github/workflows/docs-pages.yml` still builds and publishes the public docs site through GitHub Pages.
- If the repository is connected to Vercel Git integration, Vercel can also create deployments directly from pushes and pull requests.

That combination creates overlapping automation paths and makes it unclear which system owns the public deployment.

## Design

### 1. Disable Vercel Git Auto Deployments

Add `git.deploymentEnabled: false` to `vercel.json`.

This follows Vercel's documented configuration for turning off all automatic Git-triggered deployments so only the explicit CI workflow can create deployments.

### 2. Replace GitHub Pages Workflow with a Vercel Workflow

Remove the current Pages artifact deployment workflow and replace it with a Vercel-specific workflow that:

- runs on `pull_request` for docs-related changes to create preview deployments
- runs on `push` to `main` for docs-related changes to create production deployments
- can be started manually through `workflow_dispatch`

The workflow should:

1. check out the repository
2. set up `pnpm` and Node.js
3. install dependencies
4. pull Vercel environment/project settings with `vercel pull`
5. build locally with `vercel build`
6. deploy the prebuilt `.vercel/output` bundle with `vercel deploy --prebuilt`

### 3. Secret Contract

The workflow relies on the standard Vercel GitHub Actions secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

These are not committed to the repository. Contributor-facing docs should call out that the workflow requires them.

### 4. Repository Surface Updates

Update repository-facing documentation so it no longer points contributors to GitHub Pages deployment automation.

Changes should include:

- README badge link for docs deployment workflow
- contributor development guidance that explains docs are built locally with VitePress and deployed by GitHub Actions to Vercel

The public docs site URL in package metadata should remain unchanged in this iteration unless the repository explicitly declares the authoritative Vercel production domain.

## Verification

- Add unit tests that lock in:
  - `vercel.json` disables Git auto deployments
  - the docs deployment workflow uses `vercel pull`, `vercel build`, and `vercel deploy --prebuilt`
  - repository entry points no longer reference the old GitHub Pages deployment workflow
- Run focused unit tests for the new deployment assertions.
- Run `pnpm run docs:build` to confirm the docs still build successfully under the repository's VitePress configuration.
