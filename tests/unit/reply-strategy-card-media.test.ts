import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Import the fixture first: its vi.mock registrations must be in place before
// the module under test is evaluated.
import {
    commitAICardBlocksMock,
    sendMessageMock,
    sendProactiveMediaMock,
    uploadMediaMock,
    prepareMediaInputMock,
    resolveOutboundMediaTypeMock,
    makeCard,
    buildCtx,
    beforeEachReplyStrategyCard,
    afterEachReplyStrategyCard,
} from "./fixtures/reply-strategy-card";
import { createCardReplyStrategy } from "../../src/messaging/reply-strategy-card";

describe("reply-strategy-card media handling", () => {
    beforeEach(beforeEachReplyStrategyCard);
    afterEach(afterEachReplyStrategyCard);

    describe("deliver", () => {
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

        it("passes the scoped media roots to deferred attachments sent via session webhook", async () => {
            resolveOutboundMediaTypeMock.mockImplementation(({ mediaPath }: { mediaPath: string }) => {
                if (mediaPath.endsWith(".png")) {
                    return "image";
                }
                return "file";
            });

            const card = makeCard();
            const strategy = createCardReplyStrategy(
                buildCtx(card, { mediaLocalRoots: ["/state/workspace-main"] }),
            );

            await strategy.deliver({
                kind: "final",
                text: "回复内容",
                mediaUrls: ["https://example.com/demo.pdf"],
            } as any);
            await strategy.finalize();

            // The deferred attachment goes out through the session webhook, so that
            // call needs the boundary too — otherwise `workspace-<agent>` media is
            // rejected by the host bridge.
            expect(sendMessageMock).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                "",
                expect.objectContaining({ mediaLocalRoots: ["/state/workspace-main"] }),
            );
        });

        it("passes mediaUrlAllowlist when preparing payload mediaUrls and deferred attachments", async () => {
            resolveOutboundMediaTypeMock.mockImplementation(({ mediaPath }: { mediaPath: string }) => {
                if (mediaPath.endsWith(".png")) {
                    return "image";
                }
                return "file";
            });

            const card = makeCard();
            const strategy = createCardReplyStrategy(buildCtx(card, {
                config: {
                    clientId: "id",
                    clientSecret: "secret",
                    messageType: "card",
                    mediaUrlAllowlist: ["https://example.com/**"],
                } as any,
            }));

            await strategy.deliver({
                kind: "final",
                text: "回复内容",
                mediaUrls: ["https://example.com/demo.png", "https://example.com/demo.pdf"],
            } as any);
            await strategy.finalize();

            expect(prepareMediaInputMock).toHaveBeenNthCalledWith(
                1,
                "https://example.com/demo.png",
                expect.anything(),
                ["https://example.com/**"],
            );
            expect(prepareMediaInputMock).toHaveBeenNthCalledWith(
                2,
                "https://example.com/demo.pdf",
                expect.anything(),
                ["https://example.com/**"],
            );
            expect(prepareMediaInputMock).toHaveBeenNthCalledWith(
                3,
                "https://example.com/demo.pdf",
                expect.anything(),
                ["https://example.com/**"],
            );
        });

        it("passes the host-authorized media roots through to the upload", async () => {
            const card = makeCard();
            const strategy = createCardReplyStrategy(
                buildCtx(card, { mediaLocalRoots: ["/state/workspace-main"] }),
            );

            await strategy.deliver({
                kind: "final",
                text: "说明如下\n\n![本地图](/state/workspace-main/artifacts/demo.png)",
                mediaUrls: [],
            } as any);
            await strategy.finalize();

            // Without the scoped roots the runtime bridge rejects `workspace-<agent>`
            // paths, so the boundary has to reach uploadMedia.
            expect(uploadMediaMock).toHaveBeenCalledWith(
                expect.anything(),
                "/state/workspace-main/artifacts/demo.png",
                "image",
                expect.anything(),
                { mediaLocalRoots: ["/state/workspace-main"] },
            );
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

    describe("media dedup", () => {
        it("dedupes same mediaUrl across non-final and final deliver", async () => {
            const card = makeCard();
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            // Non-final deliver with image URL
            await strategy.deliver({
                text: "",
                mediaUrls: ["file:///test/image.png"],
                kind: "block",
            });

            // Final deliver with same URL
            await strategy.deliver({
                text: "",
                mediaUrls: ["file:///test/image.png"],
                kind: "final",
            });

            await strategy.finalize();

            // uploadMedia should be called only once (deduped)
            expect(uploadMediaMock).toHaveBeenCalledTimes(1);
        });

        it("dedupes same mediaUrl in rerouteMarkdownImagesFromAnswer", async () => {
            const card = makeCard();
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            // Final deliver with both mediaUrls and markdown image referencing same URL
            await strategy.deliver({
                text: "Here is the image: ![test](file:///test/image.png)",
                mediaUrls: ["file:///test/image.png"],
                kind: "final",
            });

            await strategy.finalize();

            // uploadMedia should be called only once (deduped across both paths)
            expect(uploadMediaMock).toHaveBeenCalledTimes(1);
            // The final card content should not contain the raw file:/// path
            const commitPayload = commitAICardBlocksMock.mock.calls[0]?.[1];
            expect(commitPayload?.content).not.toContain("file:///");
        });

        it("dedupes mediaUrls with trailing whitespace", async () => {
            const card = makeCard();
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            // Non-final deliver with URL having trailing whitespace
            await strategy.deliver({
                text: "",
                mediaUrls: ["file:///test/image.png  "],
                kind: "block",
            });

            // Final deliver with same URL without whitespace
            await strategy.deliver({
                text: "",
                mediaUrls: ["file:///test/image.png"],
                kind: "final",
            });

            await strategy.finalize();

            // uploadMedia should be called only once (trim-normalized dedup)
            expect(uploadMediaMock).toHaveBeenCalledTimes(1);
        });
    });
});
