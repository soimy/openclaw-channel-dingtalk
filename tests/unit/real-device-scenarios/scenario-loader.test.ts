import { describe, expect, it } from "vitest";
import {
    loadScenario,
    validateScenario,
} from "../../../scripts/real-device-scenarios/runtime/scenario-loader.mjs";

describe("real-device-scenarios scenario loader", () => {
    it("loads pr389 preview store miss scenario", () => {
        const scenario = loadScenario("pr389-preview-store-miss");

        expect(scenario.id).toBe("pr389-preview-store-miss");
        expect(scenario.channel).toBe("dingtalk");
        expect(scenario.target).toEqual({
            mode: "dm",
            resolver: "latest_inbound_sender",
        });
        expect(scenario.steps.map((step) => step.id)).toEqual([
            "send_seed",
            "delete_record",
            "quote_seed",
        ]);
        expect(scenario.expected.replyShouldContain).toContain("PR389-PREVIEW-STOREMISS-SEED");
    });

    it("loads pr389 quoted attachment scenario", () => {
        const scenario = loadScenario("pr389-quoted-attachment");

        expect(scenario.id).toBe("pr389-quoted-attachment");
        expect(scenario.channel).toBe("dingtalk");
        expect(scenario.target.mode).toBe("dm");
        expect(scenario.fixtures?.seedMessages).toHaveLength(1);
        expect(scenario.fixtures?.seedMessages?.[0]).toMatchObject({
            id: "quoted_attachment",
            kind: "file",
        });
        expect(scenario.expected.replyShouldContain).toContain("PR389-ATTACHMENT-SEED");
    });

    it("rejects scenarios with missing target configuration", () => {
        expect(() =>
            validateScenario({
                channel: "dingtalk",
                goal: "broken",
                id: "broken-scenario",
                setup: {
                    createSession: true,
                    restartGateway: true,
                    startLogs: true,
                    streamMonitor: false,
                },
                steps: [],
                title: "broken",
                expected: {
                    replyVisible: true,
                },
            }),
        ).toThrow(/target/i);
    });

    it("rejects scenarios with unsupported channels", () => {
        expect(() =>
            validateScenario({
                id: "broken-channel",
                title: "broken",
                goal: "broken",
                channel: "telegram",
                target: {
                    mode: "dm",
                    resolver: "latest_inbound_sender",
                },
                setup: {
                    createSession: true,
                    restartGateway: true,
                    startLogs: true,
                    streamMonitor: false,
                },
                steps: [],
                expected: {
                    replyVisible: true,
                },
            }),
        ).toThrow(/dingtalk/i);
    });
});
