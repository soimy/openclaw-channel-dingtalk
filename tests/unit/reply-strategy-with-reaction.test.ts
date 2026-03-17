import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { withDynamicReaction } from "../../src/reply-strategy-with-reaction";
import type { ReplyStrategy } from "../../src/reply-strategy";

function buildInnerStrategy(overrides: Partial<ReplyStrategy> = {}): ReplyStrategy {
    return {
        getReplyOptions: vi.fn().mockReturnValue({ disableBlockStreaming: true }),
        deliver: vi.fn().mockResolvedValue(undefined),
        finalize: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
        getFinalText: vi.fn().mockReturnValue("final"),
        ...overrides,
    };
}

function buildParams(overrides: Partial<Parameters<typeof withDynamicReaction>[1]> = {}) {
    return {
        config: { clientId: "id", clientSecret: "secret" } as any,
        msgId: "msg_1",
        conversationId: "cid_1",
        initialReaction: "🤔思考中",
        sessionFilter: () => true,
        onAttachReaction: vi.fn().mockResolvedValue(true),
        onRecallReaction: vi.fn().mockResolvedValue(undefined),
        subscribeAgentEvents: vi.fn().mockReturnValue(vi.fn()),
        log: undefined,
        ...overrides,
    };
}

describe("withDynamicReaction", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("delegates getReplyOptions to inner strategy", () => {
        const inner = buildInnerStrategy();
        const params = buildParams();
        const decorated = withDynamicReaction(inner, params);
        const opts = decorated.getReplyOptions();
        expect(opts.disableBlockStreaming).toBe(true);
        expect(inner.getReplyOptions).toHaveBeenCalled();
    });

    it("delegates deliver to inner strategy", async () => {
        const inner = buildInnerStrategy();
        const params = buildParams();
        const decorated = withDynamicReaction(inner, params);
        const payload = { text: "hello", mediaUrls: [], kind: "final" as const };
        await decorated.deliver(payload);
        expect(inner.deliver).toHaveBeenCalledWith(payload);
    });

    it("delegates getFinalText to inner strategy", () => {
        const inner = buildInnerStrategy();
        const params = buildParams();
        const decorated = withDynamicReaction(inner, params);
        expect(decorated.getFinalText()).toBe("final");
    });

    it("subscribes to agent events on creation", () => {
        const inner = buildInnerStrategy();
        const subscribeAgentEvents = vi.fn().mockReturnValue(vi.fn());
        withDynamicReaction(inner, buildParams({ subscribeAgentEvents }));
        expect(subscribeAgentEvents).toHaveBeenCalledTimes(1);
    });

    it("switches reaction on tool_execution_start event", async () => {
        const inner = buildInnerStrategy();
        const onAttachReaction = vi.fn().mockResolvedValue(true);
        const onRecallReaction = vi.fn().mockResolvedValue(undefined);
        let eventListener: (event: unknown) => void = () => {};
        const subscribeAgentEvents = vi.fn((listener: (event: unknown) => void) => {
            eventListener = listener;
            return vi.fn();
        });

        withDynamicReaction(inner, buildParams({
            onAttachReaction,
            onRecallReaction,
            subscribeAgentEvents,
        }));

        eventListener({
            stream: "tool",
            data: { phase: "start", name: "web_search" },
        });

        await vi.advanceTimersByTimeAsync(10);

        expect(onRecallReaction).toHaveBeenCalledWith("🤔思考中");
        expect(onAttachReaction).toHaveBeenCalledWith("🌐");
    });

    it("ignores events that fail sessionFilter", async () => {
        const inner = buildInnerStrategy();
        const onAttachReaction = vi.fn().mockResolvedValue(true);
        let eventListener: (event: unknown) => void = () => {};
        const subscribeAgentEvents = vi.fn((listener: (event: unknown) => void) => {
            eventListener = listener;
            return vi.fn();
        });

        withDynamicReaction(inner, buildParams({
            onAttachReaction,
            subscribeAgentEvents,
            sessionFilter: () => false,
        }));

        eventListener({
            stream: "tool",
            data: { phase: "start", name: "read" },
        });

        await vi.advanceTimersByTimeAsync(10);
        expect(onAttachReaction).not.toHaveBeenCalled();
    });

    it("ignores non-tool events", async () => {
        const inner = buildInnerStrategy();
        const onAttachReaction = vi.fn().mockResolvedValue(true);
        let eventListener: (event: unknown) => void = () => {};
        const subscribeAgentEvents = vi.fn((listener: (event: unknown) => void) => {
            eventListener = listener;
            return vi.fn();
        });

        withDynamicReaction(inner, buildParams({
            onAttachReaction,
            subscribeAgentEvents,
        }));

        eventListener({ stream: "lifecycle", data: { phase: "start" } });
        await vi.advanceTimersByTimeAsync(10);
        expect(onAttachReaction).not.toHaveBeenCalled();
    });

    it("fires heartbeat when no tool event for 55+ seconds", async () => {
        const inner = buildInnerStrategy();
        const onAttachReaction = vi.fn().mockResolvedValue(true);
        const onRecallReaction = vi.fn().mockResolvedValue(undefined);
        let eventListener: (event: unknown) => void = () => {};
        const subscribeAgentEvents = vi.fn((listener: (event: unknown) => void) => {
            eventListener = listener;
            return vi.fn();
        });

        withDynamicReaction(inner, buildParams({
            onAttachReaction,
            onRecallReaction,
            subscribeAgentEvents,
        }));

        // Fire initial tool event to set lastEventAt
        eventListener({ stream: "tool", data: { phase: "start", name: "read" } });
        await vi.advanceTimersByTimeAsync(10);

        // Advance past heartbeat interval
        await vi.advanceTimersByTimeAsync(60_000);

        expect(onAttachReaction).toHaveBeenCalledWith("⏳");
    });

    it("finalize disposes and waits for updateChain before inner.finalize", async () => {
        const inner = buildInnerStrategy();
        const unsubscribe = vi.fn();
        let eventListener: (event: unknown) => void = () => {};
        const subscribeAgentEvents = vi.fn((listener: (event: unknown) => void) => {
            eventListener = listener;
            return unsubscribe;
        });

        let recallResolve: () => void = () => {};
        const onRecallReaction = vi.fn().mockImplementation(
            () => new Promise<void>((resolve) => { recallResolve = resolve; }),
        );
        const onAttachReaction = vi.fn().mockResolvedValue(true);

        const decorated = withDynamicReaction(inner, buildParams({
            onAttachReaction,
            onRecallReaction,
            subscribeAgentEvents,
        }));

        // Fire a tool event that starts an async recall
        eventListener({ stream: "tool", data: { phase: "start", name: "bash" } });

        // Start finalize — should wait for updateChain
        const finalizePromise = decorated.finalize();

        // inner.finalize should NOT have been called yet (updateChain still pending)
        expect(inner.finalize).not.toHaveBeenCalled();
        expect(unsubscribe).toHaveBeenCalledTimes(1);

        // Resolve the recall
        recallResolve();
        await vi.advanceTimersByTimeAsync(10);
        await finalizePromise;

        expect(inner.finalize).toHaveBeenCalledTimes(1);
    });

    it("abort disposes and waits for updateChain before inner.abort", async () => {
        const inner = buildInnerStrategy();
        const unsubscribe = vi.fn();
        const subscribeAgentEvents = vi.fn(() => unsubscribe);

        const decorated = withDynamicReaction(inner, buildParams({ subscribeAgentEvents }));

        const error = new Error("dispatch failed");
        await decorated.abort(error);

        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(inner.abort).toHaveBeenCalledWith(error);
    });

    it("resolves correct emoji for known tool names", async () => {
        // Each tool type tested with a fresh decorator to avoid same-emoji dedup
        const toolNames: Array<[string, string]> = [
            ["read", "📂"],
            ["write", "✍️"],
            ["web_search", "🌐"],
            ["fetch", "🔗"],
            ["bash", "🛠️"],
            ["unknown_tool", "🛠️"],
        ];

        for (const [name, expectedEmoji] of toolNames) {
            const inner = buildInnerStrategy();
            const onAttachReaction = vi.fn().mockResolvedValue(true);
            const onRecallReaction = vi.fn().mockResolvedValue(undefined);
            let eventListener: (event: unknown) => void = () => {};
            const subscribeAgentEvents = vi.fn((listener: (event: unknown) => void) => {
                eventListener = listener;
                return vi.fn();
            });

            withDynamicReaction(inner, buildParams({
                onAttachReaction,
                onRecallReaction,
                subscribeAgentEvents,
                initialReaction: "initial",
            }));

            eventListener({ stream: "tool", data: { phase: "start", name } });
            await vi.advanceTimersByTimeAsync(10);

            expect(onAttachReaction).toHaveBeenCalledWith(expectedEmoji);
        }
    });

    it("dispose recalls current reaction and calls onReactionDisposed when reaction changed", async () => {
        const inner = buildInnerStrategy();
        const onAttachReaction = vi.fn().mockResolvedValue(true);
        const onRecallReaction = vi.fn().mockResolvedValue(undefined);
        const onReactionDisposed = vi.fn();
        let eventListener: (event: unknown) => void = () => {};
        const subscribeAgentEvents = vi.fn((listener: (event: unknown) => void) => {
            eventListener = listener;
            return vi.fn();
        });

        const decorated = withDynamicReaction(inner, buildParams({
            onAttachReaction,
            onRecallReaction,
            subscribeAgentEvents,
            onReactionDisposed,
        }));

        // Switch reaction from initial to 🌐
        eventListener({ stream: "tool", data: { phase: "start", name: "web_search" } });
        await vi.advanceTimersByTimeAsync(10);

        // onRecallReaction called once for the switch (recall initial)
        expect(onRecallReaction).toHaveBeenCalledTimes(1);
        expect(onRecallReaction).toHaveBeenCalledWith("🤔思考中");

        onRecallReaction.mockClear();

        // finalize triggers dispose which recalls current reaction (🌐)
        await decorated.finalize();

        expect(onRecallReaction).toHaveBeenCalledTimes(1);
        expect(onRecallReaction).toHaveBeenCalledWith("🌐");
        expect(onReactionDisposed).toHaveBeenCalledTimes(1);
    });

    it("dispose does not recall or notify when reaction never changed", async () => {
        const inner = buildInnerStrategy();
        const onRecallReaction = vi.fn().mockResolvedValue(undefined);
        const onReactionDisposed = vi.fn();

        const decorated = withDynamicReaction(inner, buildParams({
            onRecallReaction,
            onReactionDisposed,
        }));

        // No tool events fired — reaction never changed
        await decorated.finalize();

        // onRecallReaction should NOT be called during dispose (no change happened)
        expect(onRecallReaction).not.toHaveBeenCalled();
        expect(onReactionDisposed).not.toHaveBeenCalled();
    });

    it("dispose handles onRecallReaction failure gracefully", async () => {
        const inner = buildInnerStrategy();
        const onAttachReaction = vi.fn().mockResolvedValue(true);
        const onRecallReaction = vi.fn()
            .mockResolvedValueOnce(undefined) // first switch recall succeeds
            .mockRejectedValueOnce(new Error("recall api error")); // dispose recall fails
        const onReactionDisposed = vi.fn();
        const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
        let eventListener: (event: unknown) => void = () => {};
        const subscribeAgentEvents = vi.fn((listener: (event: unknown) => void) => {
            eventListener = listener;
            return vi.fn();
        });

        const decorated = withDynamicReaction(inner, buildParams({
            onAttachReaction,
            onRecallReaction,
            subscribeAgentEvents,
            onReactionDisposed,
            log: log as any,
        }));

        // Switch reaction
        eventListener({ stream: "tool", data: { phase: "start", name: "read" } });
        await vi.advanceTimersByTimeAsync(10);

        // finalize — dispose recall will fail but should not throw
        await decorated.finalize();

        expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining("Failed to recall reaction on dispose"),
        );
        // onReactionDisposed should NOT be called when recall fails
        expect(onReactionDisposed).not.toHaveBeenCalled();
        // inner.finalize should still be called
        expect(inner.finalize).toHaveBeenCalledTimes(1);
    });

    it("abort also recalls current reaction via dispose", async () => {
        const inner = buildInnerStrategy();
        const onAttachReaction = vi.fn().mockResolvedValue(true);
        const onRecallReaction = vi.fn().mockResolvedValue(undefined);
        const onReactionDisposed = vi.fn();
        let eventListener: (event: unknown) => void = () => {};
        const subscribeAgentEvents = vi.fn((listener: (event: unknown) => void) => {
            eventListener = listener;
            return vi.fn();
        });

        const decorated = withDynamicReaction(inner, buildParams({
            onAttachReaction,
            onRecallReaction,
            subscribeAgentEvents,
            onReactionDisposed,
        }));

        // Switch reaction
        eventListener({ stream: "tool", data: { phase: "start", name: "write" } });
        await vi.advanceTimersByTimeAsync(10);

        onRecallReaction.mockClear();

        await decorated.abort(new Error("crash"));

        // dispose recalls current reaction (✍️)
        expect(onRecallReaction).toHaveBeenCalledWith("✍️");
        expect(onReactionDisposed).toHaveBeenCalledTimes(1);
        expect(inner.abort).toHaveBeenCalledTimes(1);
    });
});
