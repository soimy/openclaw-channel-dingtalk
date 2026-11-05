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
        expect(badgeBlock).toContain("img.shields.io/badge/OpenClaw-%3E%3D2026.9.2-0A7CFF");
        expect(badgeBlock).toContain("img.shields.io/npm/v/%40soimy%2Fdingtalk");
        expect(badgeBlock).toContain("img.shields.io/npm/dm/%40soimy%2Fdingtalk");
        expect(badgeBlock).toContain("img.shields.io/github/license/soimy/openclaw-channel-dingtalk");
        expect(badgeBlock).toContain("img.shields.io/badge/Citation-CITATION.cff-1277B5");
        expect(badgeBlock).not.toContain("actions/workflows/docs-vercel.yml");
    });

    it("keeps the advertised minimum host version in sync with the manifest", () => {
        const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
        const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

        // The badge and the install note both advertise the minimum host version that
        // `peerDependencies.openclaw` enforces. Deriving the expectation from the
        // manifest keeps the advertised floor from drifting behind a host bump again
        // (it did during the OpenClaw 2026.8.1 bump in v3.7.0).
        const minimumHostVersion = String(manifest.peerDependencies?.openclaw ?? "").replace(/^[>=^~\s]+/, "");
        expect(minimumHostVersion).toMatch(/^\d{4}\.\d+\.\d+$/);

        const encodedMinimum = `%3E%3D${minimumHostVersion}`;
        expect(readme).toContain(`img.shields.io/badge/OpenClaw-${encodedMinimum}-0A7CFF`);
        expect(readme).toContain(`最小兼容版本为 \`OpenClaw ${minimumHostVersion}\``);
        expect(String(manifest.openclaw?.install?.minHostVersion ?? "")).toContain(minimumHostVersion);
    });

    it("defines docs styles that keep homepage badges on one row with wrapping", () => {
        const css = readFileSync(resolve(repoRoot, "docs/.vitepress/theme/custom.css"), "utf8");

        expect(css).toContain(".vp-doc .repo-badges");
        expect(css).toContain("display: flex");
        expect(css).toContain("flex-wrap: wrap");
        expect(css).toContain(".vp-doc .repo-badges img");
    });
});
