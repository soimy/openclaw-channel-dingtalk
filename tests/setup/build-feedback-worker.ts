import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

/** Keep real worker tests independent of dist and any running development gateway. */
export default async function setup() {
  await mkdir(".local/test-host", { recursive: true, mode: 0o700 });
  await writeFile(".local/test-host/openclaw.json", "{}\n", { mode: 0o600 });
  await build({
    entryPoints: {
      "feedback-reporting-worker": "src/command/feedback-reporting-worker.ts",
      "feedback-detail-worker": "src/command/feedback-detail-worker.ts",
    },
    outdir: ".local/test-runtime",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    logLevel: "silent",
  });
}
