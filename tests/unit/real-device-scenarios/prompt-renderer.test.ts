import { describe, expect, it } from "vitest";
import { createInitialManifest } from "../../../scripts/real-device-debug/session-contract.mjs";
import { loadScenario } from "../../../scripts/real-device-scenarios/runtime/scenario-loader.mjs";
import {
    renderObservationTemplate,
    renderOperatorInput,
    renderOperatorPrompt,
    renderOperatorResponseTemplate,
    renderResolveTargetInput,
    renderResolveTargetPrompt,
    renderResolveTargetResponseTemplate,
} from "../../../scripts/real-device-scenarios/runtime/prompt-renderer.mjs";

describe("real-device-scenarios prompt renderer", () => {
    it("renders resolve-target prompt and templates", () => {
        const scenario = loadScenario("pr389-preview-store-miss");
        const manifest = createInitialManifest({
            now: new Date("2026-03-21T08:15:30.000Z"),
            scenario: scenario.id,
            targetId: "",
            targetLabel: "",
            traceSuffix: "7F2A",
        });

        const prompt = renderResolveTargetPrompt({ manifest, scenario });
        const input = renderResolveTargetInput({ manifest, scenario });
        const template = renderResolveTargetResponseTemplate({ manifest, scenario });

        expect(prompt).toContain("确认本次真机测试的目标会话");
        expect(prompt).toContain(scenario.title);
        expect(prompt).toContain(manifest.traceToken);
        expect(input).toEqual({
            channel: "dingtalk",
            mode: "dm",
            phase: "resolve_target",
            requiredFields: ["conversationId", "senderStaffId"],
            resolver: "latest_inbound_sender",
            scenarioId: "pr389-preview-store-miss",
            sessionId: manifest.sessionId,
            traceToken: manifest.traceToken,
        });
        expect(template).toEqual({
            channel: "dingtalk",
            conversationId: "",
            displayName: "",
            mode: "dm",
            notes: "",
            senderStaffId: "",
            status: "completed",
        });
    });

    it("renders operator prompt and input for the quoted attachment scenario", () => {
        const scenario = loadScenario("pr389-quoted-attachment");
        const manifest = createInitialManifest({
            now: new Date("2026-03-21T08:15:30.000Z"),
            scenario: scenario.id,
            targetId: "manager8031",
            targetLabel: "DingTalk DM manager8031",
            traceSuffix: "7F2A",
        });

        const prompt = renderOperatorPrompt({ manifest, scenario });
        const input = renderOperatorInput({ manifest, scenario });
        const template = renderObservationTemplate({ manifest, scenario });

        expect(prompt).toContain("本次测试目标");
        expect(prompt).toContain("PR389 quoted attachment excerpt");
        expect(prompt).toContain("pr389-quoted-attachment.txt");
        expect(prompt).toContain("{{traceToken}}");
        expect(prompt).toContain("请只复述被引用文件的第一行，不要输出占位文案。");
        expect(prompt).toContain("operator-response.json");
        expect(prompt).toContain("observation.json");
        expect(input).toMatchObject({
            phase: "operator_action",
            scenarioId: "pr389-quoted-attachment",
            sessionId: manifest.sessionId,
            traceToken: manifest.traceToken,
            target: {
                label: "DingTalk DM manager8031",
                mode: "dm",
            },
        });
        expect(input.steps).toHaveLength(2);
        expect(renderOperatorResponseTemplate({ manifest, scenario })).toEqual({
            completedStepId: "",
            notes: "",
            status: "completed",
        });
        expect(template).toEqual({
            notes: "",
            replyObservedAt: "",
            replyPreview: "",
            replyStatus: "visible",
            screenshots: [],
            sendStatus: "sent",
            sentAt: "",
            status: "completed",
        });
    });
});
