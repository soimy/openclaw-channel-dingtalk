import { describe, expect, it } from "vitest";
import { createInitialManifest } from "../../../scripts/real-device-debug/session-contract.mjs";
import { loadScenario } from "../../../scripts/real-device-scenarios/runtime/scenario-loader.mjs";
import {
    createInitialPhaseState,
    getCurrentOperatorStep,
    resolveNextPhase,
} from "../../../scripts/real-device-scenarios/runtime/phase-machine.mjs";

describe("real-device-scenarios phase machine", () => {
    it("starts in resolve_target when target is unresolved", () => {
        const scenario = loadScenario("pr389-preview-store-miss");
        const manifest = createInitialManifest({
            now: new Date("2026-03-21T08:15:30.000Z"),
            scenario: scenario.id,
            targetId: "",
            targetLabel: "",
            traceSuffix: "7F2A",
        });

        const state = createInitialPhaseState({ manifest, scenario });

        expect(state).toEqual({
            phase: "resolve_target",
            resumeCommand: `pnpm real-device:verify --resume ${manifest.artifacts.rootDir}`,
            status: "blocked_on_target_resolution",
        });
    });

    it("starts in setup when target has already been resolved", () => {
        const scenario = loadScenario("pr389-quoted-attachment");
        const manifest = createInitialManifest({
            now: new Date("2026-03-21T08:15:30.000Z"),
            scenario: scenario.id,
            targetId: "manager8031",
            targetLabel: "DingTalk DM manager8031",
            traceSuffix: "7F2A",
        });

        const state = createInitialPhaseState({ manifest, scenario });

        expect(state.phase).toBe("setup");
        expect(state.status).toBe("ready_for_setup");
    });

    it("advances quoted attachment flow from setup to completed", () => {
        const scenario = loadScenario("pr389-quoted-attachment");

        expect(resolveNextPhase({ phase: "setup", scenario })).toMatchObject({
            phase: "operator_action",
            status: "blocked_on_operator",
        });
        expect(getCurrentOperatorStep({ phase: "operator_action", scenario })?.id).toBe("send_fixture");
        expect(
            resolveNextPhase({
                phase: "operator_action",
                scenario,
                operatorStepCompleted: "send_fixture",
            }),
        ).toMatchObject({
            phase: "operator_action",
            status: "blocked_on_operator",
        });
        expect(
            getCurrentOperatorStep({
                phase: "operator_action",
                scenario,
                completedSteps: ["send_fixture"],
            })?.id,
        ).toBe("quote_fixture");
        expect(
            resolveNextPhase({
                phase: "operator_action",
                scenario,
                completedSteps: ["send_fixture"],
                operatorStepCompleted: "quote_fixture",
            }),
        ).toMatchObject({
            phase: "waiting_for_observation",
            status: "blocked_on_observation",
        });
        expect(
            resolveNextPhase({
                phase: "waiting_for_observation",
                scenario,
                observationCompleted: true,
            }),
        ).toMatchObject({
            phase: "judging",
            status: "ready_for_judging",
        });
        expect(resolveNextPhase({ phase: "judging", scenario })).toMatchObject({
            phase: "completed",
            status: "completed",
        });
    });

    it("supports a multi-stage pause for harness-side store-miss setup", () => {
        const scenario = loadScenario("pr389-preview-store-miss");

        expect(resolveNextPhase({ phase: "setup", scenario })).toMatchObject({
            phase: "operator_action",
            status: "blocked_on_operator",
        });
        expect(getCurrentOperatorStep({ phase: "operator_action", scenario })?.id).toBe("send_seed");
        expect(
            resolveNextPhase({
                phase: "operator_action",
                scenario,
                operatorStepCompleted: "send_seed",
            }),
        ).toMatchObject({
            phase: "harness_action",
            status: "ready_for_harness_step",
            nextHarnessStepId: "delete_record",
        });
        expect(
            resolveNextPhase({
                phase: "harness_action",
                scenario,
                completedSteps: ["send_seed"],
                harnessStepCompleted: "delete_record",
            }),
        ).toMatchObject({
            phase: "operator_action",
            status: "blocked_on_operator",
        });
        expect(
            getCurrentOperatorStep({
                phase: "operator_action",
                scenario,
                completedSteps: ["send_seed", "delete_record"],
            })?.id,
        ).toBe("quote_seed");
    });
});
