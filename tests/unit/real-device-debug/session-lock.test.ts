import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSession } from "../../../scripts/real-device-debug/start-session.mjs";
import { appendOperatorObservation } from "../../../scripts/real-device-debug/operator-contract.mjs";
import { judgeSession } from "../../../scripts/real-device-debug/judge-session.mjs";
import { withSessionLock } from "../../../scripts/real-device-debug/session-lock.mjs";

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("session lock", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createTempDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-session-lock-"));
        tempDirs.push(dir);
        return dir;
    }

    it("makes judge wait for an in-flight observation write before classifying the session", async () => {
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
            [
                "2026-03-21T08:16:00.000Z info [inbound] handleDingTalkMessage",
                "2026-03-21T08:16:02.000Z info [outbound] sendMessage ok",
                "2026-03-21T08:16:03.000Z info [outbound] sendBySession ok",
            ].join("\n"),
            "utf8",
        );

        const writer = withSessionLock(filePaths.sessionDir, "test-observe", async () => {
            await sleep(80);
            appendOperatorObservation(filePaths.sessionDir, {
                sentAt: "2026-03-21T08:16:00.000Z",
                replyObservedAt: "2026-03-21T08:16:03.000Z",
                sendStatus: "sent",
                replyStatus: "visible",
                replyPreview: "ok",
                screenshots: [],
            });
        });

        await sleep(10);
        const judged = await judgeSession({ sessionDir: filePaths.sessionDir });
        await writer;

        expect(judged.judgment.outcome).toBe("end_to_end_success");
        expect(judged.judgment.replyObserved).toBe(true);

        const manifest = JSON.parse(fs.readFileSync(filePaths.manifestPath, "utf8"));
        expect(manifest.operator.observationStatus).toBe("reply_observed");
    });
});
