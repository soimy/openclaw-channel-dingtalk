# Docs Homepage And Branding Design

## Summary

This change updates the VitePress docs site in three coordinated ways:

1. The docs homepage should render the repository root `README.md` as the single content source.
2. The top navigation should expose a direct `GitHub` link as the final top-level item.
3. The new `dingclaw.svg` brand asset should become the docs logo, favicon, and the README hero image.

## Goals

- Keep `README.md` as the canonical homepage content source
- Improve GitHub discoverability from the docs navbar
- Apply a consistent DingClaw visual identity across README and the docs site

## Constraints

- Preserve the current `docs/` Markdown information architecture
- Avoid duplicating homepage content between `README.md` and `docs/index.md`
- Keep internal docs exclusions unchanged

## Recommended Approach

### Homepage

Use `docs/index.md` as a thin wrapper page that includes `../README.md` via VitePress markdown inclusion.

Because README links and image paths are written for repository context, add a small VitePress markdown transform that rewrites only link/image targets relevant to the included README when rendering the docs site.

### Branding Assets

Treat `docs/assets/dingclaw.svg` as the design source and publish a site-safe copy under `docs/public/assets/dingclaw.svg`.

Use that public asset for:

- `themeConfig.logo`
- favicon via `head`

### README

Add the new logo at the top of `README.md` using the repository-relative asset path so GitHub renders it correctly.

## Acceptance Criteria

- Visiting `/openclaw-channel-dingtalk/` shows README content as the homepage
- Top navbar ends with a visible `GitHub` link
- Favicon and navbar logo both use DingClaw branding
- README renders the DingClaw logo on GitHub
