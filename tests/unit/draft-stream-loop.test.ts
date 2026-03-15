import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createDraftStreamLoop } from "../../src/draft-stream-loop";

describe("draft-stream-loop", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("sends immediately when throttle window has elapsed", async () => {
        const sent: string[] = [];
        const loop = createDraftStreamLoop({
            throttleMs: 300,
            isStopped: () => false,
            sendOrEditStreamMessage: async (text) => {
                sent.push(text);
            },
        });

        loop.update("hello");
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(["hello"]);
    });

    it("throttles within the throttle window", async () => {
        const sent: string[] = [];
        const loop = createDraftStreamLoop({
            throttleMs: 300,
            isStopped: () => false,
            sendOrEditStreamMessage: async (text) => {
                sent.push(text);
            },
        });

        loop.update("first");
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(["first"]);

        loop.update("second");
        await vi.advanceTimersByTimeAsync(100);
        expect(sent).toEqual(["first"]);

        await vi.advanceTimersByTimeAsync(200);
        expect(sent).toEqual(["first", "second"]);
    });

    it("latest-wins: only the last pending text is sent after in-flight completes", async () => {
        const sent: string[] = [];
        let resolveInFlight!: () => void;
        const loop = createDraftStreamLoop({
            throttleMs: 300,
            isStopped: () => false,
            sendOrEditStreamMessage: async (text) => {
                sent.push(text);
                if (text === "first") {
                    await new Promise<void>((r) => { resolveInFlight = r; });
                }
            },
        });

        loop.update("first");
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(["first"]);

        loop.update("second");
        loop.update("third");
        loop.update("latest");

        resolveInFlight();
        await vi.advanceTimersByTimeAsync(300);
        expect(sent).toEqual(["first", "latest"]);
    });

    it("single-flight: no concurrent sends", async () => {
        let concurrent = 0;
        let maxConcurrent = 0;
        const resolvers: (() => void)[] = [];
        const loop = createDraftStreamLoop({
            throttleMs: 0,
            isStopped: () => false,
            sendOrEditStreamMessage: async () => {
                concurrent++;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                await new Promise<void>((r) => { resolvers.push(r); });
                concurrent--;
            },
        });

        loop.update("a");
        await vi.advanceTimersByTimeAsync(0);
        expect(concurrent).toBe(1);

        loop.update("b");
        loop.update("c");

        resolvers[0]!();
        await vi.advanceTimersByTimeAsync(0);
        expect(concurrent).toBe(1);

        resolvers[1]!();
        await vi.advanceTimersByTimeAsync(0);

        expect(maxConcurrent).toBe(1);
    });

    it("flush drains pending and waits for in-flight", async () => {
        const sent: string[] = [];
        let resolveInFlight!: () => void;
        const loop = createDraftStreamLoop({
            throttleMs: 300,
            isStopped: () => false,
            sendOrEditStreamMessage: async (text) => {
                sent.push(text);
                if (text === "first") {
                    await new Promise<void>((r) => { resolveInFlight = r; });
                }
            },
        });

        loop.update("first");
        await vi.advanceTimersByTimeAsync(0);

        loop.update("pending");

        const flushPromise = loop.flush();
        resolveInFlight();
        await flushPromise;

        expect(sent).toEqual(["first", "pending"]);
    });

    it("stop clears pending text and timer", async () => {
        const sent: string[] = [];
        let resolveInFlight!: () => void;
        const loop = createDraftStreamLoop({
            throttleMs: 300,
            isStopped: () => false,
            sendOrEditStreamMessage: async (text) => {
                sent.push(text);
                if (text === "first") {
                    await new Promise<void>((r) => { resolveInFlight = r; });
                }
            },
        });

        loop.update("first");
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(["first"]);

        loop.update("pending-will-be-cleared");
        loop.stop();

        resolveInFlight();
        await vi.advanceTimersByTimeAsync(300);
        expect(sent).toEqual(["first"]);
    });

    it("isStopped prevents further sends", async () => {
        const sent: string[] = [];
        let stopped = false;
        const loop = createDraftStreamLoop({
            throttleMs: 300,
            isStopped: () => stopped,
            sendOrEditStreamMessage: async (text) => {
                sent.push(text);
            },
        });

        loop.update("before");
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(["before"]);

        stopped = true;
        loop.update("after");
        await vi.advanceTimersByTimeAsync(300);
        expect(sent).toEqual(["before"]);
    });

    it("sendOrEditStreamMessage returning false preserves pendingText", async () => {
        const sent: string[] = [];
        let rejectOnce = true;
        const loop = createDraftStreamLoop({
            throttleMs: 0,
            isStopped: () => false,
            sendOrEditStreamMessage: async (text) => {
                sent.push(text);
                if (rejectOnce) {
                    rejectOnce = false;
                    return false;
                }
            },
        });

        loop.update("try");
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(["try"]);

        await loop.flush();
        expect(sent).toEqual(["try", "try"]);
    });

    it("waitForInFlight waits for current in-flight to complete", async () => {
        let resolveInFlight!: () => void;
        let inFlightDone = false;
        const loop = createDraftStreamLoop({
            throttleMs: 0,
            isStopped: () => false,
            sendOrEditStreamMessage: async () => {
                await new Promise<void>((r) => { resolveInFlight = r; });
                inFlightDone = true;
            },
        });

        loop.update("test");
        await vi.advanceTimersByTimeAsync(0);
        expect(inFlightDone).toBe(false);

        const waitPromise = loop.waitForInFlight();
        resolveInFlight();
        await waitPromise;
        expect(inFlightDone).toBe(true);
    });

    it("resetPending clears pending without affecting in-flight", async () => {
        const sent: string[] = [];
        let resolveInFlight!: () => void;
        const loop = createDraftStreamLoop({
            throttleMs: 300,
            isStopped: () => false,
            sendOrEditStreamMessage: async (text) => {
                sent.push(text);
                if (text === "first") {
                    await new Promise<void>((r) => { resolveInFlight = r; });
                }
            },
        });

        loop.update("first");
        await vi.advanceTimersByTimeAsync(0);

        loop.update("will-be-cleared");
        loop.resetPending();

        resolveInFlight();
        await vi.advanceTimersByTimeAsync(300);

        expect(sent).toEqual(["first"]);
    });
});
