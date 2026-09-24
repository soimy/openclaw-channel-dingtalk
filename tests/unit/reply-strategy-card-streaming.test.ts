import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Import the fixture first: its vi.mock registrations must be in place before
// the module under test is evaluated.
import {
    commitAICardBlocksMock,
    updateAICardBlockListMock,
    streamAICardContentMock,
    clearAICardStreamingContentMock,
    makeCard,
    buildCtx,
    beforeEachReplyStrategyCard,
    afterEachReplyStrategyCard,
} from "./fixtures/reply-strategy-card";
import { createCardReplyStrategy } from "../../src/messaging/reply-strategy-card";

describe("reply-strategy-card streaming options", () => {
    beforeEach(beforeEachReplyStrategyCard);
    afterEach(afterEachReplyStrategyCard);

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

        it("requests automatic source delivery so runtime final replies reach the card", () => {
            const card = makeCard();
            const opts = createCardReplyStrategy(buildCtx(card)).getReplyOptions();

            expect((opts as { sourceReplyDeliveryMode?: string }).sourceReplyDeliveryMode).toBe("automatic");
        });

        it("always registers onPartialReply (for all streaming modes)", () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            expect(strategy.getReplyOptions().onPartialReply).toBeDefined();
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
            expect(updateAICardBlockListMock).not.toHaveBeenCalled();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 先检查当前改动_" });
            await vi.advanceTimersByTimeAsync(0);

            expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
            expect(updateAICardBlockListMock.mock.calls[0]?.[1]).toContain("Reason: 先检查当前改动");
        });

        it("buffers unprefixed reasoning stream lines until the final answer boundary", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_先检查当前目录_" });
            await vi.advanceTimersByTimeAsync(0);
            expect(updateAICardBlockListMock).not.toHaveBeenCalled();

            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
            expect(updateAICardBlockListMock.mock.calls[0]?.[1]).toContain("先检查当前目录");
        });

        it("flushes the latest grown unprefixed reasoning snapshot instead of the first truncated line", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_用户再次_" });
            await opts.onReasoningStream?.({ text: "Reasoning:\n_用户再次要求分步思考后给出结论_" });
            await vi.advanceTimersByTimeAsync(0);
            expect(updateAICardBlockListMock).not.toHaveBeenCalled();

            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            const streamed = updateAICardBlockListMock.mock.calls[0]?.[1] ?? "";
            expect(streamed).toContain("用户再次要求分步思考后给出结论");
            expect(streamed).not.toContain("用户再次\n");
        });

        it("resets reasoning assembly on a new assistant turn so later turns can emit fresh think blocks", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 第一轮思考_" });
            await vi.advanceTimersByTimeAsync(0);
            expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);

            await opts.onAssistantMessageStart?.();
            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 第二轮新思考_" });
            await vi.advanceTimersByTimeAsync(0);

            expect(updateAICardBlockListMock).toHaveBeenCalledTimes(2);
            expect(updateAICardBlockListMock.mock.calls[1]?.[1]).toContain("Reason: 第二轮新思考");
        });

        it("flushes unfinished reasoning before resetting on a new assistant turn", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 第一轮未封口" });
            await vi.advanceTimersByTimeAsync(0);
            expect(updateAICardBlockListMock).not.toHaveBeenCalled();

            await opts.onAssistantMessageStart?.();
            await vi.advanceTimersByTimeAsync(0);

            expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
            expect(updateAICardBlockListMock.mock.calls[0]?.[1]).toContain("Reason: 第一轮未封口");
        });
    });

    describe("cardStreamingMode", () => {
        it("off mode does not live-stream partial answers and only flushes reasoning at boundary/final", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "off" } as any,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onPartialReply?.({ text: "阶段性答案" });
            await vi.advanceTimersByTimeAsync(0);
            expect(updateAICardBlockListMock).not.toHaveBeenCalled();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_先检查当前目录_" });
            await vi.advanceTimersByTimeAsync(0);
            expect(updateAICardBlockListMock).not.toHaveBeenCalled();

            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
        });

        it("answer mode streams partial answers but buffers reasoning until boundary/final", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "answer" } as any,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onPartialReply?.({ text: "阶段性答案" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardContentMock).toHaveBeenCalledTimes(1);
            expect(streamAICardContentMock.mock.calls[0]?.[1]).toContain("阶段性答案");
            expect(updateAICardBlockListMock).not.toHaveBeenCalled();

            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 暂存思考" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardContentMock).toHaveBeenCalledTimes(1);
            expect(updateAICardBlockListMock).not.toHaveBeenCalled();
        });

        it("answer mode finalize clears streaming content before the final card commit without flushing queued content", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: {
                    clientId: "id",
                    clientSecret: "s",
                    messageType: "card",
                    cardStreamingMode: "answer",
                    cardStreamInterval: 1000,
                } as any,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onPartialReply?.({ text: "阶段性答案" });
            await vi.advanceTimersByTimeAsync(0);
            await opts.onPartialReply?.({ text: "阶段性答案，追加一段很长的内容，用来模拟钉钉端仍在播放的假流式动画。" });
            await vi.advanceTimersByTimeAsync(300);
            await strategy.deliver({ text: "最终答案", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(streamAICardContentMock).toHaveBeenCalledTimes(1);
            expect(clearAICardStreamingContentMock).toHaveBeenCalledTimes(1);
            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            expect(clearAICardStreamingContentMock.mock.invocationCallOrder[0]).toBeLessThan(
                commitAICardBlocksMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
            );
        });

        it("answer mode rewrites local markdown image snapshots to placeholder text before final upload", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "answer" } as any,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onPartialReply?.({ text: "说明如下\n\n![系统图](./artifacts/demo.png)" });
            await vi.advanceTimersByTimeAsync(0);

            expect(streamAICardContentMock).toHaveBeenCalledTimes(1);
            expect(streamAICardContentMock.mock.calls[0]?.[1]).toContain("见下图系统图");
            expect(streamAICardContentMock.mock.calls[0]?.[1]).not.toContain("![系统图](./artifacts/demo.png)");
            expect(updateAICardBlockListMock).not.toHaveBeenCalled();

            await strategy.deliver({
                kind: "final",
                text: "说明如下\n\n![系统图](./artifacts/demo.png)",
                mediaUrls: [],
            } as any);
            await strategy.finalize();

            const commitPayload = commitAICardBlocksMock.mock.calls[0]?.[1];
            expect(commitPayload?.content).toContain("见下图系统图");
            expect(commitPayload?.blockListJson).toContain('"type":3');
            expect(commitPayload?.blockListJson).toContain('"text":"系统图"');
        });

        it("splits mixed reasoning+answer partial snapshots into thinking and answer lanes", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                disableBlockStreaming: false,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onPartialReply?.({
                text: "Reasoning:\n_Reason: 先检查当前目录_\n\n最终答案：/tmp",
            });
            await vi.advanceTimersByTimeAsync(0);

            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const commitPayload = commitAICardBlocksMock.mock.calls[0]?.[1];
            expect(commitPayload?.blockListJson).toContain("Reason: 先检查当前目录");
            expect(commitPayload?.blockListJson).toContain("最终答案：/tmp");
            expect(commitPayload?.content).toContain("最终答案：/tmp");
            expect(commitPayload?.content).not.toContain("Reason: 先检查当前目录");
        });

        it("all mode streams answer partials and reasoning snapshots live", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "all" } as any,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "第一轮推理" });
            await vi.advanceTimersByTimeAsync(0);
            expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
            expect(updateAICardBlockListMock.mock.calls[0]?.[1]).toContain("第一轮推理");

            await opts.onAssistantMessageStart?.();
            await vi.advanceTimersByTimeAsync(0);

            await opts.onPartialReply?.({ text: "阶段性答案" });
            await vi.advanceTimersByTimeAsync(0);
            expect(streamAICardContentMock).toHaveBeenCalledTimes(1);
            expect(streamAICardContentMock.mock.calls[0]?.[1]).toContain("阶段性答案");
        });

        it("all mode streams active answer through content without duplicating it in blockList", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: { clientId: "id", clientSecret: "s", messageType: "card", cardStreamingMode: "all" } as any,
            }));
            const opts = strategy.getReplyOptions();

            await opts.onReasoningStream?.({ text: "第一轮推理" });
            await vi.advanceTimersByTimeAsync(0);
            updateAICardBlockListMock.mockClear();
            streamAICardContentMock.mockClear();

            await opts.onPartialReply?.({ text: "阶段性答案" });
            await vi.advanceTimersByTimeAsync(0);

            expect(streamAICardContentMock).toHaveBeenCalledTimes(1);
            expect(streamAICardContentMock.mock.calls[0]?.[1]).toContain("阶段性答案");
            expect(updateAICardBlockListMock).not.toHaveBeenCalled();
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
            expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
            expect(updateAICardBlockListMock.mock.calls[0]?.[1]).toContain("兼容模式推理");
        });
    });
});
