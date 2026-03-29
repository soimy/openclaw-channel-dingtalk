import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../..");

const directSdkFiles = [
    "index.ts",
    "src/channel.ts",
    "src/config.ts",
    "src/onboarding.ts",
    "src/runtime.ts",
    "src/types.ts",
    "src/targeting/agent-name-matcher.ts",
    "src/targeting/agent-routing.ts",
    "src/targeting/target-directory-adapter.ts",
];

const scopedSdkTestFiles = [
    "tests/integration/status-probe.test.ts",
    "tests/unit/agent-name-matcher.test.ts",
];

describe("plugin-sdk import structure", () => {
    it("does not keep the local sdk-compat bridge once minimum openclaw is 2026.3.14+", () => {
        expect(existsSync(resolve(repoRoot, "src/sdk-compat.ts"))).toBe(false);
    });

    it("uses direct plugin-sdk imports instead of the local sdk-compat bridge", () => {
        for (const relativePath of directSdkFiles) {
            const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
            expect(content).not.toMatch(/from\s+["'](?:\.\.\/|\.\/)*sdk-compat["']/);
        }
    });

    it("keeps tests on scoped plugin-sdk subpaths instead of the root barrel", () => {
        for (const relativePath of scopedSdkTestFiles) {
            const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
            expect(content).not.toMatch(/from\s+["']openclaw\/plugin-sdk["']/);
        }
    });

    it("does not keep openclaw in devDependencies where plugin install omits it", () => {
        const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
            devDependencies?: Record<string, string>;
            peerDependencies?: Record<string, string>;
            openclaw?: {
                install?: {
                    minHostVersion?: string;
                };
            };
        };
        expect(packageJson.devDependencies?.openclaw).toBeUndefined();
        expect(packageJson.peerDependencies?.openclaw).toBeDefined();
        expect(packageJson.peerDependencies?.openclaw).toBe(">=2026.3.24");
        expect(packageJson.openclaw?.install?.minHostVersion).toBe(">=2026.3.24");
    });
});
