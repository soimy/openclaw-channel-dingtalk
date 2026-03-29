import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

describe("docs homepage badge layout", () => {
    it("keeps README badges inside a dedicated container", () => {
        const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

        expect(readme).toContain('<p class="repo-badges">');
        expect(readme).toContain("img.shields.io/npm/v/%40soimy%2Fdingtalk");
        expect(readme).toContain("img.shields.io/npm/dm/%40soimy%2Fdingtalk");
    });

    it("defines docs styles that keep homepage badges on one row with wrapping", () => {
        const css = readFileSync(resolve(repoRoot, "docs/.vitepress/theme/custom.css"), "utf8");

        expect(css).toContain(".vp-doc .repo-badges");
        expect(css).toContain("display: flex");
        expect(css).toContain("flex-wrap: wrap");
        expect(css).toContain(".vp-doc .repo-badges img");
    });
});
