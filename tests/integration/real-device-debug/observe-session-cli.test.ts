import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { startSession } from "../../../scripts/real-device-debug/start-session.mjs";

describe("dingtalk debug session observe CLI", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createTempDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-debug-observe-"));
        tempDirs.push(dir);
        return dir;
    }

    it("records an observation file and updates the session status", () => {
        const outputRoot = createTempDir();
        const { filePaths } = startSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: "dm-text-reply",
            targetId: "cid-test",
            targetLabel: "Debug Chat",
            traceSuffix: "7F2A",
        });
        const observationPath = path.join(outputRoot, "observation.json");
        fs.writeFileSync(
            observationPath,
            JSON.stringify({
                sentAt: "2026-03-21T08:16:00.000Z",
                replyObservedAt: "2026-03-21T08:16:18.000Z",
                sendStatus: "sent",
                replyStatus: "visible",
                replyPreview: "ok",
                screenshots: [path.join(filePaths.sessionDir, "screenshots", "visible.png")],
            }),
            "utf8",
        );

        const result = spawnSync(
            process.execPath,
            [
                "scripts/dingtalk-debug-session.mjs",
                "observe",
                "--session-dir",
                filePaths.sessionDir,
                "--observation-file",
                observationPath,
            ],
            {
                cwd: process.cwd(),
                encoding: "utf8",
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("status=reply_observed");

        const manifest = JSON.parse(fs.readFileSync(filePaths.manifestPath, "utf8"));
        expect(manifest.operator.observationStatus).toBe("reply_observed");
        expect(manifest.observations[0].screenshots).toEqual(["screenshots/visible.png"]);
    });
});
