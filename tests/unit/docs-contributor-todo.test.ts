import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import vitepressConfig from "../../docs/.vitepress/config.mts";

const repoRoot = resolve(__dirname, "../..");

describe("contributor docs TODO entry", () => {
    it("exposes the repository TODO page through a docs symlink", () => {
        const todoEntryPath = resolve(repoRoot, "docs/contributor/todo.md");

        expect(lstatSync(todoEntryPath).isSymbolicLink()).toBe(true);
        expect(readlinkSync(todoEntryPath)).toBe("../../TODO.md");
    });

    it("adds the TODO page to the contributor sidebar", () => {
        const sidebar = vitepressConfig.themeConfig?.sidebar as
            | Record<string, Array<{ items?: Array<{ text: string; link: string }> }>>
            | undefined;

        const contributorGroups = sidebar?.["/contributor/"] ?? [];
        const contributorLinks = contributorGroups.flatMap((group) => group.items ?? []).map((item) => item.link);

        expect(contributorLinks).toContain("/contributor/todo");
    });

    it("links to the TODO page from the contributor landing page", () => {
        const contributorIndex = readFileSync(resolve(repoRoot, "docs/contributor/index.md"), "utf8");

        expect(contributorIndex).toContain("[仓库 TODO](todo.md)");
    });

    it("uses dynamic vertical overflow for the docs sidebar", () => {
        const css = readFileSync(resolve(repoRoot, "docs/.vitepress/theme/custom.css"), "utf8");

        expect(css).toContain(".VPSidebar");
        expect(css).toContain("overflow-y: auto");
    });
});
