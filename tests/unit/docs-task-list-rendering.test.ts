import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMarkdownRenderer } from "vitepress";
import { describe, expect, it } from "vitest";
import vitepressConfig from "../../docs/.vitepress/config.mts";

const repoRoot = resolve(__dirname, "../..");
const docsRoot = resolve(repoRoot, "docs");

describe("docs task list rendering", () => {
    it("renders markdown checklist syntax as disabled checkbox inputs", async () => {
        const md = await createMarkdownRenderer(docsRoot, vitepressConfig.markdown, vitepressConfig.base);
        const html = md.render("- [ ] pending item\n- [x] done item\n");

        expect(html).toContain('type="checkbox"');
        expect(html).toContain('disabled="disabled"');
        expect(html).toContain('checked="checked"');
        expect(html).not.toContain("[ ] pending item");
        expect(html).not.toContain("[x] done item");
    });

    it("renders the contributor TODO page with checkbox inputs instead of raw markers", async () => {
        const md = await createMarkdownRenderer(docsRoot, vitepressConfig.markdown, vitepressConfig.base);
        const todoSource = readFileSync(resolve(repoRoot, "TODO.md"), "utf8");
        const html = md.render(todoSource);

        expect(html).toContain('type="checkbox"');
        expect(html).toContain('disabled="disabled"');
        expect(html).not.toContain("<li>[ ] ");
        expect(html).not.toContain("<li>[x] ");
    });

    it("does not render nested anchor tags for literal media placeholder text inside issue titles", async () => {
        const md = await createMarkdownRenderer(docsRoot, vitepressConfig.markdown, vitepressConfig.base);
        const todoSource = readFileSync(resolve(repoRoot, "TODO.md"), "utf8");
        const html = md.render(todoSource);

        expect(html).not.toContain('href="media:image"');
        expect(html).not.toContain("</a></a>");
    });
});
