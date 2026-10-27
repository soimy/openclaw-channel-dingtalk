import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/verify-runtime-package.mjs");
const feedbackAssets = ["docs/user/reference/feedback-reporting-api.md", "docs/user/reference/feedback-reporting-examples.json", "dist/feedback-reporting-worker.js", "dist/feedback-detail-worker.js", "docs/user/features/feedback-http-reporting.md", "docs/user/reference/feedback-reporting.openapi.json", "docs/user/reference/feedback-reporting-oceanbase.sql", "scripts/feedback-reporting-receiver.mjs", "docs/assets/card-template-v2.json", "docs/user/features/card-feedback.md",
    "docs/user/getting-started/card-feedback-deployment.md", "scripts/feedback-export.mjs"];

describe("runtime package verification", () => {
    let tempDir: string | undefined;

    afterEach(() => {
        if (tempDir) {
            rmSync(tempDir, { recursive: true, force: true });
            tempDir = undefined;
        }
    });

    it("allows RegExp exec method calls in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
const match = /token-(\\d+)/u.exec("token-42");
export { match };
`);

        expect(() => {
            runVerification(packageDir);
        }).not.toThrow();
    });

    it("rejects standalone process execution calls in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
exec("open https://example.com");
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow("Runtime package must not include process execution calls");
    });

    it("rejects source maps in the published package", () => {
        const packageDir = createRuntimePackageFixture("export {};\n");
        writeFile(join(packageDir, "dist/index.js.map"), "{}\n");
        const packageJson = JSON.parse(
            readFileSync(join(packageDir, "package.json"), "utf8"),
        ) as { files: string[] };
        packageJson.files.push("dist/**/*.map");
        writeJson(join(packageDir, "package.json"), packageJson);

        expect(() => {
            runVerification(packageDir);
        }).toThrow("Runtime package must not include source maps");
    });

    it("rejects passing the whole process.env to a secret resolver", () => {
        const packageDir = createRuntimePackageFixture(`
const resolved = await resolveConfiguredSecretInputString({
  config: hostConfig,
  env: process.env,
  value,
  path: "channels.dingtalk.clientSecret",
});
export { resolved };
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow("Runtime package must not pass the whole process.env to a secret resolver");
    });

    it("allows the documented card template id override in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
const templateId = process.env.DINGTALK_CARD_TEMPLATE_ID || "builtin.schema";
export { templateId };
`);

        expect(() => {
            runVerification(packageDir);
        }).not.toThrow();
    });

    it("rejects a dynamic single-key environment read in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
function readSecret(id) {
  return process.env[id];
}
export { readSecret };
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow(
            "Runtime package must not read ambient environment state outside the documented allowlist",
        );
    });

    it("rejects an undocumented static environment read in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
const secret = process.env.DINGTALK_CLIENT_SECRET;
export { secret };
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow(
            "Runtime package must not read ambient environment state outside the documented allowlist",
        );
    });

    it("rejects handing the bare ambient environment around in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
const ambient = process.env;
export { ambient };
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow(
            "Runtime package must not read ambient environment state outside the documented allowlist",
        );
    });

    it("allows the documented card template id override through bracket access", () => {
        const packageDir = createRuntimePackageFixture(`
const templateId = process.env["DINGTALK_CARD_TEMPLATE_ID"] || "builtin.schema";
export { templateId };
`);

        expect(() => {
            runVerification(packageDir);
        }).not.toThrow();
    });

    it("allows non-environment uses of the process global in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
const isWindows = process.platform === "win32";
const cwd = process.cwd();
const pid = process.pid;
export { isWindows, cwd, pid };
`);

        expect(() => {
            runVerification(packageDir);
        }).not.toThrow();
    });

    it("rejects an optional-chained environment read in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
const secret = process?.env?.DINGTALK_CLIENT_SECRET;
export { secret };
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow(
            "Runtime package must not read ambient environment state outside the documented allowlist",
        );
    });

    it("rejects a computed property environment read in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
const secret = process["env"].DINGTALK_CLIENT_SECRET;
export { secret };
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow(
            "Runtime package must not read ambient environment state outside the documented allowlist",
        );
    });

    it("rejects reading the environment off the global object in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
const secret = globalThis.process.env.DINGTALK_CLIENT_SECRET;
export { secret };
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow(
            "Runtime package must not read ambient environment state outside the documented allowlist",
        );
    });

    it("rejects destructuring the environment out of the process global", () => {
        const packageDir = createRuntimePackageFixture(`
const { env } = process;
const secret = env.DINGTALK_CLIENT_SECRET;
export { secret };
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow(
            "Runtime package must not read ambient environment state outside the documented allowlist",
        );
    });

    it("rejects aliasing the process global in runtime output", () => {
        const packageDir = createRuntimePackageFixture(`
const proc = process;
const secret = proc.env.DINGTALK_CLIENT_SECRET;
export { secret };
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow(
            "Runtime package must not read ambient environment state outside the documented allowlist",
        );
    });

    it("rejects importing the environment from the process module", () => {
        const packageDir = createRuntimePackageFixture(`
import { env } from "node:process";
const secret = env.DINGTALK_CLIENT_SECRET;
export { secret };
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow(
            "Runtime package must not read ambient environment state outside the documented allowlist",
        );
    });

    it("rejects object-rest destructuring of the process global", () => {
        const packageDir = createRuntimePackageFixture(`
const { ...proc } = process;
const secret = proc.env.DINGTALK_CLIENT_SECRET;
export { secret };
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow(
            "Runtime package must not read ambient environment state outside the documented allowlist",
        );
    });

    it("rejects a computed string env key destructured from the process global", () => {
        const packageDir = createRuntimePackageFixture(`
const { ["env"]: e } = process;
const secret = e.DINGTALK_CLIENT_SECRET;
export { secret };
`);

        expect(() => {
            runVerification(packageDir);
        }).toThrow(
            "Runtime package must not read ambient environment state outside the documented allowlist",
        );
    });

    function runVerification(packageDir: string): void {
        execFileSync(process.execPath, [scriptPath], {
            cwd: packageDir,
            encoding: "utf8",
            env: {
                ...process.env,
                npm_config_cache: join(packageDir, ".npm-cache"),
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
    }

    function createRuntimePackageFixture(runtimeCode: string): string {
        tempDir = mkdtempSync(join(tmpdir(), "dingtalk-runtime-package-"));
        writeJson(join(tempDir, "package.json"), {
            name: "dingtalk-runtime-package-fixture",
            version: "0.0.0",
            type: "module",
            files: ["dist/**/*.js", "dist/**/*.d.ts", "openclaw.plugin.json", ...feedbackAssets],
        });
        writeJson(join(tempDir, "openclaw.plugin.json"), {});
        for (const asset of feedbackAssets) { writeFile(join(tempDir, asset), "fixture\n"); }
        writeFile(join(tempDir, "dist/index.js"), runtimeCode);
        writeFile(join(tempDir, "dist/index.d.ts"), "export {};\n");
        writeFile(join(tempDir, "dist/card-extensions.js"), "export {};\n");
        writeFile(join(tempDir, "dist/src/card/card-extension-api.d.ts"), "export {};\n");

        return tempDir;
    }

    function writeJson(filePath: string, value: unknown): void {
        writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
    }

    function writeFile(filePath: string, content: string): void {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, content);
    }
});
