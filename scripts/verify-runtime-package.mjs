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

if (missingFiles.length > 0) {
    throw new Error(`Runtime package is missing required file(s): ${missingFiles.join(", ")}`);
}

const runtime = readFileSync("dist/index.js", "utf8");
if (runtime.includes("child_process")) {
    throw new Error("Runtime package must not include child_process imports");
}

const processExecutionCall = /(?<![.\w])(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/u;
if (processExecutionCall.test(runtime)) {
    throw new Error("Runtime package must not include process execution calls");
}

console.log(`Runtime package check passed: ${requiredFiles.join(", ")}`);
