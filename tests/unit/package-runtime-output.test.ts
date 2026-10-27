import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

describe("npm runtime package contract", () => {
  it("publishes compiled runtime output for OpenClaw 2026.5.4 installs", () => {
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.files).toContain("dist/**/*.js");
    expect(packageJson.files).toContain("dist/**/*.d.ts");
    expect(packageJson.openclaw.extensions).toEqual(["./index.ts"]);
    expect(packageJson.openclaw.runtimeExtensions).toEqual(["./dist/index.js"]);
    expect(packageJson.scripts.build).toBe("pnpm run build:runtime && pnpm run build:types");
    expect(packageJson.scripts["pack:check"]).toBe("node scripts/verify-runtime-package.mjs");
  });

  it("ships the feedback template, installation guide and local export tool", () => {
    expect(packageJson.files).toContain("docs/assets/card-template-v2.json");
    expect(packageJson.files).toContain("docs/user/features/card-feedback.md");
    expect(packageJson.files).toContain("docs/user/getting-started/card-feedback-deployment.md");
    expect(packageJson.files).toContain("scripts/feedback-export.mjs");
  });

  it("does not publish runtime code paths that use shell execution", () => {
    expect(packageJson.files).not.toContain("scripts/**/*.js");
    expect(packageJson.files).not.toContain("scripts/**/*.mjs");
  });
});
