import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSession } from "../../../scripts/real-device-debug/start-session.mjs";
import {
    appendOperatorObservation,
    buildOperatorRequest,
} from "../../../scripts/real-device-debug/operator-contract.mjs";

describe("real-device-debug operator contract", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createTempDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-operator-contract-"));
        tempDirs.push(dir);
        return dir;
    }

    it("builds an operator request with a trace-token probe message", () => {
        const outputRoot = createTempDir();
        const { manifest } = startSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: "dm-text-reply",
            targetId: "cid-test",
            targetLabel: "Debug Chat",
            traceSuffix: "7F2A",
        });

        expect(buildOperatorRequest(manifest)).toMatchObject({
            action: "send_probe_message",
            traceToken: "DTDBG-20260321-081530-7F2A",
            messageText: expect.stringContaining("DTDBG-20260321-081530-7F2A"),
            timeoutSec: 120,
            expectedChecks: [
                "message appears in DingTalk conversation",
                "bot reply becomes visible",
            ],
        });
    });

    it("appends observation data without overwriting unrelated manifest fields", () => {
        const outputRoot = createTempDir();
        const { filePaths } = startSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: "dm-text-reply",
            targetId: "cid-test",
            targetLabel: "Debug Chat",
            traceSuffix: "7F2A",
        });

        const result = appendOperatorObservation(filePaths.sessionDir, {
            sentAt: "2026-03-21T08:16:00.000Z",
            replyObservedAt: "2026-03-21T08:16:18.000Z",
            sendStatus: "sent",
            replyStatus: "visible",
            replyPreview: "ok",
            notes: "Reply rendered in the desktop client",
            screenshots: [path.join(filePaths.sessionDir, "screenshots", "visible.png")],
        });

        const manifest = JSON.parse(fs.readFileSync(filePaths.manifestPath, "utf8"));
        const timeline = JSON.parse(fs.readFileSync(filePaths.timelinePath, "utf8"));

        expect(manifest.sessionId).toBe("dtdbg-20260321-081530-dm-text-reply");
        expect(manifest.target.label).toBe("Debug Chat");
        expect(manifest.operator.observationStatus).toBe("reply_observed");
        expect(manifest.status).toBe("reply_observed");
        expect(manifest.observations).toHaveLength(1);
        expect(manifest.observations[0]).toMatchObject({
            sendStatus: "sent",
            replyStatus: "visible",
            screenshots: ["screenshots/visible.png"],
        });
        expect(timeline.map((entry: { type: string }) => entry.type)).toEqual([
            "operator.message_sent",
            "operator.reply_observed",
        ]);
        expect(result.status).toBe("reply_observed");
    });
});
