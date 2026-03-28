import { describe, expect, it } from "vitest";
import {
    buildSessionArtifacts,
    buildTraceToken,
    createInitialManifest,
} from "../../../scripts/real-device-debug/session-contract.mjs";

describe("real-device-debug session contract", () => {
    it("creates a stable local artifact layout for a debug session", () => {
        const manifest = createInitialManifest({
            now: new Date("2026-03-21T08:15:30.000Z"),
            scenario: "dm-text-reply",
            targetId: "cid-test",
        });

        expect(manifest.sessionId).toBe("dtdbg-20260321-081530-dm-text-reply");
        expect(manifest.traceToken).toMatch(/^DTDBG-20260321-081530-[A-Z0-9]{4}$/);
        expect(buildTraceToken(new Date("2026-03-21T08:15:30.000Z"), "7F2A")).toBe(
            "DTDBG-20260321-081530-7F2A",
        );
        expect(buildSessionArtifacts(manifest.sessionId)).toEqual({
            rootDir: ".local/debug-sessions/2026-03-21/dtdbg-20260321-081530-dm-text-reply",
            logsDir: ".local/debug-sessions/2026-03-21/dtdbg-20260321-081530-dm-text-reply/logs",
            screenshotsDir:
                ".local/debug-sessions/2026-03-21/dtdbg-20260321-081530-dm-text-reply/screenshots",
        });
    });

    it("creates an initial manifest with status, probes, and operator placeholders", () => {
        const manifest = createInitialManifest({
            now: new Date("2026-03-21T08:15:30.000Z"),
            scenario: "group-card",
            targetId: "cid-group",
            targetLabel: "Debug Group",
            traceSuffix: "9X1K",
        });

        expect(manifest).toMatchObject({
            sessionId: "dtdbg-20260321-081530-group-card",
            traceToken: "DTDBG-20260321-081530-9X1K",
            status: "created",
            scenario: "group-card",
            target: {
                id: "cid-group",
                label: "Debug Group",
            },
            operator: {
                mode: "external",
                observationStatus: "pending",
            },
            probes: {
                connectionCheck: "pending",
                streamMonitor: "pending",
                gatewayRestart: "pending",
                openclawLogs: "pending",
            },
        });
        expect(manifest.timeline).toEqual([]);
        expect(manifest.observations).toEqual([]);
    });
});
