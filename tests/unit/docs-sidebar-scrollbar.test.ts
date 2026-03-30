import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

describe("docs sidebar scrollbar visibility", () => {
    it("wires a dedicated sidebar scroll visibility helper into the docs theme", () => {
        const themeIndex = readFileSync(resolve(repoRoot, "docs/.vitepress/theme/index.ts"), "utf8");
        const helperPath = resolve(repoRoot, "docs/.vitepress/theme/sidebar-scroll-visibility.ts");

        expect(themeIndex).toContain("SidebarScrollVisibility");
        expect(existsSync(helperPath)).toBe(true);

        if (!existsSync(helperPath)) {
            return;
        }

        const helperSource = readFileSync(helperPath, "utf8");

        expect(helperSource).toContain('querySelector<HTMLElement>(".VPSidebar")');
        expect(helperSource).toContain('addEventListener("scroll"');
        expect(helperSource).toContain('classList.add("is-scrolling")');
        expect(helperSource).toContain('classList.remove("is-scrolling")');
    });

    it("keeps the sidebar scrollbar hidden by default and reveals it only while scrolling", () => {
        const css = readFileSync(resolve(repoRoot, "docs/.vitepress/theme/custom.css"), "utf8");

        expect(css).toContain(".VPSidebar::-webkit-scrollbar");
        expect(css).toContain("scrollbar-width: none");
        expect(css).toContain(".VPSidebar.is-scrolling::-webkit-scrollbar");
        expect(css).toContain(".VPSidebar.is-scrolling");
    });
});
