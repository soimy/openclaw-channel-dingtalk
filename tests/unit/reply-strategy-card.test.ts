import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AICardStatus } from "../../src/platform/types";
// Import the fixture first: its vi.mock registrations must be in place before
// the module under test is evaluated.
import {
    commitAICardBlocksMock,
    updateAICardBlockListMock,
    streamAICardContentMock,
    sendMessageMock,
    makeCard,
    buildCtx,
    beforeEachReplyStrategyCard,
    afterEachReplyStrategyCard,
} from "./fixtures/reply-strategy-card";
import { createCardReplyStrategy } from "../../src/messaging/reply-strategy-card";

describe("reply-strategy-card", () => {
    beforeEach(beforeEachReplyStrategyCard);
    afterEach(afterEachReplyStrategyCard);

    describe("deliver", () => {
        it("deliver(final) saves text for finalize but does not send immediately", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "final answer", mediaUrls: [], kind: "final" });
            expect(sendMessageMock).not.toHaveBeenCalled();
            expect(commitAICardBlocksMock).not.toHaveBeenCalled();
            expect(strategy.getFinalText()).toBe("final answer");
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

        it("deliver(block) routes reasoning-on blocks into the card timeline", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));

            await strategy.deliver({
                text: "Reasoning:\n_Reason: 先检查当前目录_",
                mediaUrls: [],
                kind: "block",
                isReasoning: true,
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
            expect(updateAICardBlockListMock.mock.calls[0]?.[1]).toContain("Reason: 先检查当前目录");
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

            expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
            expect(updateAICardBlockListMock.mock.calls[0]?.[1]).toContain("最终答案");
        });

        it("deliver(block) in all mode streams active answer through content without duplicating it in blockList", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "all" } as any,
            }));

            await strategy.deliver({
                text: "阶段性答案",
                mediaUrls: [],
                kind: "block",
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(streamAICardContentMock).toHaveBeenCalledTimes(1);
            expect(streamAICardContentMock.mock.calls[0]?.[1]).toContain("阶段性答案");
            expect(updateAICardBlockListMock).not.toHaveBeenCalled();
        });

        it("deliver(final) with empty text still falls through for card finalize", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            expect(strategy.getFinalText()).toBe("✅ Done");
        });

        it.each(["off", "answer"] as const)("shows a late error after an empty final in %s mode", async (cardStreamingMode) => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode } as any,
            }));

            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            await strategy.deliver({ text: "⚠️ Exec failed", mediaUrls: [], kind: "final", isError: true });
            await strategy.finalize();

            const rendered = commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.content ?? "";
            expect(rendered).toContain("⚠️ Exec failed");
            expect(rendered).not.toContain("✅ Done");
        });

        it("ignores all callbacks and deliveries after finalize seals the card lifecycle", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            const opts = strategy.getReplyOptions();

            await strategy.deliver({ text: "answer", mediaUrls: [], kind: "final" });
            await strategy.finalize();
            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);

            commitAICardBlocksMock.mockClear();
            updateAICardBlockListMock.mockClear();

            // After finalize, lifecycle is sealed — these should all be ignored
            await opts.onPartialReply?.({ text: "late partial" });
            await opts.onReasoningStream?.({ text: "late reasoning" });
            await opts.onAssistantMessageStart?.();
            await strategy.deliver({ text: "late delivery", mediaUrls: [], kind: "block" });
            await vi.advanceTimersByTimeAsync(0);

            expect(updateAICardBlockListMock).not.toHaveBeenCalled();
            expect(commitAICardBlocksMock).not.toHaveBeenCalled();
        });

        it("in final_seen state, late tool is inserted before the current answer", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "answer" } as any,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onPartialReply?.({ text: "initial answer" });
            await vi.advanceTimersByTimeAsync(0);

            await strategy.deliver({ text: "final answer text", mediaUrls: [], kind: "final" });
            // Now in "final_seen" state

            await strategy.deliver({ text: "late tool result", mediaUrls: [], kind: "tool" });
            await vi.advanceTimersByTimeAsync(0);

            // The late tool should have been inserted (appendToolBeforeCurrentAnswer)
            const lastContent = updateAICardBlockListMock.mock.calls.at(-1)?.[1] ?? "";
            expect(lastContent).toContain("late tool result");
        });

    });

    describe("finalize", () => {
        it("calls commitAICardBlocks with answer-only markdown (not including reasoning/tool blocks)", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            strategy.getReplyOptions().onReasoningStream?.({ text: "先检查差异" });
            await strategy.deliver({ text: "git diff --stat", mediaUrls: [], kind: "tool" });
            await strategy.deliver({ text: "the answer", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const rendered = commitAICardBlocksMock.mock.calls[0][1]?.content;
            // getRenderedContent now returns only answer markdown, not JSON with all blocks
            expect(rendered).toBe("the answer");
            expect(rendered).not.toContain("先检查差异");  // reasoning not included
            expect(rendered).not.toContain("git diff --stat");  // tool not included
        });

        it("finalize renders answer blocks in order excluding tool blocks", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(
                buildCtx(card, {
                    config: {
                        clientId: "id",
                        clientSecret: "secret",
                        messageType: "card",
                        cardStreamingMode: "answer",
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

            const rendered = commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.content ?? "";
            // Only answer blocks should be in the rendered content
            const phase1Index = rendered.indexOf("阶段1答案：准备先检查当前目录");
            const phase2Index = rendered.indexOf("阶段2答案：pwd 已返回结果");
            const phase3Index = rendered.indexOf("阶段3答案：两次工具都已完成");

            // Answers should be in order
            expect(phase1Index).toBeGreaterThanOrEqual(0);
            expect(phase2Index).toBeGreaterThan(phase1Index);
            expect(phase3Index).toBeGreaterThan(phase2Index);

            // Tool blocks should NOT be in the rendered content (it's markdown, not JSON)
            expect(rendered).not.toContain("🛠️ Exec: pwd");
            expect(rendered).not.toContain("🛠️ Exec: printf ok");
        });

        it("skips finalize when card is already FINISHED and no new content", async () => {
            const card = makeCard({ state: AICardStatus.FINISHED });
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.finalize();
            expect(commitAICardBlocksMock).not.toHaveBeenCalled();
            expect(sendMessageMock).not.toHaveBeenCalled();
        });

        it("uses a file-only placeholder answer when no answer text is available", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            strategy.getReplyOptions().onReasoningStream?.({ text: "我来发附件" });
            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const rendered = commitAICardBlocksMock.mock.calls[0][1]?.content;
            expect(rendered).toBe("✅ Done");
        });

        it("finalize preserves answer text that only arrived through block delivery", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
            }));

            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "block" });
            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            await strategy.deliver({ text: "⚠️ Exec failed", mediaUrls: [], kind: "final", isError: true });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const rendered = commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.content ?? "";
            expect(rendered).toContain("最终答案");
            expect(rendered).not.toContain("✅ Done");
            expect(rendered).not.toContain("Exec failed");
        });

        it("finalize prefers the final answer snapshot over an earlier partial answer", async () => {
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
            await strategy.deliver({ text: "阶段性答案 + 最终补充", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const rendered = commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.content ?? "";
            expect(rendered).toContain("阶段性答案 + 最终补充");
            expect(strategy.getFinalText()).toBe("阶段性答案 + 最终补充");
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

            const rendered = updateAICardBlockListMock.mock.calls.at(-1)?.[1] ?? "";
            expect(rendered).toContain("Reason: 先检查当前目录");
            expect(rendered).toContain("还在整理发送链路");
            expect(rendered).toContain("git diff --stat");
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

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const rendered = commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.content ?? "";
            expect(rendered).toContain("最终答案");
            expect(rendered).not.toContain("Reason: 先检查当前目录");
        });

    });

    describe("quoteContent from inboundText", () => {
        it("does not overwrite quoteContent during finalize because card creation owns that field", async () => {
            const card = makeCard();
            const ctx = buildCtx(card, {
                inboundText: "用户发送的原始消息",
            });
            const strategy = createCardReplyStrategy(ctx);

            await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: [] });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const options = commitAICardBlocksMock.mock.calls[0][1];
            expect(options.quoteContent).toBeUndefined();
        });

        it("omits quoteContent when inboundText is empty", async () => {
            const card = makeCard();
            const ctx = buildCtx(card, {
                inboundText: "",
            });
            const strategy = createCardReplyStrategy(ctx);

            await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: [] });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const options = commitAICardBlocksMock.mock.calls[0][1];
            expect(options.quoteContent).toBeUndefined();
        });

    });
});
