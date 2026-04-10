import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCardReplyStrategy } from "../../src/reply-strategy-card";
import * as cardService from "../../src/card-service";
import * as sendService from "../../src/send-service";
import * as mediaUtils from "../../src/media-utils";
import { AICardStatus } from "../../src/types";
import type { AICardInstance } from "../../src/types";
import type { ReplyStrategyContext } from "../../src/reply-strategy";

vi.mock("../../src/card-service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/card-service")>();
    return {
        ...actual,
        finishAICard: vi.fn(),
        commitAICardBlocks: vi.fn(),
        updateAICardTaskInfo: vi.fn(),
        streamAICard: vi.fn(),
        updateAICardBlockList: vi.fn(),
        streamAICardContent: vi.fn(),
        clearAICardStreamingContent: vi.fn(),
    };
});

vi.mock("../../src/send-service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/send-service")>();
    return {
        ...actual,
        sendMessage: vi.fn().mockResolvedValue({ ok: true }),
        sendBySession: vi.fn().mockResolvedValue({}),
        sendProactiveTextOrMarkdown: vi.fn().mockResolvedValue({}),
        sendProactiveMedia: vi.fn().mockResolvedValue({ ok: true, mediaId: "test-media-id" }),
        uploadMedia: vi.fn().mockResolvedValue({ mediaId: "test-media-id" }),
    };
});

vi.mock("../../src/media-utils", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/media-utils")>();
    return {
        ...actual,
        prepareMediaInput: vi.fn().mockImplementation(async (input: string) => ({ path: input })),
        resolveOutboundMediaType: vi.fn().mockImplementation(({ mediaPath }: { mediaPath: string }) => {
            // Detect media type based on file extension
            if (mediaPath.endsWith(".png") || mediaPath.endsWith(".jpg") || mediaPath.endsWith(".gif")) {
                return "image";
            }
            return "file";
        }),
    };
});

const commitAICardBlocksMock = vi.mocked(cardService.commitAICardBlocks);
const updateAICardBlockListMock = vi.mocked(cardService.updateAICardBlockList);
const updateAICardTaskInfoMock = vi.mocked(cardService.updateAICardTaskInfo);
const sendMessageMock = vi.mocked(sendService.sendMessage);
const sendProactiveMediaMock = vi.mocked(sendService.sendProactiveMedia);
const uploadMediaMock = vi.mocked(sendService.uploadMedia);
const prepareMediaInputMock = vi.mocked(mediaUtils.prepareMediaInput);
const resolveOutboundMediaTypeMock = vi.mocked(mediaUtils.resolveOutboundMediaType);

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
        commitAICardBlocksMock.mockClear().mockResolvedValue(undefined);
        updateAICardBlockListMock.mockClear().mockResolvedValue(undefined);
        updateAICardTaskInfoMock.mockClear().mockResolvedValue(undefined);
        sendMessageMock.mockClear().mockResolvedValue({ ok: true });
        sendProactiveMediaMock.mockClear().mockResolvedValue({ ok: true, mediaId: "test-media-id" });
        uploadMediaMock.mockClear().mockResolvedValue({ mediaId: "test-media-id", buffer: Buffer.from("") });
        prepareMediaInputMock.mockImplementation(async (input: string) => ({ path: input }));
        resolveOutboundMediaTypeMock.mockImplementation(({ mediaPath }: { mediaPath: string }) => {
            if (mediaPath.endsWith(".png") || mediaPath.endsWith(".jpg") || mediaPath.endsWith(".gif")) {
                return "image";
            }
            if (mediaPath.endsWith(".mp3") || mediaPath.endsWith(".wav")) {
                return "voice";
            }
            if (mediaPath.endsWith(".mp4") || mediaPath.endsWith(".mov")) {
                return "video";
            }
            return "file";
        });
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
            expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
            expect(updateAICardBlockListMock.mock.calls[0]?.[1]).toContain("阶段性答案");

            await opts.onReasoningStream?.({ text: "Reasoning:\n_Reason: 暂存思考" });
            await vi.advanceTimersByTimeAsync(0);
            expect(updateAICardBlockListMock).toHaveBeenCalledTimes(1);
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
            expect(updateAICardBlockListMock.mock.calls.length).toBeGreaterThan(1);
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

    describe("deliver", () => {
        it("deliver(final) saves text for finalize but does not send immediately", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "final answer", mediaUrls: [], kind: "final" });
            expect(sendMessageMock).not.toHaveBeenCalled();
            expect(commitAICardBlocksMock).not.toHaveBeenCalled();
            expect(strategy.getFinalText()).toBe("final answer");
        });

        it("deliver(final) delivers media as image blocks", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "text", mediaUrls: ["/img.png"], kind: "final" });
            expect(uploadMediaMock).toHaveBeenCalledWith(
                expect.anything(),
                "/img.png",
                "image",
                expect.anything(),
            );
        });

        it("keeps public markdown images inline in final answer text", async () => {
            const card = makeCard();
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            await strategy.deliver({
                kind: "final",
                text: "说明如下\n\n![公网图](https://example.com/demo.png)",
                mediaUrls: [],
            } as any);

            await strategy.finalize();

            expect(uploadMediaMock).not.toHaveBeenCalled();
            const commitPayload = commitAICardBlocksMock.mock.calls[0]?.[1];
            expect(commitPayload?.blockListJson).toContain("![公网图](https://example.com/demo.png)");
            expect(commitPayload?.content).toContain("![公网图](https://example.com/demo.png)");
        });

        it("extracts local markdown images into card image blocks and leaves placeholder text", async () => {
            const card = makeCard();
            const ctx = buildCtx(card, {
                config: {
                    clientId: "id",
                    clientSecret: "secret",
                    messageType: "card",
                    mediaUrlAllowlist: ["http://127.0.0.1:3000/**"],
                } as any,
            });
            const strategy = createCardReplyStrategy(ctx);

            await strategy.deliver({
                kind: "final",
                text: "说明如下\n\n![本地图](http://127.0.0.1:3000/demo.png)",
                mediaUrls: [],
            } as any);

            await strategy.finalize();

            expect(prepareMediaInputMock).toHaveBeenCalledWith(
                "http://127.0.0.1:3000/demo.png",
                expect.anything(),
                ["http://127.0.0.1:3000/**"],
            );
            expect(uploadMediaMock).toHaveBeenCalledTimes(1);
            const commitPayload = commitAICardBlocksMock.mock.calls[0]?.[1];
            expect(commitPayload?.content).toContain("见下图本地图");
            expect(commitPayload?.content).not.toContain("![本地图](http://127.0.0.1:3000/demo.png)");
            expect(commitPayload?.blockListJson).toContain('"type":3');
            expect(commitPayload?.blockListJson).toContain('"mediaId":"test-media-id"');
            expect(commitPayload?.blockListJson).toContain('"text":"本地图"');
        });

        it("normalizes relative markdown image paths before upload", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));

            await strategy.deliver({
                kind: "final",
                text: "说明如下\n\n![本地图](./artifacts/demo.png)",
                mediaUrls: [],
            } as any);
            await strategy.finalize();

            expect(uploadMediaMock).toHaveBeenCalledWith(
                expect.anything(),
                expect.stringMatching(/artifacts[\\/]demo\.png$/),
                "image",
                expect.anything(),
            );
            expect(uploadMediaMock.mock.calls[0]?.[1]).not.toBe("./artifacts/demo.png");
        });

        it("normalizes plain relative markdown image paths before upload", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));

            await strategy.deliver({
                kind: "final",
                text: "说明如下\n\n![本地图](artifacts/demo.png)",
                mediaUrls: [],
            } as any);
            await strategy.finalize();

            expect(uploadMediaMock).toHaveBeenCalledWith(
                expect.anything(),
                expect.stringMatching(/artifacts[\\/]demo\.png$/),
                "image",
                expect.anything(),
            );
            expect(uploadMediaMock.mock.calls[0]?.[1]).not.toBe("artifacts/demo.png");
        });

        it("preserves markdown image order when extracting multiple local images", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));

            await strategy.deliver({
                kind: "final",
                text: "前文\n\n![图一](./artifacts/one.png)\n\n中间\n\n![图二](./artifacts/two.png)",
                mediaUrls: [],
            } as any);
            await strategy.finalize();

            const commitPayload = commitAICardBlocksMock.mock.calls[0]?.[1];
            const blockListJson = commitPayload?.blockListJson ?? "";
            expect(blockListJson.indexOf('"text":"图一"')).toBeLessThan(blockListJson.indexOf('"text":"图二"'));
        });

        it("keeps final answer block before extracted image blocks in final-only delivery", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));

            await strategy.deliver({
                kind: "final",
                text: "说明如下\n\n![本地图](./artifacts/demo.png)",
                mediaUrls: [],
            } as any);
            await strategy.finalize();

            const commitPayload = commitAICardBlocksMock.mock.calls[0]?.[1];
            const blocks = JSON.parse(commitPayload?.blockListJson ?? "[]") as Array<{ type: number; markdown?: string; text?: string }>;
            expect(blocks[0]).toMatchObject({
                type: 0,
                markdown: "说明如下\n\n见下图本地图",
            });
            expect(blocks[1]).toMatchObject({
                type: 3,
                text: "本地图",
            });
        });

        it("preserves original markdown image text when local image upload fails", async () => {
            uploadMediaMock.mockRejectedValueOnce(new Error("upload failed"));
            const card = makeCard();
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            await strategy.deliver({
                kind: "final",
                text: "说明如下\n\n![本地图](./artifacts/demo.png)",
                mediaUrls: [],
            } as any);

            await strategy.finalize();

            const commitPayload = commitAICardBlocksMock.mock.calls[0]?.[1];
            expect(commitPayload?.content).toContain("![本地图](./artifacts/demo.png)");
            expect(commitPayload?.blockListJson).not.toContain('"type":3');
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

        it("deliver(block) delivers media as image blocks", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "ignored", mediaUrls: ["/tmp/file.png"], kind: "block" });
            expect(uploadMediaMock).toHaveBeenCalledWith(
                expect.anything(),
                "/tmp/file.png",
                "image",
                expect.anything(),
            );
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

        it("deliver(final) with empty text still falls through for card finalize", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.deliver({ text: "", mediaUrls: [], kind: "final" });
            expect(strategy.getFinalText()).toBe("✅ Done");
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

        it("skips finalize when card is already FINISHED", async () => {
            const card = makeCard({ state: AICardStatus.FINISHED });
            const strategy = createCardReplyStrategy(buildCtx(card));
            await strategy.finalize();
            expect(commitAICardBlocksMock).not.toHaveBeenCalled();
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
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const rendered = commitAICardBlocksMock.mock.calls.at(-1)?.[1]?.content ?? "";
            expect(rendered).toContain("最终答案");
            expect(rendered).not.toContain("✅ Done");
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

    describe("quoteContent from inboundText", () => {
        it("passes inboundText as quoteContent to commitAICardBlocks on finalize", async () => {
            const card = makeCard();
            const ctx = buildCtx(card, {
                inboundText: "用户发送的原始消息",
            });
            const strategy = createCardReplyStrategy(ctx);

            await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: [] });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const options = commitAICardBlocksMock.mock.calls[0][1];
            expect(options.quoteContent).toBe("用户发送的原始消息");
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

        it("truncates long inboundText to 200 characters", async () => {
            const card = makeCard();
            const longText = "a".repeat(300);
            const ctx = buildCtx(card, {
                inboundText: longText,
            });
            const strategy = createCardReplyStrategy(ctx);

            await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: [] });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const options = commitAICardBlocksMock.mock.calls[0][1];
            expect(options.quoteContent).toBe("a".repeat(200));
            expect((options.quoteContent as string).length).toBe(200);
        });
    });

    describe("taskInfo from taskMeta", () => {
        it("passes taskMeta as taskInfoJson to commitAICardBlocks on finalize", async () => {
            const card = makeCard();
            const ctx = buildCtx(card, {
                taskMeta: {
                    model: "gpt-5.4",
                    effort: "medium",
                    usage: 12,
                    elapsedMs: 3400,
                },
            });
            const strategy = createCardReplyStrategy(ctx);

            await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: [] });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const options = commitAICardBlocksMock.mock.calls[0][1];
            expect(options.taskInfoJson).toBeDefined();
            const taskInfo = JSON.parse(options.taskInfoJson!);
            expect(taskInfo.model).toBe("gpt-5.4");
            expect(taskInfo.effort).toBe("medium");
            expect(taskInfo.dapi_usage).toBe(12);
            expect(taskInfo.taskTime).toBe(3); // rounded to seconds
        });

        it("recomputes task duration at finalize time", async () => {
            const card = makeCard();
            const ctx = buildCtx(card, {
                taskMeta: {
                    model: "gpt-5.4",
                    effort: "medium",
                    usage: 12,
                    elapsedMs: 0,
                },
            });
            const strategy = createCardReplyStrategy(ctx);

            await vi.advanceTimersByTimeAsync(3200);
            await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: [] });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const options = commitAICardBlocksMock.mock.calls[0][1];
            const taskInfo = JSON.parse(options.taskInfoJson!);
            expect(taskInfo.taskTime).toBeGreaterThanOrEqual(3);
        });

        it("omits taskInfoJson when taskMeta is not provided", async () => {
            const card = makeCard();
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            await strategy.deliver({ kind: "final", text: "回复", mediaUrls: [] });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const options = commitAICardBlocksMock.mock.calls[0][1];
            expect(options.taskInfoJson).toBeUndefined();
        });

        it("updates taskInfo early when onModelSelected fires", async () => {
            const card = makeCard({
                accountId: "main",
                conversationId: "cid_1",
                contextConversationId: "cid_1",
                createdAt: Date.now() - 3000,
                taskInfo: { dapi_usage: 1, taskTime: 0 },
            });
            const ctx = buildCtx(card, {
                taskMeta: {
                    agent: "代码专家",
                },
            });
            const strategy = createCardReplyStrategy(ctx);
            const opts = strategy.getReplyOptions();

            opts.onModelSelected?.({ model: "gpt-5.4", thinkLevel: "medium" } as any);

            expect(updateAICardTaskInfoMock).toHaveBeenCalledTimes(1);
            const taskInfoJson = updateAICardTaskInfoMock.mock.calls[0]?.[1];
            expect(taskInfoJson).toBeDefined();
            const taskInfo = JSON.parse(taskInfoJson!);
            expect(taskInfo.model).toBe("gpt-5.4");
            expect(taskInfo.effort).toBe("medium");
            expect(taskInfo.agent).toBe("代码专家");
        });

        it("includes agent in taskInfoJson when taskMeta.agent is set", async () => {
            const card = makeCard();
            const ctx = buildCtx(card, {
                taskMeta: {
                    model: "gpt-5.4",
                    agent: "代码专家",
                },
            });
            const strategy = createCardReplyStrategy(ctx);

            await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: [] });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const options = commitAICardBlocksMock.mock.calls[0][1];
            expect(options.taskInfoJson).toBeDefined();
            const taskInfo = JSON.parse(options.taskInfoJson!);
            expect(taskInfo.model).toBe("gpt-5.4");
            expect(taskInfo.agent).toBe("代码专家");
        });
    });

    describe("non-image media handling", () => {
        it("defers non-image attachments and sends them after card finalize", async () => {
            const card = makeCard();
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            // Setup: voice file should be deferred, not embedded in card
            resolveOutboundMediaTypeMock.mockImplementation(({ mediaPath }) => {
                if (mediaPath.endsWith(".mp3") || mediaPath.endsWith(".m4a")) {
                    return "voice";
                }
                return "file";
            });
            prepareMediaInputMock.mockImplementation(async (input) => ({ path: input, cleanup: vi.fn() }));

            await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: ["file://voice.mp3"] });
            await strategy.finalize();

            // Card should be finalized first
            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);

            // Non-image media should be sent via sessionWebhook when available
            // The implementation prefers sessionWebhook for reply-session semantics
            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            expect(sendMessageMock).toHaveBeenCalledWith(
                expect.anything(),
                "cid_1",
                "",
                expect.objectContaining({
                    sessionWebhook: "https://session.webhook",
                    mediaPath: "file://voice.mp3",
                    mediaType: "voice",
                    accountId: "main",
                    storePath: "/tmp/store.json",
                })
            );

            // sendProactiveMedia should NOT be called since sessionWebhook is available
            expect(sendProactiveMediaMock).not.toHaveBeenCalled();
        });

        it("embeds image media in card instead of sending separately", async () => {
            const card = makeCard();
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            resolveOutboundMediaTypeMock.mockImplementation(({ mediaPath }) => {
                if (mediaPath.endsWith(".png") || mediaPath.endsWith(".jpg")) {
                    return "image";
                }
                return "file";
            });

            await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: ["file://image.png"] });
            await strategy.finalize();

            // Image should be uploaded for card embedding
            expect(uploadMediaMock).toHaveBeenCalledWith(
                expect.anything(),
                "file://image.png",
                "image",
                expect.anything()
            );

            // Non-image media should NOT be sent separately
            expect(sendProactiveMediaMock).not.toHaveBeenCalled();
        });

        it("sends multiple non-image attachments after finalize", async () => {
            const card = makeCard();
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            resolveOutboundMediaTypeMock.mockImplementation(({ mediaPath }) => {
                if (mediaPath.endsWith(".mp3")) return "voice";
                if (mediaPath.endsWith(".mp4")) return "video";
                if (mediaPath.endsWith(".pdf")) return "file";
                return "image";
            });
            prepareMediaInputMock.mockImplementation(async (input) => ({ path: input, cleanup: vi.fn() }));

            await strategy.deliver({
                kind: "final",
                text: "回复内容",
                mediaUrls: ["file://voice.mp3", "file://video.mp4", "file://doc.pdf"]
            });
            await strategy.finalize();

            // All three non-image attachments should be sent via sessionWebhook
            expect(sendMessageMock).toHaveBeenCalledTimes(3);

            // sendProactiveMedia should NOT be called since sessionWebhook is available
            expect(sendProactiveMediaMock).not.toHaveBeenCalled();
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
    });
});
