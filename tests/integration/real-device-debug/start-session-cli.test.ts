import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

describe("dingtalk debug session start CLI", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createTempDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-debug-session-"));
        tempDirs.push(dir);
        return dir;
    }

    it("bootstraps a debug session with manifest, timeline, and operator steps", () => {
        const outputRoot = createTempDir();
        const result = spawnSync(
            process.execPath,
            [
                "scripts/dingtalk-debug-session.mjs",
                "start",
                "--scenario",
                "dm-text-reply",
                "--target-id",
                "cid-test",
                "--target-label",
                "Debug Chat",
                "--operator-mode",
                "external",
                "--trace-suffix",
                "7F2A",
                "--now",
                "2026-03-21T08:15:30.000Z",
                "--output-root",
                outputRoot,
            ],
            {
                cwd: process.cwd(),
                encoding: "utf8",
            },
        );

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("dtdbg-20260321-081530-dm-text-reply");
        expect(result.stdout).toContain("DTDBG-20260321-081530-7F2A");

        const sessionDir = path.join(outputRoot, "2026-03-21", "dtdbg-20260321-081530-dm-text-reply");
        expect(fs.existsSync(path.join(sessionDir, "manifest.json"))).toBe(true);
        expect(fs.existsSync(path.join(sessionDir, "timeline.json"))).toBe(true);
        expect(fs.existsSync(path.join(sessionDir, "operator-steps.md"))).toBe(true);

        const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, "manifest.json"), "utf8"));
        expect(manifest).toMatchObject({
            sessionId: "dtdbg-20260321-081530-dm-text-reply",
            traceToken: "DTDBG-20260321-081530-7F2A",
            status: "created",
        });

        expect(JSON.parse(fs.readFileSync(path.join(sessionDir, "timeline.json"), "utf8"))).toEqual([]);
        expect(fs.readFileSync(path.join(sessionDir, "operator-steps.md"), "utf8")).toContain(
            "DTDBG-20260321-081530-7F2A",
        );
    });
});
