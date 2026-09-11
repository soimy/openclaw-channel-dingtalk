import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
});
const [pack] = JSON.parse(output);
const files = new Set(
    pack.files.map((file) => String(file.path).replace(/^package\//u, "")),
);
const requiredFiles = ["dist/index.js", "dist/index.d.ts", "openclaw.plugin.json"];
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

const processExecutionCall = /(?<![.\w])(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/u;
if (processExecutionCall.test(runtime)) {
    throw new Error("Runtime package must not include process execution calls");
}

// Secret resolvers must never receive the whole ambient environment: reading one
// authorized variable at a time keeps credential ownership with the host.
//
// This is a shape heuristic against the exact fingerprint that ClawHub flagged
// (Issue #608), not an exhaustive dataflow analysis: indirect forms such as
// `env: { ...process.env }`, `const e = process.env; env: e`, or `env: process.env
// as any` would not match, and a single-key read (`process.env[id]`) is allowed.
const ambientEnvPassThrough = /\benv\s*:\s*process\.env\s*(?:,|\}|\))/u;
if (ambientEnvPassThrough.test(runtime)) {
    throw new Error("Runtime package must not pass the whole process.env to a secret resolver");
}

console.log(`Runtime package check passed: ${requiredFiles.join(", ")}`);
