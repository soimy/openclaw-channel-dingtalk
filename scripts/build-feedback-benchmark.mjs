#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
// Developer-only synthetic probe. Does not read employee state or start a gateway.
import { build } from "esbuild";
const out = path.resolve(process.argv[2] ?? ".local/feedback-reporting-benchmark");
await mkdir(out, { recursive: true });
for (const [entry, name] of [
  ["scripts/feedback-reporting-benchmark.ts", "feedback-reporting-benchmark.mjs"],
  ["scripts/feedback-retry-benchmark.ts", "feedback-retry-benchmark.mjs"],
  ["src/command/feedback-reporting-worker.ts", "feedback-reporting-worker.js"],
  ["src/command/feedback-detail-worker.ts", "feedback-detail-worker.js"],
  ["scripts/feedback-host-compatibility.ts", "feedback-host-compatibility.mjs"],
]) {
  await build({
    entryPoints: [entry],
    outfile: path.join(out, name),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
  });
}
await writeFile(path.join(out, "package.json"), JSON.stringify({ private: true, type: "module" }));
process.stdout.write(`Synthetic benchmark bundle: ${out}\n`);
