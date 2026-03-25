import { describe, expect, it, vi, beforeEach } from "vitest";
import { createCardReplyStrategy } from "../../src/reply-strategy-card";
import * as cardService from "../../src/card-service";
import * as sendService from "../../src/send-service";
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

        it("deliver(tool) sends via sendMessage with cardUpdateMode=append", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "tool output", mediaUrls: [], kind: "tool" });
            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            expect(sendMessageMock.mock.calls[0][3]).toMatchObject({
                card,
                cardUpdateMode: "append",
            });
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

        it("deliver(tool) throws when sendMessage returns not ok", async () => {
            const card = makeCard();
            sendMessageMock.mockResolvedValueOnce({ ok: false, error: "tool send failed" });
            const strategy = createCardReplyStrategy(buildCtx(card));
            await expect(
                strategy.deliver({ text: "tool output", mediaUrls: [], kind: "tool" }),
            ).rejects.toThrow("tool send failed");
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
            // Should not throw; finalTextForFallback stays undefined
            expect(strategy.getFinalText()).toBeUndefined();
        });
    });

    describe("finalize", () => {
        it("calls finishAICard with lastAnswerContent or fallback text", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "the answer", mediaUrls: [], kind: "final" });
            await strategy.finalize();
            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            // finalTextForFallback is "the answer" since onPartialReply is not registered
            expect(finishAICardMock.mock.calls[0][1]).toBe("the answer");
        });

        it("skips finalize when card is already FINISHED", async () => {
            const card = makeCard({ state: AICardStatus.FINISHED });
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.finalize();
            expect(finishAICardMock).not.toHaveBeenCalled();
        });

        it("sends markdown fallback with forceMarkdown when card FAILED", async () => {
            const card = makeCard({ state: AICardStatus.FAILED, lastStreamedContent: "partial" });
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "full answer", mediaUrls: [], kind: "final" });
            await strategy.finalize();
            expect(finishAICardMock).not.toHaveBeenCalled();
            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            expect(sendMessageMock.mock.calls[0][2]).toBe("full answer");
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

        it("closes card with interruption notice when counts.final > 0 but no text content", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            await strategy.finalize({ block: 0, final: 1, tool: 0 });
            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            expect(finishAICardMock.mock.calls[0][1]).toContain("未收到最终回复");
        });

        it("silently closes card when counts.final=0 and no content (agent produced no output)", async () => {
            const card = makeCard();
            const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
            const strategy = createCardReplyStrategy(buildCtx(card, { log: log as any }));
            // Agent returned empty — counts.final=0, no deliver called
            await strategy.finalize({ block: 0, final: 0, tool: 0 });
            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            // Should close with empty string, not "✅ Done"
            expect(finishAICardMock.mock.calls[0][1]).toBe("");
            const warnLogs = log.warn.mock.calls.map((args: unknown[]) => String(args[0]));
            expect(warnLogs.some((msg) => msg.includes("Agent produced no content"))).toBe(true);
        });

        it("silently closes card when finalize called without counts (defensive)", async () => {
            const card = makeCard();
            const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
            const strategy = createCardReplyStrategy(buildCtx(card, { log: log as any }));
            // No counts passed (e.g. older runtime)
            await strategy.finalize();
            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            expect(finishAICardMock.mock.calls[0][1]).toBe("");
        });
    });

    describe("abort", () => {
        it("calls finishAICard with error message", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.abort(new Error("dispatch crashed"));
            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            expect(finishAICardMock.mock.calls[0][1]).toContain("处理失败");
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
    });
});
