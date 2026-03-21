import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

describe("real-device-scenarios verify runner", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createTempDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "real-device-verify-"));
        tempDirs.push(dir);
        return dir;
    }

    it("creates a resolve-target package and exits in a waiting state", () => {
        const outputRoot = createTempDir();
        const result = spawnSync(
            process.execPath,
            [
                "scripts/real-device-scenarios/runtime/verify.mjs",
                "--scenario",
                "pr389-preview-store-miss",
                "--now",
                "2026-03-21T08:15:30.000Z",
                "--trace-suffix",
                "7F2A",
                "--output-root",
                outputRoot,
            ],
            {
                cwd: process.cwd(),
                encoding: "utf8",
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("WAITING_FOR_TARGET");
        expect(result.stdout).toContain("dtdbg-20260321-081530-pr389-preview-store-miss");

        const sessionDir = path.join(
            outputRoot,
            "2026-03-21",
            "dtdbg-20260321-081530-pr389-preview-store-miss",
        );
        expect(fs.existsSync(path.join(sessionDir, "session.json"))).toBe(true);
        expect(fs.existsSync(path.join(sessionDir, "scenario.snapshot.json"))).toBe(true);
        expect(fs.existsSync(path.join(sessionDir, "resolve-target-prompt.md"))).toBe(true);
        expect(fs.existsSync(path.join(sessionDir, "resolve-target.input.json"))).toBe(true);
        expect(fs.existsSync(path.join(sessionDir, "resolve-target.response.template.json"))).toBe(true);

        const session = JSON.parse(fs.readFileSync(path.join(sessionDir, "session.json"), "utf8"));
        expect(session).toMatchObject({
            phase: "resolve_target",
            scenarioId: "pr389-preview-store-miss",
            status: "blocked_on_target_resolution",
            traceToken: "DTDBG-20260321-081530-7F2A",
        });
    });

    it("resumes from resolve-target and produces the operator action package", () => {
        const outputRoot = createTempDir();
        const start = spawnSync(
            process.execPath,
            [
                "scripts/real-device-scenarios/runtime/verify.mjs",
                "--scenario",
                "pr389-preview-store-miss",
                "--now",
                "2026-03-21T08:15:30.000Z",
                "--trace-suffix",
                "7F2A",
                "--output-root",
                outputRoot,
            ],
            {
                cwd: process.cwd(),
                encoding: "utf8",
            },
        );
        expect(start.status).toBe(0);

        const sessionDir = path.join(
            outputRoot,
            "2026-03-21",
            "dtdbg-20260321-081530-pr389-preview-store-miss",
        );

        fs.writeFileSync(
            path.join(sessionDir, "resolve-target.response.json"),
            JSON.stringify(
                {
                    status: "completed",
                    channel: "dingtalk",
                    mode: "dm",
                    conversationId: "cid-dm-002",
                    senderStaffId: "manager8031",
                    displayName: "Manual User",
                    notes: "",
                },
                null,
                2,
            ),
            "utf8",
        );

        const resume = spawnSync(
            process.execPath,
            ["scripts/real-device-scenarios/runtime/verify.mjs", "--resume", sessionDir],
            {
                cwd: process.cwd(),
                encoding: "utf8",
            },
        );

        expect(resume.status).toBe(0);
        expect(resume.stdout).toContain("WAITING_FOR_OPERATOR");
        expect(fs.existsSync(path.join(sessionDir, "operator-prompt.md"))).toBe(true);
        expect(fs.existsSync(path.join(sessionDir, "operator-input.json"))).toBe(true);
        expect(fs.existsSync(path.join(sessionDir, "observation.template.json"))).toBe(true);

        const session = JSON.parse(fs.readFileSync(path.join(sessionDir, "session.json"), "utf8"));
        expect(session).toMatchObject({
            phase: "operator_action",
            status: "blocked_on_operator",
            target: {
                id: "manager8031",
                label: "Manual User",
                mode: "dm",
            },
        });
    });

    it("resumes from waiting_for_observation and advances to judging when observation exists", () => {
        const outputRoot = createTempDir();
        const sessionDir = path.join(outputRoot, "2026-03-21", "dtdbg-20260321-081530-pr389-preview-store-miss");
        fs.mkdirSync(sessionDir, { recursive: true });

        fs.writeFileSync(
            path.join(sessionDir, "session.json"),
            JSON.stringify(
                {
                    phase: "waiting_for_observation",
                    scenarioId: "pr389-preview-store-miss",
                    sessionId: "dtdbg-20260321-081530-pr389-preview-store-miss",
                    status: "blocked_on_observation",
                    traceToken: "DTDBG-20260321-081530-7F2A",
                },
                null,
                2,
            ),
            "utf8",
        );
        fs.writeFileSync(
            path.join(sessionDir, "scenario.snapshot.json"),
            JSON.stringify(
                {
                    id: "pr389-preview-store-miss",
                    title: "PR389 store miss preview fallback",
                    goal: "验证 first-hop record miss 时，事件 preview 仍能进入 ReplyToBody",
                    channel: "dingtalk",
                    target: { mode: "dm", resolver: "latest_inbound_sender" },
                    setup: {
                        createSession: true,
                        restartGateway: true,
                        startLogs: true,
                        streamMonitor: false,
                    },
                    steps: [
                        {
                            id: "quote_seed",
                            actor: "operator",
                            kind: "quote_message",
                            sourceRef: "seed_message",
                            message: "{{traceToken}} test",
                        },
                    ],
                    expected: { replyVisible: true },
                },
                null,
                2,
            ),
            "utf8",
        );
        fs.writeFileSync(
            path.join(sessionDir, "manifest.json"),
            JSON.stringify(
                {
                    version: 1,
                    sessionId: "dtdbg-20260321-081530-pr389-preview-store-miss",
                    traceToken: "DTDBG-20260321-081530-7F2A",
                    createdAt: "2026-03-21T08:15:30.000Z",
                    status: "probes_running",
                    scenario: "pr389-preview-store-miss",
                    target: {
                        id: "manager8031",
                        label: "Manual User",
                    },
                    operator: {
                        mode: "external",
                        observationStatus: "pending",
                    },
                    probes: {
                        connectionCheck: "ok",
                        streamMonitor: "skipped",
                        gatewayRestart: "ok",
                        openclawLogs: "running",
                    },
                    artifacts: {
                        rootDir: sessionDir,
                        logsDir: path.join(sessionDir, "logs"),
                        screenshotsDir: path.join(sessionDir, "screenshots"),
                    },
                    timeline: [],
                    observations: [],
                },
                null,
                2,
            ),
            "utf8",
        );
        fs.writeFileSync(path.join(sessionDir, "timeline.json"), "[]\n", "utf8");
        fs.writeFileSync(
            path.join(sessionDir, "observation.json"),
            JSON.stringify(
                {
                    status: "completed",
                    sentAt: "2026-03-21T08:16:00.000Z",
                    replyObservedAt: "2026-03-21T08:16:10.000Z",
                    sendStatus: "sent",
                    replyStatus: "visible",
                    replyPreview: "ok",
                    notes: "",
                    screenshots: [],
                },
                null,
                2,
            ),
            "utf8",
        );

        const resume = spawnSync(
            process.execPath,
            ["scripts/real-device-scenarios/runtime/verify.mjs", "--resume", sessionDir],
            {
                cwd: process.cwd(),
                encoding: "utf8",
            },
        );

        expect(resume.status).toBe(0);
        expect(resume.stdout).toContain("READY_FOR_JUDGING");

        const session = JSON.parse(fs.readFileSync(path.join(sessionDir, "session.json"), "utf8"));
        expect(session).toMatchObject({
            phase: "judging",
            status: "ready_for_judging",
        });
    });
});
