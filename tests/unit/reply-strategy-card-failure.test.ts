import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AICardStatus } from "../../src/platform/types";
import { accumulateUsage, getUsageByRunId } from "../../src/card/run-usage-store";
// Import the fixture first: its vi.mock registrations must be in place before
// the module under test is evaluated.
import {
    commitAICardBlocksMock,
    sendSplitProactiveCardsMock,
    sendMessageMock,
    makeCard,
    buildCtx,
    beforeEachReplyStrategyCard,
    afterEachReplyStrategyCard,
} from "./fixtures/reply-strategy-card";
import { createCardReplyStrategy } from "../../src/messaging/reply-strategy-card";

describe("reply-strategy-card failure fallback", () => {
    beforeEach(beforeEachReplyStrategyCard);
    afterEach(afterEachReplyStrategyCard);

    describe("finalize", () => {
        it("sends markdown fallback when card is already FINISHED but session-recovery produced new content", async () => {
            const card = makeCard({ state: AICardStatus.FINISHED });
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "recovery answer", mediaUrls: [], kind: "final" });
            await strategy.finalize();
            expect(commitAICardBlocksMock).not.toHaveBeenCalled();
            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            const fallbackText = sendMessageMock.mock.calls[0][2];
            expect(fallbackText).toContain("recovery answer");
            expect(sendMessageMock.mock.calls[0][3]).toMatchObject({
                forceMarkdown: true,
            });
        });

        it("keeps FINISHED recovery fallback answer-only even when reasoning content exists", async () => {
            const card = makeCard({ state: AICardStatus.FINISHED });
            const strategy = createCardReplyStrategy(buildCtx(card));
            strategy.getReplyOptions().onReasoningStream?.({ text: "思考中" });
            await strategy.deliver({ text: "final answer", mediaUrls: [], kind: "final" });
            await strategy.finalize();
            expect(commitAICardBlocksMock).not.toHaveBeenCalled();
            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            const fallbackText = sendMessageMock.mock.calls[0][2];
            expect(fallbackText).toContain("final answer");
            expect(fallbackText).not.toContain("> 思考中");
        });

        it("logs warning but does not throw when FINISHED recovery fallback send fails", async () => {
            sendMessageMock.mockResolvedValueOnce({ ok: false, error: "network error" });
            const card = makeCard({ state: AICardStatus.FINISHED });
            const logSpy = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
            const strategy = createCardReplyStrategy(buildCtx(card, { log: logSpy }));
            await strategy.deliver({ text: "recovery content", mediaUrls: [], kind: "final" });
            await expect(strategy.finalize()).resolves.not.toThrow();
            expect(logSpy.warn).toHaveBeenCalledWith(
                expect.stringContaining("Markdown fallback after FINISHED card failed"),
            );
        });

        it("sends markdown fallback with answer-only content when card FAILED", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            strategy.getReplyOptions().onReasoningStream?.({ text: "分析上下文" });
            await strategy.deliver({ text: "git status", mediaUrls: [], kind: "tool" });
            await strategy.deliver({ text: "full answer", mediaUrls: [], kind: "final" });
            card.state = AICardStatus.FAILED;
            await strategy.finalize();

            expect(commitAICardBlocksMock).not.toHaveBeenCalled();
            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            const fallbackText = sendMessageMock.mock.calls[0][2];
            expect(fallbackText).toContain("full answer");
            expect(sendMessageMock.mock.calls[0][3]).toMatchObject({
                forceMarkdown: true,
            });
        });

        it("sets card state to FAILED when commitAICardBlocks throws", async () => {
            const card = makeCard();
            commitAICardBlocksMock.mockRejectedValueOnce(new Error("api error"));
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "text", mediaUrls: [], kind: "final" });
            await strategy.finalize();
            expect(card.state).toBe(AICardStatus.FAILED);
        });

        it("logs error payload when commitAICardBlocks throws with response data", async () => {
            const card = makeCard();
            const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
            commitAICardBlocksMock.mockRejectedValueOnce({
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
            await strategy.finalize();
            expect(commitAICardBlocksMock).not.toHaveBeenCalled();
        });

    });

    describe("abort", () => {
        it("calls commitAICardBlocks with error message", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.abort(new Error("dispatch crashed"));
            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            expect(commitAICardBlocksMock.mock.calls[0][1]?.content).toContain("处理失败");
        });

        it("sets card FAILED when commitAICardBlocks throws during abort", async () => {
            const card = makeCard();
            commitAICardBlocksMock.mockRejectedValueOnce(new Error("cannot finalize"));
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.abort(new Error("dispatch crashed"));
            expect(card.state).toBe(AICardStatus.FAILED);
        });

        it("skips abort when card is already in terminal state", async () => {
            const card = makeCard({ state: AICardStatus.FINISHED });
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.abort(new Error("dispatch crashed"));
            expect(commitAICardBlocksMock).not.toHaveBeenCalled();
        });
    });

    describe("card failure fallback", () => {
        it("sends user-friendly fallback message when card fails without answer content", async () => {
            const card = makeCard({ state: AICardStatus.FAILED });
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            await strategy.finalize();

            // Should send fallback message
            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            const sentText = sendMessageMock.mock.calls[0][2];
            // Should NOT be JSON (no blockList)
            expect(sentText).not.toMatch(/^\[/);
            expect(sentText).not.toMatch(/^\{/);
        });

        it("sends rendered timeline content when card fails with answer content", async () => {
            const card = makeCard({ state: AICardStatus.FAILED });
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            // Deliver final answer content
            await strategy.deliver({ kind: "final", text: "最终答案内容", mediaUrls: [] });
            await strategy.finalize();

            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            const sentText = sendMessageMock.mock.calls[0]?.[2];
            expect(sentText).toContain("最终答案内容");
        });

        it("uses forceMarkdown when sending fallback after card failure", async () => {
            const card = makeCard({ state: AICardStatus.FAILED });
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            await strategy.finalize();

            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            const options = sendMessageMock.mock.calls[0]?.[3];
            expect(options?.forceMarkdown).toBe(true);
        });

        it("falls back to markdown with full text when rescue sends zero cards (review P1)", async () => {
            const card = makeCard({ state: AICardStatus.PROCESSING });
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            commitAICardBlocksMock.mockRejectedValueOnce(new Error("commit failed"));
            sendSplitProactiveCardsMock.mockResolvedValue({
                ok: false,
                error: "first card failed",
                sent: 0,
                total: 2,
                unsentChunks: ["最终答案内容第一段", "最终答案内容第二段"],
            });

            await strategy.deliver({ kind: "final", text: "最终答案内容第一段最终答案内容第二段", mediaUrls: [] });
            await strategy.finalize();

            expect(sendSplitProactiveCardsMock).toHaveBeenCalled();
            // Chunks are redelivered one message per chunk, no rejoined text.
            expect(sendMessageMock).toHaveBeenCalledTimes(2);
            expect(sendMessageMock.mock.calls[0]?.[2]).toBe("最终答案内容第一段");
            expect(sendMessageMock.mock.calls[1]?.[2]).toBe("最终答案内容第二段");
            expect(sendMessageMock.mock.calls[0]?.[3]?.forceMarkdown).toBe(true);
            expect(sendMessageMock.mock.calls[1]?.[3]?.forceMarkdown).toBe(true);
        });

        it("resends only the unsent suffix after a partial split send (review P1)", async () => {
            const card = makeCard({ state: AICardStatus.FAILED });
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            sendSplitProactiveCardsMock.mockResolvedValue({
                ok: false,
                error: "second card failed",
                sent: 1,
                total: 2,
                unsentChunks: ["未发送的后缀"],
            });

            await strategy.deliver({ kind: "final", text: "已发送的前缀未发送的后缀", mediaUrls: [] });
            await strategy.finalize();

            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            const sentText = sendMessageMock.mock.calls[0]?.[2];
            expect(sentText).toBe("未发送的后缀");
            const options = sendMessageMock.mock.calls[0]?.[3];
            expect(options?.forceMarkdown).toBe(true);
        });

        it("redelivers newline-free unsent chunks without injecting separators (review P2)", async () => {
            const card = makeCard({ state: AICardStatus.FAILED });
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            // Newline-free long content split into two chunks: redelivery must
            // not fabricate any separator between them.
            sendSplitProactiveCardsMock.mockResolvedValue({
                ok: false,
                error: "second card failed",
                sent: 1,
                total: 2,
                unsentChunks: ["x".repeat(2400), "y".repeat(2400)],
            });

            await strategy.deliver({ kind: "final", text: "x".repeat(2400) + "y".repeat(2400), mediaUrls: [] });
            await strategy.finalize();

            expect(sendMessageMock).toHaveBeenCalledTimes(2);
            expect(sendMessageMock.mock.calls[0]?.[2]).toBe("x".repeat(2400));
            expect(sendMessageMock.mock.calls[1]?.[2]).toBe("y".repeat(2400));
        });

        it("resends only the unsent suffix when commit rescue partially fails (review P1)", async () => {
            const card = makeCard({ state: AICardStatus.PROCESSING });
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            commitAICardBlocksMock.mockRejectedValueOnce(new Error("commit failed"));
            sendSplitProactiveCardsMock.mockResolvedValue({
                ok: false,
                error: "second card failed",
                sent: 1,
                total: 2,
                unsentChunks: ["救援后缀"],
            });

            await strategy.deliver({ kind: "final", text: "救援前缀救援后缀", mediaUrls: [] });
            await strategy.finalize();

            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            const sentText = sendMessageMock.mock.calls[0]?.[2];
            expect(sentText).toBe("救援后缀");
            const options = sendMessageMock.mock.calls[0]?.[3];
            expect(options?.forceMarkdown).toBe(true);
        });

        it("aggregates token usage across multiple runs (session-recovery)", async () => {
            const card = makeCard({
                accountId: "main",
                conversationId: "cid_1",
                contextConversationId: "cid_1",
                createdAt: Date.now() - 5000,
            });
            const ctx = buildCtx(card, {
                taskMeta: { model: "claude-sonnet-4-20250514", effort: "high", agent: "TestBot" },
                config: {
                    clientId: "id", clientSecret: "secret", messageType: "card",
                    cardStatusLine: { tokens: true },
                } as any,
            });
            const strategy = createCardReplyStrategy(ctx);
            const opts = strategy.getReplyOptions();

            // First run
            opts.onAgentRunStart?.("run-1");
            accumulateUsage("run-1", { input: 100, output: 50, total: 150 });

            // Second run (session-recovery)
            opts.onAgentRunStart?.("run-2");
            accumulateUsage("run-2", { input: 200, output: 80, total: 280 });

            await strategy.deliver({ text: "Hello", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalled();
            const statusLine = commitAICardBlocksMock.mock.calls[0][1].statusLine;
            // Token usage should be aggregated: 100+200=300 input, 50+80=130 output
            // statusLine with cardStatusTokens=true should contain token segments
            expect(statusLine).toBeDefined();
            expect(statusLine).toContain("↑");  // input token marker
            expect(statusLine).toContain("↓");  // output token marker
        });

        it("clears all run entries from usageStore on finalize", async () => {
            const card = makeCard({
                accountId: "main",
                conversationId: "cid_1",
            });
            const ctx = buildCtx(card, {
                taskMeta: { model: "test" },
            });
            const strategy = createCardReplyStrategy(ctx);
            const opts = strategy.getReplyOptions();

            opts.onAgentRunStart?.("run-a");
            accumulateUsage("run-a", { input: 10, output: 5 });
            opts.onAgentRunStart?.("run-b");
            accumulateUsage("run-b", { input: 20, output: 10 });

            await strategy.deliver({ text: "Done", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            // Both runs should be cleared from the store (no memory leak)
            expect(getUsageByRunId("run-a")).toBeUndefined();
            expect(getUsageByRunId("run-b")).toBeUndefined();
        });
    });
});
