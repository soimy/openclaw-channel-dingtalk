#!/usr/bin/env node

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";

const steps = [
  { name: "fetch-origin-main", cmd: "git", args: ["fetch", "origin", "main"] },
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
    if (step.name === "fetch-origin-main") {
      assertLatestMainMergeable();
    }
  }
  process.stdout.write("\n[ci:preflight] all checks passed.\n");
}

function assertLatestMainMergeable() {
  const mergeBase = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    encoding: "utf8",
  }).trim();
  const mergeTree = execFileSync("git", ["merge-tree", mergeBase, "HEAD", "origin/main"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const hasConflict =
    mergeTree.includes("changed in both") ||
    mergeTree.includes("<<<<<<<") ||
    mergeTree.includes(">>>>>>>") ||
    mergeTree.includes("||");
  if (hasConflict) {
    throw new Error(
      "[ci:preflight] branch is not mergeable with latest origin/main; resolve conflicts before updating the PR.",
    );
  }
  process.stdout.write("[ci:preflight] latest origin/main mergeability check passed.\n");
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
