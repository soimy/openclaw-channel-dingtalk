import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { startSession } from "../../../scripts/real-device-debug/start-session.mjs";
import { appendOperatorObservation } from "../../../scripts/real-device-debug/operator-contract.mjs";

describe("dingtalk debug session judge CLI", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createTempDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-debug-judge-"));
        tempDirs.push(dir);
        return dir;
    }

    it("writes judgment artifacts and prints the final outcome", () => {
        const outputRoot = createTempDir();
        const { filePaths } = startSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: "dm-text-reply",
            targetId: "cid-test",
            targetLabel: "Debug Chat",
            traceSuffix: "7F2A",
        });
        fs.writeFileSync(
            path.join(filePaths.sessionDir, "logs", "filtered.log"),
            "[inbound] handleDingTalkMessage\n[outbound] sendMessage ok",
            "utf8",
        );
        appendOperatorObservation(filePaths.sessionDir, {
            sentAt: "2026-03-21T08:16:00.000Z",
            replyObservedAt: "2026-03-21T08:16:18.000Z",
            sendStatus: "sent",
            replyStatus: "visible",
            replyPreview: "ok",
            screenshots: [],
        });

        const result = spawnSync(
            process.execPath,
            ["scripts/dingtalk-debug-session.mjs", "judge", "--session-dir", filePaths.sessionDir],
            {
                cwd: process.cwd(),
                encoding: "utf8",
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("outcome=end_to_end_success");
        expect(fs.existsSync(path.join(filePaths.sessionDir, "judgment.json"))).toBe(true);
        expect(fs.existsSync(path.join(filePaths.sessionDir, "summary.md"))).toBe(true);
    });
});
