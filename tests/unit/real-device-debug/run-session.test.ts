import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSession } from "../../../scripts/real-device-debug/run-session.mjs";

describe("runSession", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createTempDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-run-session-"));
        tempDirs.push(dir);
        return dir;
    }

    function createFakeRunner(calls: Array<string>) {
        return {
            async run(command: string, outputPath: string) {
                calls.push(command);
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, `${command}\n`, "utf8");
                return { exitCode: 0 };
            },
            async start(command: string, outputPath: string) {
                calls.push(command);
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, `${command}\n`, "utf8");
                return { pid: 34567 };
            },
        };
    }

    it("composes start and prepare, then returns an operator handoff message", async () => {
        const calls: string[] = [];
        const outputRoot = createTempDir();

        const result = await runSession({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario: "dm-text-reply",
            targetId: "cid-test",
            targetLabel: "Debug Chat",
            traceSuffix: "7F2A",
            enableStreamMonitor: false,
            runner: createFakeRunner(calls),
        });

        expect(calls).toEqual([
            "bash scripts/dingtalk-connection-check.sh",
            "openclaw gateway restart",
            "openclaw logs",
        ]);
        expect(result.manifest.status).toBe("probes_running");
        expect(result.nextAction).toContain("DTDBG-20260321-081530-7F2A");
        expect(fs.existsSync(path.join(result.filePaths.sessionDir, "operator-steps.md"))).toBe(true);
    });
});
