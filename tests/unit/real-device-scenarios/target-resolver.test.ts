import { describe, expect, it } from "vitest";
import { loadScenario, validateScenario } from "../../../scripts/real-device-scenarios/runtime/scenario-loader.mjs";
import { resolveTarget } from "../../../scripts/real-device-scenarios/runtime/target-resolver.mjs";

describe("real-device-scenarios target resolver", () => {
    it("resolves a DM target from the latest inbound sender first", () => {
        const scenario = loadScenario("pr389-preview-store-miss");

        const resolved = resolveTarget({
            latestInbound: {
                conversationId: "cidKzHlklWIGXLFePDKNVk0fqjAbXJzI+8vhM5XS2iKHEU=",
                senderNick: "沈一鸣",
                senderStaffId: "manager8031",
            },
            scenario,
        });

        expect(resolved).toEqual({
            source: "latest_inbound_sender",
            status: "resolved",
            target: {
                conversationId: "cidKzHlklWIGXLFePDKNVk0fqjAbXJzI+8vhM5XS2iKHEU=",
                id: "manager8031",
                label: "沈一鸣",
                mode: "dm",
            },
        });
    });

    it("resolves a group target from the latest inbound conversation", () => {
        const scenario = validateScenario({
            id: "group-scenario",
            title: "group scenario",
            goal: "group scenario",
            channel: "dingtalk",
            target: {
                mode: "group",
                resolver: "latest_inbound_conversation",
            },
            setup: {
                createSession: true,
                restartGateway: true,
                startLogs: true,
                streamMonitor: false,
            },
            steps: [
                {
                    id: "step_1",
                    actor: "operator",
                    kind: "send_message",
                    message: "hello",
                },
            ],
            expected: {
                replyVisible: true,
            },
        });

        const resolved = resolveTarget({
            latestInbound: {
                conversationId: "cid-group-001",
                conversationTitle: "虾塘",
            },
            scenario,
        });

        expect(resolved).toEqual({
            source: "latest_inbound_conversation",
            status: "resolved",
            target: {
                conversationId: "cid-group-001",
                id: "cid-group-001",
                label: "虾塘",
                mode: "group",
            },
        });
    });

    it("falls back to resolve-target response when inbound data is unavailable", () => {
        const scenario = loadScenario("pr389-preview-store-miss");

        const resolved = resolveTarget({
            resolveTargetResponse: {
                channel: "dingtalk",
                conversationId: "cid-dm-002",
                displayName: "Manual User",
                mode: "dm",
                senderStaffId: "manager8031",
                status: "completed",
            },
            scenario,
        });

        expect(resolved).toEqual({
            source: "resolve_target_response",
            status: "resolved",
            target: {
                conversationId: "cid-dm-002",
                id: "manager8031",
                label: "Manual User",
                mode: "dm",
            },
        });
    });

    it("uses the learned directory to complete a DM target when only displayName is provided", () => {
        const scenario = loadScenario("pr389-preview-store-miss");

        const resolved = resolveTarget({
            directoryState: {
                groups: {},
                users: {
                    manager8031: {
                        canonicalUserId: "manager8031",
                        currentDisplayName: "沈一鸣",
                        lastSeenInConversationIds: ["cid-dm-003"],
                        senderId: "$:LWCP_v1:$sender",
                        staffId: "manager8031",
                    },
                },
            },
            resolveTargetResponse: {
                channel: "dingtalk",
                conversationId: "",
                displayName: "沈一鸣",
                mode: "dm",
                notes: "",
                senderStaffId: "",
                status: "completed",
            },
            scenario,
        });

        expect(resolved).toEqual({
            source: "targets_directory",
            status: "resolved",
            target: {
                conversationId: "cid-dm-003",
                id: "manager8031",
                label: "沈一鸣",
                mode: "dm",
            },
        });
    });

    it("allows an explicit target override as the final fallback", () => {
        const scenario = loadScenario("pr389-preview-store-miss");

        const resolved = resolveTarget({
            overrideTargetId: "override-user",
            overrideTargetLabel: "Override User",
            scenario,
        });

        expect(resolved).toEqual({
            source: "override",
            status: "resolved",
            target: {
                conversationId: undefined,
                id: "override-user",
                label: "Override User",
                mode: "dm",
            },
        });
    });

    it("returns needs_target_resolution when no source can resolve a target", () => {
        const scenario = loadScenario("pr389-preview-store-miss");

        const resolved = resolveTarget({
            directoryState: {
                groups: {},
                users: {},
            },
            scenario,
        });

        expect(resolved).toEqual({
            reason: "unable_to_resolve_target",
            status: "needs_target_resolution",
        });
    });
});
