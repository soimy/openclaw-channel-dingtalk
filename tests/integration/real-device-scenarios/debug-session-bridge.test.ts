import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadScenario } from "../../../scripts/real-device-scenarios/runtime/scenario-loader.mjs";
import {
    resumeScenarioWithDependencies,
    startScenarioWithDependencies,
} from "../../../scripts/real-device-scenarios/runtime/verify.mjs";

describe("real-device-scenarios debug-session bridge", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tempDirs.length = 0;
    });

    function createTempDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "real-device-bridge-"));
        tempDirs.push(dir);
        return dir;
    }

    it("uses prepareSession when a resolved target scenario enters setup", async () => {
        const outputRoot = createTempDir();
        const scenario = loadScenario("pr389-quoted-attachment");
        const prepareSession = vi.fn().mockResolvedValue({
            manifest: {
                status: "probes_running",
            },
            nextAction: "operator next action",
        });

        const result = await startScenarioWithDependencies({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario,
            targetId: "manager8031",
            targetLabel: "DingTalk DM manager8031",
            traceSuffix: "7F2A",
            dependencies: {
                prepareSession,
            },
        });

        expect(prepareSession).toHaveBeenCalledTimes(1);
        expect(prepareSession).toHaveBeenCalledWith({
            enableStreamMonitor: false,
            runner: undefined,
            sessionDir: result.filePaths.sessionDir,
        });
        expect(result.sessionState.phase).toBe("operator_action");
        expect(result.sessionState.status).toBe("blocked_on_operator");
    });

    it("uses judgeSession when resume reaches the judging phase", async () => {
        const outputRoot = createTempDir();
        const sessionDir = path.join(outputRoot, "2026-03-21", "dtdbg-20260321-081530-pr389-preview-store-miss");
        fs.mkdirSync(sessionDir, { recursive: true });

        fs.writeFileSync(
            path.join(sessionDir, "session.json"),
            JSON.stringify(
                {
                    phase: "waiting_for_observation",
                    status: "blocked_on_observation",
                    sessionId: "dtdbg-20260321-081530-pr389-preview-store-miss",
                    scenarioId: "pr389-preview-store-miss",
                    traceToken: "DTDBG-20260321-081530-7F2A",
                    completedSteps: [],
                    target: {
                        id: "manager8031",
                        label: "Manual User",
                        mode: "dm",
                    },
                },
                null,
                2,
            ),
            "utf8",
        );
        fs.writeFileSync(
            path.join(sessionDir, "scenario.snapshot.json"),
            JSON.stringify(loadScenario("pr389-preview-store-miss"), null, 2),
            "utf8",
        );
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

        const judgeSession = vi.fn().mockResolvedValue({
            judgment: {
                outcome: "end_to_end_success",
            },
        });
        const recordObservation = vi.fn().mockResolvedValue({
            status: "reply_observed",
        });

        const result = await resumeScenarioWithDependencies({
            sessionDir,
            autoJudge: true,
            dependencies: {
                judgeSession,
                recordObservation,
            },
        });

        expect(recordObservation).toHaveBeenCalledTimes(1);
        expect(judgeSession).toHaveBeenCalledTimes(1);
        expect(judgeSession).toHaveBeenCalledWith({ sessionDir });
        expect(result.sessionState.phase).toBe("completed");
        expect(result.sessionState.status).toBe("completed");
    });

    it("uses recordObservation before judging when observation.json exists", async () => {
        const outputRoot = createTempDir();
        const sessionDir = path.join(outputRoot, "2026-03-21", "dtdbg-20260321-081530-pr389-preview-store-miss");
        fs.mkdirSync(sessionDir, { recursive: true });

        fs.writeFileSync(
            path.join(sessionDir, "session.json"),
            JSON.stringify(
                {
                    phase: "waiting_for_observation",
                    status: "blocked_on_observation",
                    sessionId: "dtdbg-20260321-081530-pr389-preview-store-miss",
                    scenarioId: "pr389-preview-store-miss",
                    traceToken: "DTDBG-20260321-081530-7F2A",
                    completedSteps: [],
                    target: {
                        id: "manager8031",
                        label: "Manual User",
                        mode: "dm",
                    },
                },
                null,
                2,
            ),
            "utf8",
        );
        fs.writeFileSync(
            path.join(sessionDir, "scenario.snapshot.json"),
            JSON.stringify(loadScenario("pr389-preview-store-miss"), null, 2),
            "utf8",
        );
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

        const recordObservation = vi.fn().mockResolvedValue({
            status: "reply_observed",
        });
        const judgeSession = vi.fn().mockResolvedValue({
            judgment: {
                outcome: "end_to_end_success",
            },
        });

        await resumeScenarioWithDependencies({
            sessionDir,
            autoJudge: true,
            dependencies: {
                judgeSession,
                recordObservation,
            },
        });

        expect(recordObservation).toHaveBeenCalledTimes(1);
        expect(recordObservation).toHaveBeenCalledWith({
            observationFile: path.join(sessionDir, "observation.json"),
            sessionDir,
        });
        expect(judgeSession).toHaveBeenCalledTimes(1);
    });

    it("uses prepareSession after target resolution when resuming from resolve_target", async () => {
        const outputRoot = createTempDir();
        const scenario = loadScenario("pr389-preview-store-miss");
        const start = await startScenarioWithDependencies({
            now: new Date("2026-03-21T08:15:30.000Z"),
            outputRoot,
            scenario,
            traceSuffix: "7F2A",
            dependencies: {
                prepareSession: vi.fn(),
            },
        });

        fs.writeFileSync(
            path.join(start.filePaths.sessionDir, "resolve-target.response.json"),
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

        const prepareSession = vi.fn().mockResolvedValue({
            manifest: {
                status: "probes_running",
            },
            nextAction: "operator next action",
        });

        const result = await resumeScenarioWithDependencies({
            sessionDir: start.filePaths.sessionDir,
            dependencies: {
                prepareSession,
            },
        });

        expect(prepareSession).toHaveBeenCalledTimes(1);
        expect(prepareSession).toHaveBeenCalledWith({
            enableStreamMonitor: false,
            runner: undefined,
            sessionDir: start.filePaths.sessionDir,
        });
        expect(result.sessionState.phase).toBe("operator_action");
        expect(result.sessionState.status).toBe("blocked_on_operator");
    });
});
