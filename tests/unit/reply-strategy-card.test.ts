import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const streamAICardMock = vi.mocked(cardService.streamAICard);
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
        vi.useFakeTimers();
        finishAICardMock.mockReset().mockResolvedValue(undefined as any);
        streamAICardMock.mockReset().mockResolvedValue(undefined);
        sendMessageMock.mockReset().mockResolvedValue({ ok: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("getReplyOptions", () => {
        it("defaults disableBlockStreaming to true", () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            expect(strategy.getReplyOptions().disableBlockStreaming).toBe(true);
        });

        it("respects disableBlockStreaming from strategy context", () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
            }));
            expect(strategy.getReplyOptions().disableBlockStreaming).toBe(false);
        });

        it("registers onPartialReply when cardStreamingMode=answer", () => {
            const card = makeCard();
            const ctx = buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "answer" } as any,
            });
            const opts = createCardReplyStrategy(ctx).getReplyOptions();
            expect(opts.onPartialReply).toBeDefined();
        });

        it("does not register onPartialReply when cardStreamingMode=off", () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "off" } as any,
            }));
            expect(strategy.getReplyOptions().onPartialReply).toBeUndefined();
        });

        it("streams partial answers into the card timeline when cardStreamingMode=answer", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "answer" } as any,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onPartialReply?.({ text: "阶段性答案" });
            await vi.advanceTimersByTimeAsync(0);

            expect(streamAICardMock).toHaveBeenCalledTimes(1);
            expect(streamAICardMock.mock.calls[0]?.[1]).toContain("阶段性答案");
        });

        it("always registers onReasoningStream and onAssistantMessageStart", () => {
            const card = makeCard();
            const opts = createCardReplyStrategy(buildCtx(card)).getReplyOptions();
            expect(opts.onReasoningStream).toBeDefined();
            expect(opts.onAssistantMessageStart).toBeDefined();
        });

        it("buffers reasoning stream snapshots until a complete think block is formed", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 先检查" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).not.toHaveBeenCalled();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 先检查当前改动_" });
            await vi.advanceTimersByTimeAsync(0);

            expect(streamAICardMock).toHaveBeenCalledTimes(1);
            expect(streamAICardMock.mock.calls[0]?.[1]).toContain("> Reason: 先检查当前改动");
        });

        it("buffers unprefixed reasoning stream lines until the final answer boundary", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_先检查当前目录_" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).not.toHaveBeenCalled();

            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(streamAICardMock).toHaveBeenCalledTimes(1);
            expect(streamAICardMock.mock.calls[0]?.[1]).toContain("> 先检查当前目录");
        });

        it("flushes the latest grown unprefixed reasoning snapshot instead of the first truncated line", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_用户再次_" });
            await opts.onReasoningStream?.({ text: "Reasoning:\n_用户再次要求分步思考后给出结论_" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).not.toHaveBeenCalled();

            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            const streamed = streamAICardMock.mock.calls[0]?.[1] ?? "";
            expect(streamed).toContain("> 用户再次要求分步思考后给出结论");
            expect(streamed).not.toContain("> 用户再次\n");
        });

        it("resets reasoning assembly on a new assistant turn so later turns can emit fresh think blocks", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 第一轮思考_" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).toHaveBeenCalledTimes(1);

            await opts.onAssistantMessageStart?.();
            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 第二轮新思考_" });
            await vi.advanceTimersByTimeAsync(0);

            expect(streamAICardMock).toHaveBeenCalledTimes(2);
            expect(streamAICardMock.mock.calls[1]?.[1]).toContain("> Reason: 第二轮新思考");
        });

        it("flushes unfinished reasoning before resetting on a new assistant turn", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 第一轮未封口" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).not.toHaveBeenCalled();

            await opts.onAssistantMessageStart?.();
            await vi.advanceTimersByTimeAsync(0);

            expect(streamAICardMock).toHaveBeenCalledTimes(1);
            expect(streamAICardMock.mock.calls[0]?.[1]).toContain("> Reason: 第一轮未封口");
        });
    });

    describe("cardStreamingMode", () => {
        it("off mode does not live-stream partial answers and only flushes reasoning at boundary/final", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "off" } as any,
            }));
            const opts = strategy.getReplyOptions();

            expect(opts.onPartialReply).toBeUndefined();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_先检查当前目录_" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).not.toHaveBeenCalled();

            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(streamAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("> 先检查当前目录");
            expect(rendered).toContain("最终答案");
        });

        it("answer mode streams partial answers but buffers reasoning until boundary/final", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "answer" } as any,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onPartialReply?.({ text: "阶段性答案" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).toHaveBeenCalledTimes(1);
            expect(streamAICardMock.mock.calls[0]?.[1]).toContain("阶段性答案");

            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 暂存思考" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).toHaveBeenCalledTimes(1);

            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("> Reason: 暂存思考");
            expect(rendered).toContain("最终答案");
        });

        it("all mode streams answer partials and reasoning snapshots live", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "all" } as any,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "第一轮推理" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).toHaveBeenCalledTimes(1);
            expect(streamAICardMock.mock.calls[0]?.[1]).toContain("> 第一轮推理");

            await opts.onAssistantMessageStart?.();
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).toHaveBeenCalledTimes(1);

            await opts.onPartialReply?.({ text: "阶段性答案" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).toHaveBeenCalledTimes(2);
            expect(streamAICardMock.mock.calls[1]?.[1]).toContain("阶段性答案");
        });

        it("legacy fallback maps cardRealTimeStream=true to all mode when cardStreamingMode is omitted", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardRealTimeStream: true } as any,
            }));
            const opts = strategy.getReplyOptions();

            expect(opts.onPartialReply).toBeDefined();

            await opts.onReasoningStream?.({ text: "兼容模式推理" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).toHaveBeenCalledTimes(1);
            expect(streamAICardMock.mock.calls[0]?.[1]).toContain("> 兼容模式推理");

            await opts.onPartialReply?.({ text: "兼容模式答案" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).toHaveBeenCalledTimes(2);
            expect(streamAICardMock.mock.calls[1]?.[1]).toContain("兼容模式答案");
        });

        it("legacy fallback keeps the faster 300ms default throttle when cardStreamInterval is unset", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardRealTimeStream: true } as any,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "快速推理1" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).toHaveBeenCalledTimes(1);

            await opts.onReasoningStream?.({ text: "快速推理2" });
            await vi.advanceTimersByTimeAsync(299);
            expect(streamAICardMock).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1);
            expect(streamAICardMock).toHaveBeenCalledTimes(2);
            expect(streamAICardMock.mock.calls[1]?.[1]).toContain("> 快速推理2");
        });

        it("explicit cardStreamingMode wins over deprecated cardRealTimeStream", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: {
                    clientId: "id",
                    clientSecret: "s",
                    messageType: "card",
                    cardStreamingMode: "off",
                    cardRealTimeStream: true,
                } as any,
            }));
            const opts = strategy.getReplyOptions();

            expect(opts.onPartialReply).toBeUndefined();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 优先显式模式" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).not.toHaveBeenCalled();

            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("> Reason: 优先显式模式");
            expect(rendered).toContain("最终答案");
        });

        it("respects cardStreamInterval for throttle in all mode", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: {
                    clientId: "id",
                    clientSecret: "s",
                    messageType: "card",
                    cardStreamingMode: "all",
                    cardStreamInterval: 2000,
                } as any,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "快速思考1" });
            await vi.advanceTimersByTimeAsync(500);
            await opts.onReasoningStream?.({ text: "快速思考2" });
            await vi.advanceTimersByTimeAsync(500);

            const callsAt1000 = streamAICardMock.mock.calls.length;
            expect(callsAt1000).toBe(1);

            await vi.advanceTimersByTimeAsync(1000);
            const callsAt2000 = streamAICardMock.mock.calls.length;
            expect(callsAt2000).toBe(2);
            expect(streamAICardMock.mock.calls[callsAt2000 - 1]?.[1]).toContain("> 快速思考2");
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

        it("deliver(block) with explicit reasoning metadata respects off-mode buffering before final", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "off" } as any,
            }));

            await strategy.deliver({
                text: "Reasoning:\n_Reason: 先检查当前目录_",
                mediaUrls: [],
                kind: "block",
                isReasoning: true,
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(streamAICardMock).not.toHaveBeenCalled();

            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(streamAICardMock.mock.calls.length).toBeGreaterThanOrEqual(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("> Reason: 先检查当前目录");
            expect(rendered).toContain("最终答案");
        });

        it("deliver(block) with explicit reasoning metadata streams live in all mode", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "all" } as any,
            }));

            await strategy.deliver({
                text: "Reasoning:\n_Reason: 先检查当前目录_",
                mediaUrls: [],
                kind: "block",
                isReasoning: true,
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(streamAICardMock).toHaveBeenCalledTimes(1);
            expect(streamAICardMock.mock.calls[0]?.[1]).toContain("> Reason: 先检查当前目录");
        });

        it("deliver(block) routes standalone Reasoning text into the thinking lane when no explicit reasoning metadata is present", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
            }));

            await strategy.deliver({
                text: "Reasoning:\n_用户要求分步思考后给结论，纯推理任务。_",
                mediaUrls: [],
                kind: "block",
            });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("> 用户要求分步思考后给结论，纯推理任务。");
            expect(rendered).not.toContain("Reasoning:\n_用户要求分步思考后给结论，纯推理任务。_");
        });

        it("deliver(block) updates the answer timeline when block streaming is enabled for card mode", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
            }));

            await strategy.deliver({
                text: "最终答案",
                mediaUrls: [],
                kind: "block",
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(streamAICardMock).toHaveBeenCalledTimes(1);
            expect(streamAICardMock.mock.calls[0]?.[1]).toContain("最终答案");
            expect(streamAICardMock.mock.calls[0]?.[1]).not.toContain("> 最终答案");
        });

        it("deliver(block) splits mixed answer-plus-Reasoning payloads into thinking and answer timeline entries", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
            }));

            await strategy.deliver({
                text: "结论：3天\n\nReasoning:\n_1. 任务总量设为 1。_\n_2. 团队总效率为 1/3。_",
                mediaUrls: [],
                kind: "block",
            });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("结论：3天");
            expect(rendered).toContain("> 1. 任务总量设为 1。");
            expect(rendered).not.toContain("Reasoning:\n_1. 任务总量设为 1。_");
            expect(rendered.indexOf("> 1. 任务总量设为 1。")).toBeLessThan(rendered.indexOf("结论：3天"));
        });

        it("deliver(block) keeps markdown reasoning-process sections as plain answer text without explicit reasoning markers", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
            }));

            await strategy.deliver({
                text:
                    "**分步思考过程**：\n\n" +
                    "**第一步：设定基准并计算单人效率**\n" +
                    "- 设总任务量为 1\n" +
                    "- 第1人效率：1 ÷ 10 = 1/10\n\n" +
                    "**结论：这项任务预计 3 天完成。** ✅",
                mediaUrls: [],
                kind: "block",
            });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("**分步思考过程**：");
            expect(rendered).toContain("**第一步：设定基准并计算单人效率**");
            expect(rendered).toContain("- 第1人效率：1 ÷ 10 = 1/10");
            expect(rendered).toContain("**结论：这项任务预计 3 天完成。** ✅");
            expect(rendered).not.toContain("> **分步思考过程**：");
        });
        it("deliver(block) preserves answer text even when card block streaming is disabled", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));

            await strategy.deliver({
                text: "这是通过 block 投递的答案",
                mediaUrls: [],
                kind: "block",
            });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("这是通过 block 投递的答案");
            expect(rendered).not.toContain("✅ Done");
        });

        it("deliver(final) with empty text still falls through for card finalize", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            expect(strategy.getFinalText()).toBe("✅ Done");
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
            const rendered = finishAICardMock.mock.calls[0][1];
            expect(rendered).toContain("> 先检查差异");
            expect(rendered).toContain("> git diff --stat");
            expect(rendered).toContain("the answer");
            expect(rendered).not.toContain("> the answer");
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

            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            const phase1Index = rendered.indexOf("阶段1答案：准备先检查当前目录");
            const tool1Index = rendered.indexOf("🛠️ Exec: pwd");
            const phase2Index = rendered.indexOf("阶段2答案：pwd 已返回结果");
            const tool2Index = rendered.indexOf("🛠️ Exec: printf ok");
            const phase3Index = rendered.indexOf("阶段3答案：两次工具都已完成");

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
            const rendered = finishAICardMock.mock.calls[0][1];
            expect(rendered).toContain("> 我来发附件");
            expect(rendered).toContain("✅ Done");
        });

        it("uses the standard empty final reply when process blocks exist but no answer text was delivered", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
            } as any) as any);

            await strategy.deliver({
                text: "Reasoning:\n_Reason: 先执行 pwd_",
                mediaUrls: [],
                kind: "block",
                isReasoning: true,
            });
            await strategy.deliver({ text: "pwd", mediaUrls: [], kind: "tool" });
            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("> Reason: 先执行 pwd");
            expect(rendered).toContain("> pwd");
            expect(rendered).toContain("✅ Done");
            expect(rendered).not.toContain("/Users/sym/clawd");
        });

        it("ignores legacy transcript fallback inputs even when they are present on the strategy context", async () => {
            const card = makeCard();
            const readFinalAnswerFromTranscript = vi.fn().mockResolvedValue("/Users/sym/clawd");
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
                sessionKey: "agent:main:direct:manager8031",
                sessionAgentId: "main",
                enableTemporaryTranscriptFinalAnswerFallback: true,
                readFinalAnswerFromTranscript,
            } as any) as any);

            await strategy.deliver({
                text: "Reasoning:\n_Reason: 先执行 pwd_",
                mediaUrls: [],
                kind: "block",
                isReasoning: true,
            });
            await strategy.deliver({ text: "pwd", mediaUrls: [], kind: "tool" });
            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(readFinalAnswerFromTranscript).not.toHaveBeenCalled();
            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("✅ Done");
            expect(rendered).not.toContain("/Users/sym/clawd");
        });

        it("finalize preserves answer text that only arrived through block delivery", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
            }));

            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "block" });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("最终答案");
            expect(rendered).not.toContain("✅ Done");
        });

        it("finalize keeps the latest partial answer when final delivery has no explicit answer text", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: {
                    clientId: "id",
                    clientSecret: "secret",
                    messageType: "card",
                    cardRealTimeStream: true,
                } as any,
            }));

            await strategy.getReplyOptions().onPartialReply?.({ text: "阶段性答案" });
            await strategy.deliver({
                text: "Reasoning:\n_Reason: 先执行 pwd_",
                mediaUrls: [],
                kind: "block",
                isReasoning: true,
            });
            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("阶段性答案");
            expect(rendered).toContain("> Reason: 先执行 pwd");
        });

        it("finalize keeps late pure-reasoning blocks before the current answer in the same segment", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
            }));

            await strategy.deliver({
                text: "收到！这是一条完全不需要工具的消息。",
                mediaUrls: [],
                kind: "block",
            });
            await strategy.deliver({
                text: "Reasoning:\n_The user is asking me to send a message that doesn't require tools._",
                mediaUrls: [],
                kind: "block",
                isReasoning: true,
            });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("> The user is asking me to send a message that doesn't require tools.");
            expect(rendered).toContain("收到！这是一条完全不需要工具的消息。");
            expect(rendered.indexOf("> The user is asking me to send a message that doesn't require tools.")).toBeLessThan(
                rendered.indexOf("收到！这是一条完全不需要工具的消息。"),
            );
        });

        it("finalize routes late visible Reasoning text without metadata into the thinking lane", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
            }));

            await strategy.deliver({
                text: "经过分步计算，结论如下：任务预计 3 天完成。",
                mediaUrls: [],
                kind: "block",
            });
            await strategy.deliver({
                text: "Reasoning:\n_1. 先计算每个人的效率_\n_2. 再汇总总效率_",
                mediaUrls: [],
                kind: "block",
            });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("> 1. 先计算每个人的效率");
            expect(rendered).toContain("> 2. 再汇总总效率");
            expect(rendered).not.toContain("Reasoning:\n_1. 先计算每个人的效率_");
        });

        it("finalize splits mixed final payloads into thinking and answer content without explicit reasoning metadata", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
            }));

            await strategy.deliver({
                text: "经过分步计算，结论如下：任务预计 3 天完成。\n\nReasoning:\n_1. 先计算每个人的效率_\n_2. 再汇总总效率_",
                mediaUrls: [],
                kind: "final",
            });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("经过分步计算，结论如下：任务预计 3 天完成。");
            expect(rendered).toContain("> 1. 先计算每个人的效率");
            expect(rendered).not.toContain("Reasoning:\n_1. 先计算每个人的效率_");
            expect(rendered.indexOf("> 1. 先计算每个人的效率")).toBeLessThan(
                rendered.indexOf("经过分步计算，结论如下：任务预计 3 天完成。"),
            );
            expect(strategy.getFinalText()).toBe("经过分步计算，结论如下：任务预计 3 天完成。");
        });
        it("finalize prefers the final answer snapshot over an earlier partial answer", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: {
                    clientId: "id",
                    clientSecret: "secret",
                    messageType: "card",
                    cardRealTimeStream: true,
                } as any,
            }));
            const replyOptions = strategy.getReplyOptions();

            await replyOptions.onPartialReply?.({ text: "阶段性答案" });
            await strategy.deliver({ text: "阶段性答案 + 最终补充", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("阶段性答案 + 最终补充");
            expect(rendered).not.toContain("阶段性答案\n");
            expect(strategy.getFinalText()).toBe("阶段性答案 + 最终补充");
        });

        it("ignores late partial snapshots after first final while still accepting late answer blocks/finals, reasoning, and tool tails", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: {
                    clientId: "id",
                    clientSecret: "secret",
                    messageType: "card",
                    cardStreamingMode: "answer",
                } as any,
            }));
            const replyOptions = strategy.getReplyOptions();

            await replyOptions.onPartialReply?.({ text: "阶段性答案" });
            await strategy.deliver({ text: "首个最终答案", mediaUrls: [], kind: "final" });

            await replyOptions.onPartialReply?.({ text: "晚到 partial 答案（应忽略）" });
            await strategy.deliver({ text: "晚到 block 答案（应吸收）", mediaUrls: [], kind: "block" });
            await replyOptions.onReasoningStream?.({ text: "Reasoning:\n_Reason: 最后补齐思考_" });
            await strategy.deliver({ text: "late tool output", mediaUrls: [], kind: "tool" });
            await strategy.deliver({ text: "晚到 final 覆盖答案（应吸收）", mediaUrls: [], kind: "final" });

            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("> Reason: 最后补齐思考");
            expect(rendered).toContain("> late tool output");
            expect(rendered.indexOf("> late tool output")).toBeLessThan(
                rendered.indexOf("晚到 final 覆盖答案（应吸收）"),
            );
            expect(rendered).not.toContain("晚到 partial 答案（应忽略）");
            expect(rendered).not.toContain("首个最终答案");
            expect(rendered).not.toContain("阶段性答案");
            expect(strategy.getFinalText()).toBe("晚到 final 覆盖答案（应吸收）");
        });

        it("in final_seen inserts late tool before the last sealed answer that gets overridden at finalize", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: {
                    clientId: "id",
                    clientSecret: "secret",
                    messageType: "card",
                    cardStreamingMode: "answer",
                } as any,
            }));
            const replyOptions = strategy.getReplyOptions();

            await replyOptions.onPartialReply?.({ text: "阶段性答案（将被冻结答案覆盖）" });
            await replyOptions.onAssistantMessageStart?.();
            await strategy.deliver({ text: "首个最终答案", mediaUrls: [], kind: "final" });
            await strategy.deliver({ text: "late sealed-case tool output", mediaUrls: [], kind: "tool" });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("首个最终答案");
            expect(rendered).toContain("> late sealed-case tool output");
            expect(rendered.indexOf("> late sealed-case tool output")).toBeLessThan(
                rendered.indexOf("首个最终答案"),
            );
            expect(rendered).not.toContain("阶段性答案（将被冻结答案覆盖）");
        });

        it("ignores all callbacks and deliveries after finalize seals the card lifecycle", async () => {
            const card = makeCard();
            const ctx = buildCtx(card, {
                config: {
                    clientId: "id",
                    clientSecret: "secret",
                    messageType: "card",
                    cardStreamingMode: "all",
                } as any,
            });
            const strategy = createCardReplyStrategy(ctx);
            const replyOptions = strategy.getReplyOptions();

            await strategy.deliver({ text: "首个最终答案", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            const streamCallCountAfterFinalize = streamAICardMock.mock.calls.length;
            await replyOptions.onPartialReply?.({ text: "sealed 后 partial（应忽略）" });
            await replyOptions.onReasoningStream?.({ text: "Reasoning:\n_Reason: sealed 后 reasoning（应忽略）_" });
            await replyOptions.onAssistantMessageStart?.();
            await strategy.deliver({ text: "sealed 后 tool（应忽略）", mediaUrls: [], kind: "tool" });
            await strategy.deliver({ text: "sealed 后 final（应忽略）", mediaUrls: ["/tmp/final.png"], kind: "final" });

            expect(streamAICardMock.mock.calls.length).toBe(streamCallCountAfterFinalize);
            expect(ctx.deliverMedia).not.toHaveBeenCalled();
            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            expect(strategy.getFinalText()).toBe("首个最终答案");
        });

        it("streams plain reasoning-like partial replies as ordinary answer text when no explicit reasoning signal exists", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
                config: {
                    clientId: "id",
                    clientSecret: "secret",
                    messageType: "card",
                    cardRealTimeStream: true,
                } as any,
            }));
            const replyOptions = strategy.getReplyOptions();

            await replyOptions.onPartialReply?.({
                text: "分步推理过程如下：\n1. 先计算每个人的效率\n2. 再汇总总效率",
            });
            await strategy.deliver({
                text: "任务预计 3 天完成。",
                mediaUrls: [],
                kind: "final",
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(streamAICardMock).toHaveBeenCalled();
            const streamed = streamAICardMock.mock.calls.at(0)?.[1] ?? "";
            expect(streamed).toContain("分步推理过程如下：");
            expect(streamed).toContain("1. 先计算每个人的效率");
            expect(streamed).not.toContain("> 分步推理过程如下：");
        });

        it("keeps markdown-wrapped reasoning-process text as plain answer content when reasoning-on compatibility is disabled", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
                config: {
                    clientId: "id",
                    clientSecret: "secret",
                    messageType: "card",
                    cardRealTimeStream: true,
                } as any,
            }));
            const replyOptions = strategy.getReplyOptions();

            await replyOptions.onPartialReply?.({
                text: "**分步思考过程**：\n\n**第一步：设定基准并计算单人效率**",
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardMock).toHaveBeenCalledTimes(1);
            expect(streamAICardMock.mock.calls.at(-1)?.[1] ?? "").toContain("**分步思考过程**：");

            await strategy.deliver({
                text: "**分步思考过程**：\n\n**第一步：设定基准并计算单人效率**\n\nReasoning:\n_1. 设总任务量为1_\n_2. 团队总效率为1/3_",
                mediaUrls: [],
                kind: "block",
            });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("**分步思考过程**：");
            expect(rendered).toContain("Reasoning:\n_1. 设总任务量为1_");
            expect(rendered).not.toContain("> 1. 设总任务量为1");
        });
        it("flushes pending reasoning before appending a tool block", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({
                text: "Reasoning:\n_Reason: 先检查当前目录\n还在整理发送链路",
            });
            await strategy.deliver({ text: "git diff --stat", mediaUrls: [], kind: "tool" });
            await vi.advanceTimersByTimeAsync(0);

            const rendered = streamAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("> Reason: 先检查当前目录");
            expect(rendered).toContain("> 还在整理发送链路");
            expect(rendered).toContain("> git diff --stat");
        });

        it("flushes pending reasoning before final answer is finalized", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({
                text: "Reasoning:\n_Reason: 先检查当前目录\n还在整理发送链路",
            });
            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(finishAICardMock).toHaveBeenCalledTimes(1);
            const rendered = finishAICardMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("> Reason: 先检查当前目录");
            expect(rendered).toContain("> 还在整理发送链路");
            expect(rendered).toContain("最终答案");
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
