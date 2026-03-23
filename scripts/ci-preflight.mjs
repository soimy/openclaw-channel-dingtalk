#!/usr/bin/env node

import { spawn } from "node:child_process";

const steps = [
  { name: "type-check", cmd: "pnpm", args: ["run", "type-check"] },
  { name: "lint", cmd: "pnpm", args: ["run", "lint"] },
  { name: "test", cmd: "pnpm", args: ["test"] },
];

function runStep(step) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`\n[ci:preflight] running ${step.name}: ${step.cmd} ${step.args.join(" ")}\n`);
    const child = spawn(step.cmd, step.args, {
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`[ci:preflight] ${step.name} terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`[ci:preflight] ${step.name} failed with exit code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function main() {
  process.stdout.write(
    "[ci:preflight] CI parity contract: update PRs only after type-check, lint, and full pnpm test pass locally.\n",
  );
  for (const step of steps) {
    await runStep(step);
  }
  process.stdout.write("\n[ci:preflight] all checks passed.\n");
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
