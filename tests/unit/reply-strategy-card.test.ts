import { describe, expect, it, vi, beforeEach } from "vitest";
import { createCardReplyStrategy } from "../../src/reply-strategy-card";
import * as cardService from "../../src/card-service";
import * as sendService from "../../src/send-service";
import * as sessionState from "../../src/session-state";
import { AICardStatus } from "../../src/types";
import type { AICardInstance } from "../../src/types";
import type { ReplyStrategyContext } from "../../src/reply-strategy";

vi.mock("../../src/card-service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/card-service")>();
    return {
        ...actual,
        finishAICard: vi.fn(),
        streamAICard: vi.fn(),
    };
});

vi.mock("../../src/session-state", () => ({
    getSessionState: vi.fn().mockReturnValue(undefined),
    getTaskTimeSeconds: vi.fn().mockReturnValue(undefined),
    updateSessionState: vi.fn(),
    initSessionState: vi.fn(),
    incrementDapiCount: vi.fn(),
    clearSessionState: vi.fn(),
    clearAllSessionStatesForTest: vi.fn(),
}));

const getSessionStateMock = vi.mocked(sessionState.getSessionState);
const getTaskTimeSecondsMock = vi.mocked(sessionState.getTaskTimeSeconds);

vi.mock("../../src/send-service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/send-service")>();
    return {
        ...actual,
        sendMessage: vi.fn().mockResolvedValue({ ok: true }),
        sendBySession: vi.fn().mockResolvedValue({}),
        sendProactiveTextOrMarkdown: vi.fn().mockResolvedValue({}),
    };
});

const finishAICardMock = vi.mocked(cardService.finishAICard);
const sendMessageMock = vi.mocked(sendService.sendMessage);
const updateSessionStateMock = vi.mocked(sessionState.updateSessionState);
const clearSessionStateMock = vi.mocked(sessionState.clearSessionState);

function makeCard(overrides: Partial<AICardInstance> = {}): AICardInstance {
    return {
        cardInstanceId: "card-test",
        accessToken: "token",
        conversationId: "cid_1",
        state: AICardStatus.PROCESSING,
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        ...overrides,
    } as AICardInstance;
}

function buildCtx(
    card: AICardInstance,
    overrides: Partial<ReplyStrategyContext> = {},
): ReplyStrategyContext & { card: AICardInstance } {
    return {
        config: { clientId: "id", clientSecret: "secret", messageType: "card" } as any,
        to: "cid_1",
        sessionWebhook: "https://session.webhook",
        senderId: "sender_1",
        isDirect: true,
        accountId: "main",
        storePath: "/tmp/store.json",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        deliverMedia: vi.fn(),
        card,
        ...overrides,
    };
}

describe("reply-strategy-card", () => {
    beforeEach(() => {
        finishAICardMock.mockClear();
        sendMessageMock.mockClear().mockResolvedValue({ ok: true });
        updateSessionStateMock.mockClear();
        clearSessionStateMock.mockClear();
        getSessionStateMock.mockClear().mockReturnValue(undefined);
        getTaskTimeSecondsMock.mockClear().mockReturnValue(undefined);
    });

    describe("getReplyOptions", () => {
        it("always sets disableBlockStreaming=true", () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            expect(strategy.getReplyOptions().disableBlockStreaming).toBe(true);
        });

        it("registers onPartialReply only when cardRealTimeStream=true", () => {
            const card = makeCard();
            const ctx = buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardRealTimeStream: true } as any,
            });
            const opts = createCardReplyStrategy(ctx).getReplyOptions();
            expect(opts.onPartialReply).toBeDefined();
        });

        it("does not register onPartialReply when cardRealTimeStream=false", () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            expect(strategy.getReplyOptions().onPartialReply).toBeUndefined();
        });

        it("always registers onReasoningStream and onAssistantMessageStart", () => {
            const card = makeCard();
            const opts = createCardReplyStrategy(buildCtx(card)).getReplyOptions();
            expect(opts.onReasoningStream).toBeDefined();
            expect(opts.onAssistantMessageStart).toBeDefined();
        });

        it("registers onModelSelected callback", () => {
            const card = makeCard();
            const opts = createCardReplyStrategy(buildCtx(card)).getReplyOptions();
            expect(opts.onModelSelected).toBeDefined();
        });

        it("onModelSelected calls updateSessionState with model and effort", async () => {
            const card = makeCard();
            const ctx = buildCtx(card, { accountId: "account_1" });
            const opts = createCardReplyStrategy(ctx).getReplyOptions();

            await opts.onModelSelected?.({ provider: "openai", model: "gpt-4", thinkLevel: "high" });

            expect(updateSessionStateMock).toHaveBeenCalledWith(
                "account_1",
                "cid_1",
                { model: "gpt-4", effort: "high" },
                expect.anything(),
            );
        });
    });

    describe("deliver", () => {
        it("deliver(final) saves text for finalize but does not send immediately", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "final answer", mediaUrls: [], kind: "final" });
            expect(sendMessageMock).not.toHaveBeenCalled();
            expect(finishAICardMock).not.toHaveBeenCalled();
            expect(strategy.getFinalText()).toBe("final answer");
        });

        it("deliver(final) delivers media attachments", async () => {
            const deliverMedia = vi.fn();
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, { deliverMedia }));
            await strategy.deliver({ text: "text", mediaUrls: ["/img.png"], kind: "final" });
            expect(deliverMedia).toHaveBeenCalledWith(["/img.png"]);
        });

        it("deliver(tool) appends to the controller instead of sendMessage append mode", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "tool output", mediaUrls: [], kind: "tool" });
            expect(sendMessageMock).not.toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.anything(),
                expect.objectContaining({ cardUpdateMode: "append" }),
            );
        });

        it("deliver(tool) skips when card is FAILED", async () => {
            const card = makeCard({ state: AICardStatus.FAILED });
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "tool output", mediaUrls: [], kind: "tool" });
            expect(sendMessageMock).not.toHaveBeenCalled();
        });

        it("deliver(block) with empty text and no media returns early", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "", mediaUrls: [], kind: "block" });
            expect(sendMessageMock).not.toHaveBeenCalled();
        });

        it("deliver(tool) does not depend on sendMessage append mode success", async () => {
            const card = makeCard();
            sendMessageMock.mockResolvedValueOnce({ ok: false, error: "tool send failed" });
            const strategy = createCardReplyStrategy(buildCtx(card));
            await expect(
                strategy.deliver({ text: "tool output", mediaUrls: [], kind: "tool" }),
            ).resolves.toBeUndefined();
            expect(sendMessageMock).not.toHaveBeenCalled();
        });

        it("deliver(tool) skips when tool text is empty after formatting", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            // undefined text → formatContentForCard returns ""
            await strategy.deliver({ text: undefined, mediaUrls: [], kind: "tool" });
            expect(sendMessageMock).not.toHaveBeenCalled();
        });

        it("deliver(block) delivers media but ignores text", async () => {
            const deliverMedia = vi.fn();
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, { deliverMedia }));
            await strategy.deliver({ text: "ignored", mediaUrls: ["/tmp/file.pdf"], kind: "block" });
            expect(deliverMedia).toHaveBeenCalledWith(["/tmp/file.pdf"]);
            expect(sendMessageMock).not.toHaveBeenCalled();
        });

        it("deliver(final) with empty text still falls through for card finalize", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            expect(strategy.getFinalText()).toBe("附件已发送，请查收。");
        });
    });

    describe("finalize", () => {
        it("calls finishAICard with the rendered timeline instead of answer-only text", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            strategy.getReplyOptions().onReasoningStream?.({ text: "先检查差异" });
            await strategy.deliver({ text: "git diff --stat", mediaUrls: [], kind: "tool" });
            await strategy.deliver({ text: "the answer", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const blockList = finishAICardMock.mock.calls[0][1];
            // blockList is CardBlock[], check structure
            expect(blockList.some((b: any) => (b.type === 1 || b.type === 2) && b.text.includes("先检查差异"))).toBe(true);
            expect(blockList.some((b: any) => (b.type === 1 || b.type === 2) && b.text.includes("git diff --stat"))).toBe(true);
            expect(blockList.some((b: any) => b.type === 0 && b.text.includes("the answer"))).toBe(true);
        });

        it("preserves answer and tool blocks in event order during finalize", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(
                buildCtx(card, {
                    config: {
                        clientId: "id",
                        clientSecret: "secret",
                        messageType: "card",
                        cardRealTimeStream: true,
                    } as any,
                }),
            );
            const replyOptions = strategy.getReplyOptions();

            await replyOptions.onPartialReply?.({ text: "阶段1答案：准备先检查当前目录" });
            await strategy.deliver({ text: "🛠️ Exec: pwd", mediaUrls: [], kind: "tool" });

            await replyOptions.onAssistantMessageStart?.();
            await replyOptions.onPartialReply?.({ text: "阶段2答案：pwd 已返回结果" });
            await strategy.deliver({ text: "🛠️ Exec: printf ok", mediaUrls: [], kind: "tool" });

            await replyOptions.onAssistantMessageStart?.();
            await replyOptions.onPartialReply?.({ text: "阶段3答案：两次工具都已完成" });
            await strategy.deliver({ text: "阶段3答案：两次工具都已完成", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            const blockList = finishAICardMock.mock.calls.at(-1)?.[1] as any[] ?? [];
            // Verify all blocks are present in correct order
            const blockTexts = blockList.map((b: any) => b.text);
            const phase1Index = blockTexts.findIndex((t: string) => t.includes("阶段1答案：准备先检查当前目录"));
            const tool1Index = blockTexts.findIndex((t: string) => t.includes("🛠️ Exec: pwd"));
            const phase2Index = blockTexts.findIndex((t: string) => t.includes("阶段2答案：pwd 已返回结果"));
            const tool2Index = blockTexts.findIndex((t: string) => t.includes("🛠️ Exec: printf ok"));
            const phase3Index = blockTexts.findIndex((t: string) => t.includes("阶段3答案：两次工具都已完成"));

            expect(phase1Index).toBeGreaterThanOrEqual(0);
            expect(tool1Index).toBeGreaterThan(phase1Index);
            expect(phase2Index).toBeGreaterThan(tool1Index);
            expect(tool2Index).toBeGreaterThan(phase2Index);
            expect(phase3Index).toBeGreaterThan(tool2Index);
        });

        it("skips finalize when card is already FINISHED", async () => {
            const card = makeCard({ state: AICardStatus.FINISHED });
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.finalize();
            expect(finishAICardMock).not.toHaveBeenCalled();
        });

        it("sends markdown fallback with the rendered timeline when card FAILED", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            strategy.getReplyOptions().onReasoningStream?.({ text: "分析上下文" });
            await strategy.deliver({ text: "git status", mediaUrls: [], kind: "tool" });
            await strategy.deliver({ text: "full answer", mediaUrls: [], kind: "final" });
            card.state = AICardStatus.FAILED;
            await strategy.finalize();

            expect(finishAICardMock).not.toHaveBeenCalled();
            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            const fallbackText = sendMessageMock.mock.calls[0][2];
            expect(fallbackText).toContain("> 分析上下文");
            expect(fallbackText).toContain("> git status");
            expect(fallbackText).toContain("full answer");
            expect(sendMessageMock.mock.calls[0][3]).toMatchObject({
                forceMarkdown: true,
            });
        });

        it("sets card state to FAILED when finishAICard throws", async () => {
            const card = makeCard();
            finishAICardMock.mockRejectedValueOnce(new Error("api error"));
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "text", mediaUrls: [], kind: "final" });
            await strategy.finalize();
            expect(card.state).toBe(AICardStatus.FAILED);
        });

        it("logs error payload when finishAICard throws with response data", async () => {
            const card = makeCard();
            const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
            finishAICardMock.mockRejectedValueOnce({
                message: "finalize failed",
                response: { data: { code: "invalidParameter", message: "bad param" } },
            });
            const strategy = createCardReplyStrategy(buildCtx(card, { log: log as any }));
            await strategy.deliver({ text: "text", mediaUrls: [], kind: "final" });
            await strategy.finalize();
            expect(card.state).toBe(AICardStatus.FAILED);
            const debugLogs = log.debug.mock.calls.map((args: unknown[]) => String(args[0]));
            expect(debugLogs.some((msg) => msg.includes("[ErrorPayload][inbound.cardFinalize]"))).toBe(true);
        });

        it("sends markdown fallback via forceMarkdown when card FAILED and no sessionWebhook", async () => {
            const card = makeCard({ state: AICardStatus.FAILED, lastStreamedContent: "partial content" });
            const strategy = createCardReplyStrategy(buildCtx(card, { sessionWebhook: "" }));
            await strategy.deliver({ text: "full text", mediaUrls: [], kind: "final" });
            await strategy.finalize();
            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            expect(sendMessageMock.mock.calls[0][3]).toMatchObject({ forceMarkdown: true });
        });

        it("throws when markdown fallback sendMessage returns not ok", async () => {
            const card = makeCard({ state: AICardStatus.FAILED, lastStreamedContent: "partial" });
            sendMessageMock.mockResolvedValueOnce({ ok: false, error: "fallback failed" });
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "text", mediaUrls: [], kind: "final" });
            await expect(strategy.finalize()).rejects.toThrow("fallback failed");
        });

        it("does nothing when card FAILED and no fallback text available", async () => {
            const card = makeCard({ state: AICardStatus.FAILED });
            const strategy = createCardReplyStrategy(buildCtx(card));
            // No deliver(final), no lastStreamedContent
            await strategy.finalize();
            expect(sendMessageMock).not.toHaveBeenCalled();
            expect(finishAICardMock).not.toHaveBeenCalled();
        });

        it("uses a file-only placeholder answer when no answer text is available", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            strategy.getReplyOptions().onReasoningStream?.({ text: "我来发附件" });
            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const blockList = finishAICardMock.mock.calls[0][1] as any[];
            // Tool block should contain the reasoning text
            expect(blockList.some((b: any) => (b.type === 1 || b.type === 2) && b.text.includes("我来发附件"))).toBe(true);
            // Fallback answer block should be present
            expect(blockList.some((b: any) => b.type === 0 && b.text.includes("附件已发送，请查收。"))).toBe(true);
        });

        it("clears session state after successful finalize", async () => {
            const card = makeCard();
            const ctx = buildCtx(card, { accountId: "account_1" });
            const strategy = createCardReplyStrategy(ctx);
            await strategy.deliver({ text: "answer", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(clearSessionStateMock).toHaveBeenCalledWith("account_1", "cid_1");
        });

        it("clears session state after FAILED fallback", async () => {
            const card = makeCard({ state: AICardStatus.FAILED, lastStreamedContent: "partial" });
            const ctx = buildCtx(card, { accountId: "account_2" });
            const strategy = createCardReplyStrategy(ctx);
            await strategy.finalize();

            expect(clearSessionStateMock).toHaveBeenCalledWith("account_2", "cid_1");
        });

        it("reads session state for taskInfo assembly", async () => {
            const card = makeCard();
            const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
            const ctx = buildCtx(card, { accountId: "account_task", log: log as any });

            // Mock session state to return specific values
            getSessionStateMock.mockReturnValueOnce({
                model: "claude-3",
                effort: "high",
                taskStartTime: Date.now() - 5000,
                dapiCount: 5,
            });
            getTaskTimeSecondsMock.mockReturnValueOnce(5);

            const strategy = createCardReplyStrategy(ctx);
            await strategy.deliver({ text: "answer", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            // Verify session state was read for taskInfo
            expect(getSessionStateMock).toHaveBeenCalledWith("account_task", "cid_1");
            expect(getTaskTimeSecondsMock).toHaveBeenCalledWith("account_task", "cid_1");

            // Verify taskInfo was logged
            const debugCalls = log.debug.mock.calls.map((args) => String(args[0]));
            const taskInfoLog = debugCalls.find((msg) => msg.includes("Finalizing with taskInfo"));
            expect(taskInfoLog).toBeDefined();
            expect(taskInfoLog).toContain('"model":"claude-3"');
            expect(taskInfoLog).toContain('"effort":"high"');
            expect(taskInfoLog).toContain('"taskTime":5');
            expect(taskInfoLog).toContain('"dap_usage":5');
        });
    });

    describe("abort", () => {
        it("calls finishAICard with error block when no content exists", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.abort(new Error("dispatch crashed"));
            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const blockList = finishAICardMock.mock.calls[0][1] as any[];
            // Should have a single error block with failure message
            expect(blockList).toHaveLength(1);
            expect(blockList[0].text).toContain("处理失败");
        });

        it("sets card FAILED when finishAICard throws during abort", async () => {
            const card = makeCard();
            finishAICardMock.mockRejectedValueOnce(new Error("cannot finalize"));
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.abort(new Error("dispatch crashed"));
            expect(card.state).toBe(AICardStatus.FAILED);
        });

        it("skips abort when card is already in terminal state", async () => {
            const card = makeCard({ state: AICardStatus.FINISHED });
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.abort(new Error("dispatch crashed"));
            expect(finishAICardMock).not.toHaveBeenCalled();
        });

        it("clears session state after abort", async () => {
            const card = makeCard();
            const ctx = buildCtx(card, { accountId: "account_abort" });
            const strategy = createCardReplyStrategy(ctx);
            await strategy.abort(new Error("dispatch crashed"));

            expect(clearSessionStateMock).toHaveBeenCalledWith("account_abort", "cid_1");
        });
    });
});
