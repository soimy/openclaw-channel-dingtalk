import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

describe("docs deployment configuration", () => {
    it("disables Vercel git auto deployments in vercel.json", () => {
        const vercelConfig = JSON.parse(readFileSync(resolve(repoRoot, "vercel.json"), "utf8")) as {
            git?: {
                deploymentEnabled?: boolean;
            };
        };

        expect(vercelConfig.git?.deploymentEnabled).toBe(false);
    });

    it("defines a Vercel deployment workflow driven by GitHub Actions", () => {
        const workflowPath = resolve(repoRoot, ".github/workflows/docs-vercel.yml");

        expect(existsSync(workflowPath)).toBe(true);

        const workflow = readFileSync(workflowPath, "utf8");

        expect(workflow).toContain("name: Docs Vercel");
        expect(workflow).toContain("pull_request:");
        expect(workflow).toContain("push:");
        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).toContain("VERCEL_TOKEN");
        expect(workflow).toContain("VERCEL_ORG_ID");
        expect(workflow).toContain("VERCEL_PROJECT_ID");
        expect(workflow).toContain("Check Vercel secrets");
        expect(workflow).not.toContain("if: ${{ env.VERCEL_TOKEN");
        expect(workflow).toContain("pnpm dlx vercel@latest pull");
        expect(workflow).toContain("pnpm dlx vercel@latest build");
        expect(workflow).toContain("pnpm dlx vercel@latest deploy --prebuilt");
    });

    it("updates repository entry points to the new Vercel docs workflow", () => {
        const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
        const developmentDoc = readFileSync(resolve(repoRoot, "docs/contributor/development.md"), "utf8");

        expect(readme).toContain("https://dingtalk-channel.nanoo.app/");
        expect(readme).not.toContain("文档部署工作流");
        expect(readme).not.toContain("actions/workflows/docs-pages.yml");
        expect(developmentDoc).toContain("GitHub Actions");
        expect(developmentDoc).toContain("Vercel");
        expect(developmentDoc).not.toContain("GitHub Pages");
    });
});
