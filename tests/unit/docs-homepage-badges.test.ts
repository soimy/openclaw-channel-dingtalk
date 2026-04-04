import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

describe("docs homepage badge layout", () => {
    it("keeps exactly five core badges inside a dedicated container", () => {
        const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
        const badgeBlockMatch = readme.match(/<p class="repo-badges">[\s\S]*?<\/p>/);
        const badgeAnchors = [...readme.matchAll(/<a href="[^"]+"><img alt="[^"]+" src="https:\/\/img\.shields\.io\/[^"]+"><\/a>/g)];
        const badgeBlock = badgeBlockMatch?.[0] ?? "";

        expect(readme).toContain('<p class="repo-badges">');
        expect(badgeBlockMatch).not.toBeNull();
        expect(badgeAnchors).toHaveLength(5);
        expect(badgeBlock).toContain("img.shields.io/badge/OpenClaw-%3E%3D2026.3.24-0A7CFF");
        expect(badgeBlock).toContain("img.shields.io/npm/v/%40soimy%2Fdingtalk");
        expect(badgeBlock).toContain("img.shields.io/npm/dm/%40soimy%2Fdingtalk");
        expect(badgeBlock).toContain("img.shields.io/github/license/soimy/openclaw-channel-dingtalk");
        expect(badgeBlock).toContain("img.shields.io/badge/Citation-CITATION.cff-1277B5");
        expect(badgeBlock).not.toContain("actions/workflows/docs-vercel.yml");
    });

    it("defines docs styles that keep homepage badges on one row with wrapping", () => {
        const css = readFileSync(resolve(repoRoot, "docs/.vitepress/theme/custom.css"), "utf8");

        expect(css).toContain(".vp-doc .repo-badges");
        expect(css).toContain("display: flex");
        expect(css).toContain("flex-wrap: wrap");
        expect(css).toContain(".vp-doc .repo-badges img");
    });
});
