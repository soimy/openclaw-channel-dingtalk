import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSession } from "../../../scripts/real-device-debug/start-session.mjs";
import { prepareSession } from "../../../scripts/real-device-debug/prepare-session.mjs";

describe("prepareSession", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createTempDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-prepare-session-"));
        tempDirs.push(dir);
        return dir;
    }

    function createFakeRunner(calls: Array<{ kind: string; command: string }>) {
        return {
            async run(command: string, outputPath: string) {
                calls.push({ kind: "run", command });
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, `${command}\n`, "utf8");
                return { exitCode: 0 };
            },
            async start(command: string, outputPath: string) {
                calls.push({ kind: "start", command });
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, `${command}\n`, "utf8");
                return { pid: 12345 };
            },
        };
    }

    it("updates manifest and timeline files when preparing a session", async () => {
        const outputRoot = createTempDir();
        const calls: Array<{ kind: string; command: string }> = [];
        const { filePaths } = startSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            operatorMode: "external",
            scenario: "dm-text-reply",
            targetId: "cid-test",
            targetLabel: "Debug Chat",
            traceSuffix: "7F2A",
        });

        const result = await prepareSession({
            sessionDir: filePaths.sessionDir,
            runner: createFakeRunner(calls),
            enableStreamMonitor: false,
        });

        const manifest = JSON.parse(fs.readFileSync(filePaths.manifestPath, "utf8"));
        const timeline = JSON.parse(fs.readFileSync(filePaths.timelinePath, "utf8"));

        expect(calls.map((entry) => entry.command)).toEqual([
            "bash scripts/dingtalk-connection-check.sh",
            "openclaw gateway restart",
            "openclaw logs",
        ]);
        expect(manifest.status).toBe("probes_running");
        expect(manifest.probes.streamMonitor).toBe("skipped");
        expect(timeline).toHaveLength(4);
        expect(result.nextAction).toContain("Send the probe message");
        expect(result.nextAction).toContain("DTDBG-20260321-081530-7F2A");
    });
});
