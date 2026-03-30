# Contributor TODO Page And Sidebar Scrollbar Design

This change extends the VitePress contributor docs in two small, coordinated ways.

## Goals

- Expose the repository root `TODO.md` inside the docs site without copying its content.
- Keep the contributor docs navigation discoverable by linking the TODO page from the contributor area.
- Make the docs sidebar scrollbar appear only when content actually overflows.

## Design

Use a filesystem symlink at `docs/contributor/todo.md` that points to `../../TODO.md`. This keeps the docs page content sourced from the single repository TODO file while making it available under the published contributor docs path.

Add the new page to the contributor sidebar in `docs/.vitepress/config.mts`, and list it from `docs/contributor/index.md` so the page is discoverable both from navigation chrome and from the contributor landing page.

Adjust `docs/.vitepress/theme/custom.css` with a focused sidebar overflow rule so the sidebar uses dynamic vertical overflow behavior instead of always reserving a persistent scrollbar.

## Verification

- Add a unit test that asserts the contributor TODO docs entry is a symlink to `../../TODO.md`.
- Assert the contributor sidebar includes `/contributor/todo`.
- Assert the contributor landing page links to `todo.md`.
- Assert the custom docs CSS sets dynamic vertical overflow for `.VPSidebar`.
