#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function runGit(args) {
    return execFileSync("git", args, {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function main() {
    const baseRef = process.env.GITHUB_BASE_REF || "origin/main";
    const base = process.env.VERSION_GUARD_BASE || baseRef;

    let changedFiles = "";
    try {
        changedFiles = runGit(["diff", "--name-only", `${base}...HEAD`]);
    } catch (error) {
        console.error(`[version-guard] failed to diff against ${base}`);
        throw error;
    }

    const files = changedFiles
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    if (!files.includes("package.json")) {
        console.log("[version-guard] package.json version unchanged");
        return;
    }

    const diff = runGit(["diff", "--unified=0", `${base}...HEAD`, "--", "package.json"]);
    const versionLineChanged = diff
        .split("\n")
        .some((line) => /^[-+]\s*"version":\s*"/.test(line));

    if (!versionLineChanged) {
        console.log("[version-guard] package.json changed without touching version");
        return;
    }

    console.error("[version-guard] Detected package.json version change in branch diff.");
    console.error("[version-guard] Do not bump package.json version in normal PRs.");
    console.error("[version-guard] Release owners must run `npm version patch|minor|major` on the release branch/mainline, then push the generated tag to trigger CI publish.");
    process.exit(1);
}

main();
