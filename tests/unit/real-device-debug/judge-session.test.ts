import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSession } from "../../../scripts/real-device-debug/start-session.mjs";
import { appendOperatorObservation } from "../../../scripts/real-device-debug/operator-contract.mjs";
import { judgeSession } from "../../../scripts/real-device-debug/judge-session.mjs";

describe("judgeSession", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createTempDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-judge-session-"));
        tempDirs.push(dir);
        return dir;
    }

    function writeFilteredLog(sessionDir: string, content: string) {
        const logPath = path.join(sessionDir, "logs", "filtered.log");
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, content, "utf8");
    }

    function writeOpenclawLog(sessionDir: string, content: string) {
        const logPath = path.join(sessionDir, "logs", "openclaw.log");
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, content, "utf8");
    }

    it("marks missing inbound as no inbound evidence", () => {
        const outputRoot = createTempDir();
        const { filePaths } = startSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: "dm-text-reply",
            targetId: "cid-test",
            traceSuffix: "7F2A",
        });
        writeFilteredLog(filePaths.sessionDir, "trace seen but no lifecycle markers");

        const result = judgeSession({ sessionDir: filePaths.sessionDir });

        expect(result.judgment.outcome).toBe("no_inbound_evidence");
        expect(result.summary).toContain("no_inbound_evidence");
    });

    it("marks inbound without outbound as runtime processing issue", () => {
        const outputRoot = createTempDir();
        const { filePaths } = startSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: "dm-text-reply",
            targetId: "cid-test",
            traceSuffix: "7F2A",
        });
        writeFilteredLog(filePaths.sessionDir, "[inbound] handleDingTalkMessage");

        const result = judgeSession({ sessionDir: filePaths.sessionDir });

        expect(result.judgment.outcome).toBe("inbound_without_outbound");
    });

    it("marks outbound without desktop visibility as client visibility issue", () => {
        const outputRoot = createTempDir();
        const { filePaths } = startSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: "dm-text-reply",
            targetId: "cid-test",
            traceSuffix: "7F2A",
        });
        writeFilteredLog(
            filePaths.sessionDir,
            "[inbound] handleDingTalkMessage\n[outbound] sendMessage ok\n[outbound] sendBySession ok",
        );
        appendOperatorObservation(filePaths.sessionDir, {
            sentAt: "2026-03-21T08:16:00.000Z",
            replyObservedAt: "2026-03-21T08:18:30.000Z",
            sendStatus: "sent",
            replyStatus: "timeout",
            notes: "No visible reply in client",
            screenshots: [],
        });

        const result = judgeSession({ sessionDir: filePaths.sessionDir });

        expect(result.judgment.outcome).toBe("outbound_not_visible_in_client");
    });

    it("marks visible reply as end-to-end success", () => {
        const outputRoot = createTempDir();
        const { filePaths } = startSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: "dm-text-reply",
            targetId: "cid-test",
            traceSuffix: "7F2A",
        });
        writeFilteredLog(
            filePaths.sessionDir,
            "[inbound] handleDingTalkMessage\n[outbound] sendMessage ok\n[outbound] sendBySession ok",
        );
        appendOperatorObservation(filePaths.sessionDir, {
            sentAt: "2026-03-21T08:16:00.000Z",
            replyObservedAt: "2026-03-21T08:16:12.000Z",
            sendStatus: "sent",
            replyStatus: "visible",
            replyPreview: "ok",
            screenshots: [],
        });

        const result = judgeSession({ sessionDir: filePaths.sessionDir });

        expect(result.judgment.outcome).toBe("end_to_end_success");
        expect(result.summary).toContain("end_to_end_success");
    });

    it("marks high latency success separately", () => {
        const outputRoot = createTempDir();
        const { filePaths } = startSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: "dm-text-reply",
            targetId: "cid-test",
            traceSuffix: "7F2A",
        });
        writeFilteredLog(
            filePaths.sessionDir,
            "[inbound] handleDingTalkMessage\n[outbound] sendMessage ok\n[outbound] sendBySession ok",
        );
        appendOperatorObservation(filePaths.sessionDir, {
            sentAt: "2026-03-21T08:16:00.000Z",
            replyObservedAt: "2026-03-21T08:17:10.000Z",
            sendStatus: "sent",
            replyStatus: "visible",
            replyPreview: "ok",
            screenshots: [],
        });

        const result = judgeSession({ sessionDir: filePaths.sessionDir });

        expect(result.judgment.outcome).toBe("success_high_latency");
        expect(result.judgment.latencyMs).toBe(70000);
    });

    it("builds filtered log from openclaw.log when needed", () => {
        const outputRoot = createTempDir();
        const { filePaths, manifest } = startSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: "dm-text-reply",
            targetId: "cid-test",
            traceSuffix: "7F2A",
        });
        writeOpenclawLog(
            filePaths.sessionDir,
            [
                `2026-03-21 info sending probe ${manifest.traceToken}`,
                "2026-03-21 info [DingTalk] handleDingTalkMessage",
                "2026-03-21 info [DingTalk] sendMessage ok",
            ].join("\n"),
        );

        const result = judgeSession({ sessionDir: filePaths.sessionDir });

        expect(result.judgment.outcome).toBe("outbound_not_visible_in_client");
        expect(fs.existsSync(path.join(filePaths.sessionDir, "logs", "filtered.log"))).toBe(true);
    });
});
