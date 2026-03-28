import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInitialManifest } from "../../../scripts/real-device-debug/session-contract.mjs";
import { runPreflightAndCapture } from "../../../scripts/real-device-debug/runtime-probe.mjs";

describe("real-device-debug runtime probe", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createSessionDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-runtime-probe-"));
        tempDirs.push(dir);
        return dir;
    }

    function createFakeRunner(calls: Array<{ kind: string; command: string; outputPath: string }>) {
        return {
            async run(command: string, outputPath: string) {
                calls.push({ kind: "run", command, outputPath });
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, `ran ${command}\n`, "utf8");
                return { exitCode: 0 };
            },
            async start(command: string, outputPath: string) {
                calls.push({ kind: "start", command, outputPath });
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, `started ${command}\n`, "utf8");
                return { pid: 43210 };
            },
        };
    }

    it("plans probes in the expected order and updates manifest statuses", async () => {
        const calls: Array<{ kind: string; command: string; outputPath: string }> = [];
        const manifest = createInitialManifest({
            now: new Date("2026-03-21T08:15:30.000Z"),
            scenario: "dm-text-reply",
            targetId: "cid-test",
            traceSuffix: "7F2A",
        });
        const sessionDir = createSessionDir();
        const runner = createFakeRunner(calls);

        const result = await runPreflightAndCapture({
            manifest,
            runner,
            sessionDir,
            enableStreamMonitor: true,
        });

        expect(calls.map((entry) => entry.command)).toEqual([
            "bash scripts/dingtalk-connection-check.sh",
            "node scripts/dingtalk-stream-monitor.mjs --duration 20",
            "openclaw gateway restart",
            "openclaw logs",
        ]);
        expect(result.manifest.probes).toEqual({
            connectionCheck: "ok",
            streamMonitor: "ok",
            gatewayRestart: "ok",
            openclawLogs: "running",
        });
        expect(result.manifest.status).toBe("probes_running");
        expect(result.timeline.map((entry) => entry.type)).toEqual([
            "probe.connection_check.ok",
            "probe.stream_monitor.ok",
            "probe.gateway_restart.ok",
            "probe.openclaw_logs.running",
        ]);
        expect(fs.readFileSync(path.join(sessionDir, "logs", "connection-check.log"), "utf8")).toContain(
            "ran bash scripts/dingtalk-connection-check.sh",
        );
        expect(fs.readFileSync(path.join(sessionDir, "logs", "openclaw.log"), "utf8")).toContain(
            "started openclaw logs",
        );
    });

    it("marks the stream monitor as skipped when disabled", async () => {
        const calls: Array<{ kind: string; command: string; outputPath: string }> = [];
        const manifest = createInitialManifest({
            now: new Date("2026-03-21T08:15:30.000Z"),
            scenario: "dm-text-reply",
            targetId: "cid-test",
            traceSuffix: "7F2A",
        });
        const sessionDir = createSessionDir();
        const runner = createFakeRunner(calls);

        const result = await runPreflightAndCapture({
            manifest,
            runner,
            sessionDir,
            enableStreamMonitor: false,
        });

        expect(calls.map((entry) => entry.command)).toEqual([
            "bash scripts/dingtalk-connection-check.sh",
            "openclaw gateway restart",
            "openclaw logs",
        ]);
        expect(result.manifest.probes.streamMonitor).toBe("skipped");
        expect(result.timeline.map((entry) => entry.type)).toContain("probe.stream_monitor.skipped");
    });
});
