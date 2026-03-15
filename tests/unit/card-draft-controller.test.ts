import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createCardDraftController } from "../../src/card-draft-controller";
import * as cardService from "../../src/card-service";
import { AICardStatus } from "../../src/types";
import type { AICardInstance } from "../../src/types";

vi.mock("../../src/card-service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/card-service")>();
    return {
        ...actual,
        streamAICard: vi.fn(),
    };
});

function makeCard(overrides: Partial<AICardInstance> = {}): AICardInstance {
    return {
        cardInstanceId: "card-1",
        accessToken: "token",
        conversationId: "conv-1",
        state: AICardStatus.PROCESSING,
        lastStreamedContent: "",
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        ...overrides,
    } as AICardInstance;
}

describe("card-draft-controller", () => {
    const streamAICardMock = vi.mocked(cardService.streamAICard);

    beforeEach(() => {
        vi.useFakeTimers();
        streamAICardMock.mockReset();
        streamAICardMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("updateAnswer sends answer text via streamAICard", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("Hello world");
        await vi.advanceTimersByTimeAsync(0);

        expect(streamAICardMock).toHaveBeenCalledWith(card, "Hello world", false, undefined);
    });

    it("updateReasoning sends formatted thinking text", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateReasoning("Analyzing...");
        await vi.advanceTimersByTimeAsync(0);

        const sentContent = streamAICardMock.mock.calls[0]?.[1] as string;
        expect(sentContent).toContain("🤔");
        expect(sentContent).toContain("思考中");
        expect(sentContent).toContain("Analyzing...");
    });

    it("phase flows idle -> reasoning -> answer (one-way)", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateReasoning("think");
        await vi.advanceTimersByTimeAsync(0);
        expect(streamAICardMock).toHaveBeenCalledTimes(1);

        const reasoningContent = streamAICardMock.mock.calls[0]?.[1] as string;
        expect(reasoningContent).toContain("think");

        streamAICardMock.mockClear();

        ctrl.updateAnswer("answer");
        await vi.advanceTimersByTimeAsync(0);
        expect(streamAICardMock).toHaveBeenCalledTimes(1);
        expect(streamAICardMock.mock.calls[0]?.[1]).toBe("answer");
    });

    it("reasoning is ignored once in answer phase", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("answer");
        await vi.advanceTimersByTimeAsync(0);
        streamAICardMock.mockClear();

        ctrl.updateReasoning("late-reasoning");
        await vi.advanceTimersByTimeAsync(300);
        expect(streamAICardMock).not.toHaveBeenCalled();
    });

    it("reasoning -> answer switch resets pending so reasoning does not leak", async () => {
        const sent: string[] = [];
        let resolveInFlight!: () => void;
        streamAICardMock.mockImplementation(async (_card, content) => {
            sent.push(content);
            if (sent.length === 1) {
                await new Promise<void>((r) => { resolveInFlight = r; });
            }
        });

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 300 });

        ctrl.updateReasoning("thinking...");
        await vi.advanceTimersByTimeAsync(0);
        expect(sent.length).toBe(1);
        expect(sent[0]).toContain("thinking...");

        ctrl.updateReasoning("still thinking...");
        ctrl.updateAnswer("Hello");

        resolveInFlight();
        await vi.advanceTimersByTimeAsync(300);

        const lastSent = sent[sent.length - 1];
        expect(lastSent).toBe("Hello");
        expect(lastSent).not.toContain("thinking");
    });

    it("isFailed becomes true when streamAICard throws", async () => {
        streamAICardMock.mockRejectedValueOnce(new Error("API down"));

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        expect(ctrl.isFailed()).toBe(false);

        ctrl.updateAnswer("test");
        await vi.advanceTimersByTimeAsync(0);

        expect(ctrl.isFailed()).toBe(true);
    });

    it("updates are ignored after isFailed", async () => {
        streamAICardMock.mockRejectedValueOnce(new Error("fail"));

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("first");
        await vi.advanceTimersByTimeAsync(0);
        expect(ctrl.isFailed()).toBe(true);

        streamAICardMock.mockClear();
        ctrl.updateAnswer("second");
        await vi.advanceTimersByTimeAsync(300);
        expect(streamAICardMock).not.toHaveBeenCalled();
    });

    it("updates are ignored after stop", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("before");
        await vi.advanceTimersByTimeAsync(0);
        expect(streamAICardMock).toHaveBeenCalledTimes(1);

        ctrl.stop();
        streamAICardMock.mockClear();

        ctrl.updateAnswer("after");
        await vi.advanceTimersByTimeAsync(300);
        expect(streamAICardMock).not.toHaveBeenCalled();
    });

    it("flush drains all pending and waits for in-flight", async () => {
        const sent: string[] = [];
        let resolveInFlight!: () => void;
        streamAICardMock.mockImplementation(async (_card, content) => {
            sent.push(content);
            if (sent.length === 1) {
                await new Promise<void>((r) => { resolveInFlight = r; });
            }
        });

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 300 });

        ctrl.updateAnswer("first");
        await vi.advanceTimersByTimeAsync(0);

        ctrl.updateAnswer("second");

        const flushDone = ctrl.flush();
        resolveInFlight();
        await flushDone;

        expect(sent).toEqual(["first", "second"]);
    });

    it("getLastContent returns last successfully sent content", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        expect(ctrl.getLastContent()).toBe("");

        ctrl.updateAnswer("content-1");
        await vi.advanceTimersByTimeAsync(0);
        expect(ctrl.getLastContent()).toBe("content-1");

        ctrl.updateAnswer("content-2");
        await vi.advanceTimersByTimeAsync(0);
        expect(ctrl.getLastContent()).toBe("content-2");
    });

    it("getLastContent does not update on failed send", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("good");
        await vi.advanceTimersByTimeAsync(0);
        expect(ctrl.getLastContent()).toBe("good");

        streamAICardMock.mockRejectedValueOnce(new Error("fail"));
        ctrl.updateAnswer("bad");
        await vi.advanceTimersByTimeAsync(0);

        expect(ctrl.getLastContent()).toBe("good");
    });

    it("waitForInFlight resolves after current in-flight completes", async () => {
        let resolveInFlight!: () => void;
        let inFlightDone = false;
        streamAICardMock.mockImplementation(async () => {
            await new Promise<void>((r) => { resolveInFlight = r; });
            inFlightDone = true;
        });

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("test");
        await vi.advanceTimersByTimeAsync(0);
        expect(inFlightDone).toBe(false);

        const waitDone = ctrl.waitForInFlight();
        resolveInFlight();
        await waitDone;
        expect(inFlightDone).toBe(true);
    });

    it("answerPrefix: dramatic length drop (>50%) prepends previous content", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("long answer text here");
        await vi.advanceTimersByTimeAsync(0);
        streamAICardMock.mockClear();

        ctrl.updateAnswer("Hi");
        await vi.advanceTimersByTimeAsync(0);

        expect(streamAICardMock).toHaveBeenCalledWith(
            card,
            "long answer text here\n\nHi",
            false,
            undefined,
        );
    });

    it("answerPrefix: minor length drop (<50%) does NOT trigger prefix", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("abcdefghij");
        await vi.advanceTimersByTimeAsync(0);
        streamAICardMock.mockClear();

        ctrl.updateAnswer("abcdefg");
        await vi.advanceTimersByTimeAsync(0);

        expect(streamAICardMock).toHaveBeenCalledWith(
            card,
            "abcdefg",
            false,
            undefined,
        );
    });

    it("answerPrefix: exactly 50% length does NOT trigger prefix", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("abcdefghij");
        await vi.advanceTimersByTimeAsync(0);
        streamAICardMock.mockClear();

        ctrl.updateAnswer("abcde");
        await vi.advanceTimersByTimeAsync(0);

        expect(streamAICardMock).toHaveBeenCalledWith(
            card,
            "abcde",
            false,
            undefined,
        );
    });
});
