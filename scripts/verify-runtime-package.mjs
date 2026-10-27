import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ALLOWED_ENV_KEYS, findAmbientEnvAccess } from "./ambient-env-guard.mjs";

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const [pack] = JSON.parse(output);
const files = new Set(pack.files.map((file) => String(file.path).replace(/^package\//u, "")));
const requiredFiles = [
  "docs/user/reference/feedback-reporting-api.md",
  "docs/user/reference/feedback-reporting-examples.json",
  "dist/feedback-reporting-worker.js",
  "dist/feedback-detail-worker.js",
  "docs/user/features/feedback-http-reporting.md",
  "docs/user/reference/feedback-reporting.openapi.json",
  "docs/user/reference/feedback-reporting-oceanbase.sql",
  "scripts/feedback-reporting-receiver.mjs",
  "docs/assets/card-template-v2.json",
  "docs/user/features/card-feedback.md",
  "docs/user/getting-started/card-feedback-deployment.md",
  "scripts/feedback-export.mjs",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/card-extensions.js",
  "dist/src/card/card-extension-api.d.ts",
  "openclaw.plugin.json",
];
const missingFiles = requiredFiles.filter((file) => !files.has(file));
const sourceMaps = [...files].filter((file) => file.endsWith(".map"));

if (missingFiles.length > 0) {
  throw new Error(`Runtime package is missing required file(s): ${missingFiles.join(", ")}`);
}
if (sourceMaps.length > 0) {
  throw new Error(`Runtime package must not include source maps: ${sourceMaps.join(", ")}`);
}

const runtime = readFileSync("dist/index.js", "utf8");
if (runtime.includes("child_process")) {
  throw new Error("Runtime package must not include child_process imports");
}

const processExecutionCall =
  /(?<![.\w])(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/u;
if (processExecutionCall.test(runtime)) {
  throw new Error("Runtime package must not include process execution calls");
}

// Secret resolvers must never receive the whole ambient environment: reading one
// authorized variable at a time keeps credential ownership with the host.
//
// This regex keeps the exact fingerprint ClawHub flagged (Issue #608) failing with
// a dedicated message; the syntax-aware guard below is the authoritative check and
// also covers spread, aliasing, and the other equivalent spellings.
const ambientEnvPassThrough = /\benv\s*:\s*process\.env\s*(?:,|\}|\))/u;
if (ambientEnvPassThrough.test(runtime)) {
  throw new Error("Runtime package must not pass the whole process.env to a secret resolver");
}

// The runtime bundle must not reach into ambient environment state at all.
//
// ClawHub's `suspicious.env_credential_access` rule ("environment variable access
// combined with network send") stayed open on the single-key read that used to
// resolve an `env` SecretInput. That read now happens inside the host SDK
// (`openclaw/plugin-sdk/secret-ref-readonly`), and this guard keeps a direct
// ambient read from silently reappearing in the published artifact.
//
// The syntax-aware walker (see `scripts/ambient-env-guard.mjs`) also covers the
// equivalent spellings a text match misses: `process?.env.X`, `process["env"].X`,
// `globalThis.process.env.X`, `const { env } = process`, `const p = process`, and
// `import { env } from "node:process"`. The same guard runs over production source
// in `tests/unit/env-access-structure.test.ts`, so regressions surface before a
// build as well as at release time.
const ambientEnvViolations = findAmbientEnvAccess(runtime, { allowedEnvKeys: ALLOWED_ENV_KEYS });
if (ambientEnvViolations.length > 0) {
  throw new Error(
    "Runtime package must not read ambient environment state outside the documented " +
      `allowlist: ${ambientEnvViolations.join("; ")}`,
  );
}

console.log(`Runtime package check passed: ${requiredFiles.join(", ")}`);
