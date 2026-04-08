import { describe, expect, it } from "vitest";

import { buildReleaseSidebarItems } from "../../docs/.vitepress/releases-sidebar";

describe("release sidebar generation", () => {
    it("keeps latest first and sorts discovered release notes by semver descending", () => {
        const items = buildReleaseSidebarItems([
            "index.md",
            "v3.4.2.md",
            "v3.5.0.md",
            "latest.md",
            "v3.5.3.md",
            "v3.2.0.md",
            "v3.5.2.md",
        ]);

        expect(items).toEqual([
            { text: "最新版本", link: "/releases/latest" },
            { text: "v3.5.3", link: "/releases/v3.5.3" },
            { text: "v3.5.2", link: "/releases/v3.5.2" },
            { text: "v3.5.0", link: "/releases/v3.5.0" },
            { text: "v3.4.2", link: "/releases/v3.4.2" },
            { text: "v3.2.0", link: "/releases/v3.2.0" },
        ]);
    });

    it("ignores non-release markdown files", () => {
        const items = buildReleaseSidebarItems([
            "index.md",
            "latest.md",
            "draft.md",
            "v3.5.md",
            "v3.5.3-beta.0.md",
            "release-notes.md",
        ]);

        expect(items).toEqual([{ text: "最新版本", link: "/releases/latest" }]);
    });
});
