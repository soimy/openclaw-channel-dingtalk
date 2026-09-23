import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSessionState } from "../../src/platform/session-state";
// Import the fixture first: its vi.mock registrations must be in place before
// the module under test is evaluated.
import {
    commitAICardBlocksMock,
    updateAICardStatusLineMock,
    makeCard,
    buildCtx,
    beforeEachReplyStrategyCard,
    afterEachReplyStrategyCard,
} from "./fixtures/reply-strategy-card";
import { createCardReplyStrategy } from "../../src/messaging/reply-strategy-card";

describe("reply-strategy-card status line", () => {
    beforeEach(beforeEachReplyStrategyCard);
    afterEach(afterEachReplyStrategyCard);

    describe("statusLine from taskMeta", () => {
        it("passes statusLine to commitAICardBlocks on finalize", async () => {
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
            expect(options.statusLine).toBeDefined();
            expect(typeof options.statusLine).toBe("string");
            expect(options.statusLine).toContain("gpt-5.4");
            expect(options.statusLine).toContain("medium");
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
            // statusLine should contain the elapsed time
            expect(options.statusLine).toBeDefined();
        });

        it("keeps taskTime isolated to the card even if the session timer resets later", async () => {
            const sessionTaskStateScope = {
                accountId: "main",
                conversationId: "cid_1",
                agentId: "main",
            };
            initSessionState(sessionTaskStateScope);
            await vi.advanceTimersByTimeAsync(4000);

            const card = makeCard({
                accountId: "main",
                conversationId: "cid_1",
                contextConversationId: "cid_1",
                createdAt: Date.now() - 4000,
            });
            const strategy = createCardReplyStrategy(buildCtx(card, {
                taskMeta: {
                    model: "gpt-5.4",
                },
            }));

            initSessionState(sessionTaskStateScope);

            await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: [] });
            await strategy.finalize();

            const options = commitAICardBlocksMock.mock.calls[0][1];
            expect(options.statusLine).toBeDefined();
        });

        it("includes statusLine in commitAICardBlocks on finalize", async () => {
            const card = makeCard();
            const ctx = buildCtx(card, {
                taskMeta: { model: "claude-sonnet-4-20250514", effort: "high", agent: "TestBot" },
            });
            const strategy = createCardReplyStrategy(ctx);
            await strategy.deliver({ text: "Hello", mediaUrls: [], kind: "final" });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalled();
            const statusLine = commitAICardBlocksMock.mock.calls[0][1].statusLine;
            expect(statusLine).toBe("claude-sonnet-4-20250514 | high | TestBot");
        });

        it("omits statusLine when taskMeta is not provided", async () => {
            const card = makeCard();
            const ctx = buildCtx(card);
            const strategy = createCardReplyStrategy(ctx);

            await strategy.deliver({ kind: "final", text: "回复", mediaUrls: [] });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const options = commitAICardBlocksMock.mock.calls[0][1];
            expect(options.statusLine).toBeUndefined();
        });

        it("updates statusLine early when onModelSelected fires", async () => {
            const card = makeCard({
                accountId: "main",
                conversationId: "cid_1",
                contextConversationId: "cid_1",
                createdAt: Date.now() - 3000,
                dapiUsage: 1,
            });
            const ctx = buildCtx(card, {
                taskMeta: {
                    usage: 2,
                    agent: "代码专家",
                },
            });
            const strategy = createCardReplyStrategy(ctx);
            const opts = strategy.getReplyOptions();

            opts.onModelSelected?.({ model: "gpt-5.4", thinkLevel: "medium" } as any);

            expect(updateAICardStatusLineMock).toHaveBeenCalledTimes(1);
            const statusLine = updateAICardStatusLineMock.mock.calls[0]?.[1];
            expect(statusLine).toBeDefined();
            expect(statusLine).toContain("gpt-5.4");
            expect(statusLine).toContain("medium");
            expect(statusLine).toContain("代码专家");
        });

        it("updates the current card when sessionAgentId is unavailable", () => {
            const card = makeCard({
                accountId: "main",
                conversationId: "cid_1",
                contextConversationId: "cid_1",
            });
            const ctx = buildCtx(card, {
                sessionAgentId: undefined,
                taskMeta: { agent: "代码专家" },
            });
            const strategy = createCardReplyStrategy(ctx);

            strategy.getReplyOptions().onModelSelected?.({
                model: "gpt-5.4",
                thinkLevel: "medium",
            } as any);

            expect(updateAICardStatusLineMock).toHaveBeenCalledTimes(1);
            expect(updateAICardStatusLineMock.mock.calls[0]?.[1]).toContain("gpt-5.4");
        });

        it("includes partial statusLine in early onModelSelected update", async () => {
            const card = makeCard({
                accountId: "main",
                conversationId: "cid_1",
                contextConversationId: "cid_1",
                createdAt: Date.now() - 3000,
            });
            const ctx = buildCtx(card, {
                taskMeta: { model: "old-model", effort: "low", agent: "TestBot" },
            });
            const strategy = createCardReplyStrategy(ctx);
            const opts = strategy.getReplyOptions();

            // Trigger onModelSelected — this calls buildStatusLine() + updateAICardStatusLine()
            opts.onModelSelected?.({ model: "claude-sonnet-4-20250514", thinkLevel: "high" } as any);

            expect(updateAICardStatusLineMock).toHaveBeenCalled();
            const statusLine = updateAICardStatusLineMock.mock.calls[0][1];
            expect(statusLine).toBe("claude-sonnet-4-20250514 | high | TestBot");
        });

        it("uses the latest card dapiUsage at finalize after early statusLine refresh", async () => {
            const card = makeCard({
                accountId: "main",
                conversationId: "cid_1",
                contextConversationId: "cid_1",
                createdAt: Date.now() - 3000,
                dapiUsage: 2,
            });
            const ctx = buildCtx(card, {
                taskMeta: {
                    agent: "代码专家",
                },
            });
            const strategy = createCardReplyStrategy(ctx);
            const opts = strategy.getReplyOptions();

            opts.onModelSelected?.({ model: "gpt-5.4", thinkLevel: "medium" } as any);
            card.dapiUsage = 5;

            await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: [] });
            await strategy.finalize();

            expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
            const options = commitAICardBlocksMock.mock.calls[0][1];
            // statusLine should contain DAPI+5
            expect(options.statusLine).toBeDefined();
            expect(options.statusLine).toContain("5");
        });

        it("includes agent in statusLine when taskMeta.agent is set", async () => {
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
            expect(options.statusLine).toBeDefined();
            expect(options.statusLine).toContain("gpt-5.4");
            expect(options.statusLine).toContain("代码专家");
        });
    });
});
