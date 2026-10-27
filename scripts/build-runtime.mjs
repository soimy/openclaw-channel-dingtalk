import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

await build({
  bundle: true,
  entryPoints: { index: "index.ts", "card-extensions": "src/card/card-extension-api.ts" },
  format: "esm",
  logLevel: "info",
  outdir: "dist",
  packages: "external",
  platform: "node",
  sourcemap: false,
  target: "node22",
  tsconfigRaw: {
    compilerOptions: {
      esModuleInterop: true,
      module: "ESNext",
      moduleResolution: "bundler",
      target: "ES2023",
    },
  },
});

// Separate worker entry: heavy transcript processing and HTTP never enter the
// gateway event loop. Keep SDK imports external and lazy within the worker.
await build({
  bundle: true,
  entryPoints: {
    "feedback-reporting-worker": "src/command/feedback-reporting-worker.ts",
    "feedback-detail-worker": "src/command/feedback-detail-worker.ts",
  },
  format: "esm",
  logLevel: "info",
  outdir: "dist",
  packages: "external",
  platform: "node",
  sourcemap: false,
  target: "node22",
});
