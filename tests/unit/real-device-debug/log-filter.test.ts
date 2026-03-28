import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSession } from "../../../scripts/real-device-debug/start-session.mjs";
import { filterSessionLog } from "../../../scripts/real-device-debug/log-filter.mjs";

describe("filterSessionLog", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createTempDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-log-filter-"));
        tempDirs.push(dir);
        return dir;
    }

    it("keeps trace-token lines plus nearby DingTalk lifecycle context", () => {
        const outputRoot = createTempDir();
        const { filePaths, manifest } = startSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: "dm-text-reply",
            targetId: "cid-test",
            traceSuffix: "7F2A",
        });
        fs.writeFileSync(
            path.join(filePaths.sessionDir, "logs", "openclaw.log"),
            [
                "2026-03-21T08:15:59.000Z debug unrelated startup",
                `2026-03-21T08:16:00.000Z info sending probe ${manifest.traceToken}`,
                "2026-03-21T08:16:01.000Z info [DingTalk] inbound received",
                "2026-03-21T08:16:02.000Z info [DingTalk] sendMessage ok",
                "2026-03-21T08:16:30.000Z debug unrelated trailing line",
            ].join("\n"),
            "utf8",
        );

        const result = filterSessionLog({ sessionDir: filePaths.sessionDir, traceToken: manifest.traceToken });
        const filtered = fs.readFileSync(result.filteredLogPath, "utf8");

        expect(filtered).toContain(manifest.traceToken);
        expect(filtered).toContain("[DingTalk] inbound received");
        expect(filtered).toContain("[DingTalk] sendMessage ok");
        expect(filtered).not.toContain("unrelated startup");
        expect(filtered).not.toContain("unrelated trailing line");
    });
});
