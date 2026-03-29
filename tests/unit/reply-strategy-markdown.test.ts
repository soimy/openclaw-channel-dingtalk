import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMarkdownReplyStrategy } from "../../src/reply-strategy-markdown";
import * as sendService from "../../src/send-service";
import type { ReplyStrategyContext } from "../../src/reply-strategy";

vi.mock("../../src/send-service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/send-service")>();
    return {
        ...actual,
        sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    };
});

const sendMessageMock = vi.mocked(sendService.sendMessage);

function buildCtx(overrides: Partial<ReplyStrategyContext> = {}): ReplyStrategyContext {
    return {
        config: { clientId: "id", clientSecret: "secret", messageType: "markdown" } as any,
        to: "user_1",
        sessionWebhook: "https://session.webhook",
        senderId: "sender_1",
        isDirect: true,
        accountId: "main",
        storePath: "/tmp/store.json",
        log: undefined,
        deliverMedia: vi.fn(),
        ...overrides,
    };
}

function sentTexts(): string[] {
    return sendMessageMock.mock.calls.map((call) => String(call[2] ?? ""));
}

describe("reply-strategy-markdown", () => {
    beforeEach(() => {
        sendMessageMock.mockReset().mockResolvedValue({ ok: true });
    });

    it("getReplyOptions enables incremental callbacks for markdown streaming", () => {
        const strategy = createMarkdownReplyStrategy(buildCtx());
        const opts = strategy.getReplyOptions();

        expect(opts.disableBlockStreaming).toBe(false);
        expect(opts.onPartialReply).toBeDefined();
        expect(opts.onReasoningStream).toBeDefined();
        expect(opts.onAssistantMessageStart).toBeDefined();
    });

    it("onReasoningStream sends only the incremental thinking suffix as quoted blocks", async () => {
        const strategy = createMarkdownReplyStrategy(buildCtx());
        const opts = strategy.getReplyOptions();

        await opts.onReasoningStream?.({ text: "先检查当前分支" });
        await opts.onReasoningStream?.({ text: "先检查当前分支的改动范围" });

        expect(sentTexts()).toEqual([
            "> 先检查当前分支",
            "> 的改动范围",
        ]);
    });

    it("onReasoningStream ignores blank input and non-prefix rewrites", async () => {
        const strategy = createMarkdownReplyStrategy(buildCtx());
        const opts = strategy.getReplyOptions();

        await opts.onReasoningStream?.({ text: "先检查当前分支" });
        await opts.onReasoningStream?.({ text: "重新换个方向检查" });
        await opts.onReasoningStream?.({ text: "   " });

        expect(sentTexts()).toEqual(["> 先检查当前分支"]);
    });

    it("deliver(tool) sends one quoted message per tool event", async () => {
        const strategy = createMarkdownReplyStrategy(buildCtx());

        await strategy.deliver({ text: "git diff --stat", mediaUrls: [], kind: "tool" });
        await strategy.deliver({ text: "printf ok", mediaUrls: [], kind: "tool" });

        expect(sentTexts()).toEqual([
            "> git diff --stat",
            "> printf ok",
        ]);
    });

    it("onPartialReply sends only the incremental answer suffix", async () => {
        const strategy = createMarkdownReplyStrategy(buildCtx());
        const opts = strategy.getReplyOptions();

        await opts.onPartialReply?.({ text: "结论：" });
        await opts.onPartialReply?.({ text: "结论：主要改动集中在 markdown strategy" });

        expect(sentTexts()).toEqual([
            "结论：",
            "主要改动集中在 markdown strategy",
        ]);
    });

    it("deliver(final) only sends the unsent answer tail", async () => {
        const strategy = createMarkdownReplyStrategy(buildCtx());
        const opts = strategy.getReplyOptions();

        await opts.onPartialReply?.({ text: "结论：" });
        await opts.onPartialReply?.({ text: "结论：主要改动在 reply strategy" });
        await strategy.deliver({
            text: "结论：主要改动在 reply strategy 和测试",
            mediaUrls: [],
            kind: "final",
        });

        expect(sentTexts()).toEqual([
            "结论：",
            "主要改动在 reply strategy",
            "和测试",
        ]);
    });

    it("deliver(final) does not resend content already emitted by partial reply", async () => {
        const strategy = createMarkdownReplyStrategy(buildCtx());
        const opts = strategy.getReplyOptions();

        await opts.onPartialReply?.({ text: "最终结论" });
        await strategy.deliver({ text: "最终结论", mediaUrls: [], kind: "final" });

        expect(sentTexts()).toEqual(["最终结论"]);
    });

    it("onAssistantMessageStart resets the answer cursor for the next turn", async () => {
        const strategy = createMarkdownReplyStrategy(buildCtx());
        const opts = strategy.getReplyOptions();

        await opts.onPartialReply?.({ text: "第一轮结论" });
        await opts.onAssistantMessageStart?.();
        await opts.onPartialReply?.({ text: "第二轮总结" });
        await strategy.deliver({ text: "第二轮总结和补充", mediaUrls: [], kind: "final" });

        expect(sentTexts()).toEqual([
            "第一轮结论",
            "第二轮总结",
            "和补充",
        ]);
    });

    it("deliver(final) with media sends media before the final text tail", async () => {
        const events: string[] = [];
        const deliverMedia = vi.fn(async (urls: string[]) => {
            events.push(`media:${urls.join(",")}`);
        });
        sendMessageMock.mockImplementation(async (_config, _to, text) => {
            events.push(`text:${String(text ?? "")}`);
            return { ok: true };
        });

        const strategy = createMarkdownReplyStrategy(buildCtx({ deliverMedia }));
        const opts = strategy.getReplyOptions();

        await opts.onPartialReply?.({ text: "结论：" });
        await strategy.deliver({
            text: "结论：见附件说明",
            mediaUrls: ["/tmp/report.pdf"],
            kind: "final",
        });

        expect(events).toEqual([
            "text:结论：",
            "media:/tmp/report.pdf",
            "text:见附件说明",
        ]);
    });

    it("deliver(final) throws when sendMessage returns not ok", async () => {
        sendMessageMock.mockResolvedValueOnce({ ok: false, error: "send failed" });
        const strategy = createMarkdownReplyStrategy(buildCtx());

        await expect(
            strategy.deliver({ text: "hello", mediaUrls: [], kind: "final" }),
        ).rejects.toThrow("send failed");
    });

    it("deliver(block) is silently ignored when it has no media", async () => {
        const strategy = createMarkdownReplyStrategy(buildCtx());

        await strategy.deliver({ text: "block content", mediaUrls: [], kind: "block" });

        expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it("deliver with mediaUrls calls deliverMedia regardless of kind", async () => {
        const deliverMedia = vi.fn();
        const strategy = createMarkdownReplyStrategy(buildCtx({ deliverMedia }));

        await strategy.deliver({ text: undefined, mediaUrls: ["/tmp/img.png"], kind: "block" });

        expect(deliverMedia).toHaveBeenCalledWith(["/tmp/img.png"]);
        expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it("finalize and abort are no-ops", async () => {
        const strategy = createMarkdownReplyStrategy(buildCtx());

        await strategy.finalize();
        await strategy.abort(new Error("test"));
    });

    it("getFinalText returns the latest complete answer", async () => {
        const strategy = createMarkdownReplyStrategy(buildCtx());
        const opts = strategy.getReplyOptions();

        expect(strategy.getFinalText()).toBeUndefined();
        await opts.onPartialReply?.({ text: "阶段性总结" });
        expect(strategy.getFinalText()).toBe("阶段性总结");

        await strategy.deliver({ text: "最终总结", mediaUrls: [], kind: "final" });
        expect(strategy.getFinalText()).toBe("最终总结");
    });

    it("passes atUserId for group (isDirect=false)", async () => {
        const strategy = createMarkdownReplyStrategy(buildCtx({ isDirect: false }));

        await strategy.deliver({ text: "group reply", mediaUrls: [], kind: "final" });

        expect(sendMessageMock.mock.calls[0][3]).toMatchObject({
            atUserId: "sender_1",
        });
    });

    it("does not pass atUserId for direct message", async () => {
        const strategy = createMarkdownReplyStrategy(buildCtx({ isDirect: true }));

        await strategy.deliver({ text: "dm reply", mediaUrls: [], kind: "final" });

        expect(sendMessageMock.mock.calls[0][3]?.atUserId).toBeNull();
    });
});
