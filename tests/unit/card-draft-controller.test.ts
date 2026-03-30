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

    it("updateReasoning sends a rendered thinking block", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateReasoning("Analyzing...");
        await vi.advanceTimersByTimeAsync(0);

        const sentContent = streamAICardMock.mock.calls[0]?.[1] as string;
        expect(sentContent).toContain("> Analyzing...");
    });

    it("answer rendering keeps the latest thinking block in the same timeline", async () => {
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
        const rendered = streamAICardMock.mock.calls[0]?.[1] as string;
        expect(rendered).toContain("> think");
        expect(rendered).toContain("answer");
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

    it("reasoning -> answer switch seals only the latest thinking snapshot into the timeline", async () => {
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
        expect(lastSent).toContain("> still thinking...");
        expect(lastSent).not.toContain("> thinking...");
        expect(lastSent).toContain("Hello");
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

    it("notifyNewAssistantTurn: next updateAnswer prepends previous answer content", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("Turn 1 content");
        await vi.advanceTimersByTimeAsync(0);
        streamAICardMock.mockClear();

        ctrl.notifyNewAssistantTurn();
        ctrl.updateAnswer("Turn 2");
        await vi.advanceTimersByTimeAsync(0);

        expect(streamAICardMock).toHaveBeenCalledWith(
            card,
            "Turn 1 content\nTurn 2",
            false,
            undefined,
        );
    });

    it("notifyNewAssistantTurn: without prior answer content does not prepend", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateReasoning("thinking...");
        await vi.advanceTimersByTimeAsync(0);
        streamAICardMock.mockClear();

        ctrl.notifyNewAssistantTurn();
        ctrl.updateAnswer("first answer");
        await vi.advanceTimersByTimeAsync(0);

        expect(streamAICardMock).toHaveBeenCalledWith(
            card,
            "first answer",
            false,
            undefined,
        );
    });

    it("notifyNewAssistantTurn: resets phase to idle, allowing reasoning again", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateAnswer("answer");
        await vi.advanceTimersByTimeAsync(0);
        streamAICardMock.mockClear();

        ctrl.notifyNewAssistantTurn();
        ctrl.updateReasoning("new thinking");
        await vi.advanceTimersByTimeAsync(0);

        const sentContent = streamAICardMock.mock.calls[0]?.[1] as string;
        expect(sentContent).toContain("> new thinking");
    });

    it("getLastAnswerContent only tracks answer phase sends", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 });

        ctrl.updateReasoning("thinking");
        await vi.advanceTimersByTimeAsync(0);
        expect(ctrl.getLastAnswerContent()).toBe("");
        expect(ctrl.getLastContent()).toContain("> thinking");

        ctrl.updateAnswer("answer text");
        await vi.advanceTimersByTimeAsync(0);
        expect(ctrl.getLastAnswerContent()).toBe("answer text");
    });

    it("renders thinking and tool blocks as plain blockquotes while leaving answer plain", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        ctrl.updateReasoning("先检查改动");
        await vi.advanceTimersByTimeAsync(0);

        expect(typeof ctrl.getRenderedContent).toBe("function");
        expect(typeof ctrl.updateTool).toBe("function");

        await ctrl.updateTool("git diff --stat");
        await vi.advanceTimersByTimeAsync(0);

        ctrl.updateAnswer("这里是最终回复");
        await vi.advanceTimersByTimeAsync(0);

        const rendered = ctrl.getRenderedContent?.() ?? "";
        expect(rendered).toContain("> 先检查改动");
        expect(rendered).toContain("> git diff --stat");
        expect(rendered).toContain("这里是最终回复");
        expect(rendered).not.toContain("> 这里是最终回复");
    });

    it("replaces the live thinking block instead of appending multiple reasoning snapshots", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        expect(typeof ctrl.getRenderedContent).toBe("function");

        ctrl.updateReasoning("第一版思考");
        await vi.advanceTimersByTimeAsync(0);

        ctrl.updateReasoning("第二版思考");
        await vi.advanceTimersByTimeAsync(0);

        const rendered = ctrl.getRenderedContent?.() ?? "";
        expect(rendered).toContain("第二版思考");
        expect(rendered).not.toContain("第一版思考");
    });

    it("appends completed thinking blocks without live replacement semantics", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        expect(typeof ctrl.appendThinkingBlock).toBe("function");

        await ctrl.appendThinkingBlock("Reason: 先检查当前目录");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.appendThinkingBlock("Reason: 再确认 reply strategy 入口");
        await vi.advanceTimersByTimeAsync(0);

        const rendered = ctrl.getRenderedContent?.() ?? "";
        expect(rendered).toContain("> Reason: 先检查当前目录");
        expect(rendered).toContain("> Reason: 再确认 reply strategy 入口");
    });

    it("notifyNewAssistantTurn keeps earlier answer text and appends the next answer turn", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        expect(typeof ctrl.getRenderedContent).toBe("function");

        ctrl.updateAnswer("Turn 1 content");
        await vi.advanceTimersByTimeAsync(0);

        ctrl.notifyNewAssistantTurn();
        ctrl.updateAnswer("Turn 2 short summary");
        await vi.advanceTimersByTimeAsync(0);

        const rendered = ctrl.getRenderedContent?.() ?? "";
        expect(rendered).toContain("Turn 1 content");
        expect(rendered).toContain("Turn 2 short summary");
    });

    it("getFinalAnswerContent returns answer-only text without process block prefixes", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        ctrl.updateReasoning("我先看看");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateTool("git status");
        await vi.advanceTimersByTimeAsync(0);
        ctrl.updateAnswer("最终答案");
        await vi.advanceTimersByTimeAsync(0);

        expect(typeof ctrl.getFinalAnswerContent).toBe("function");
        const answerOnly = ctrl.getFinalAnswerContent?.() ?? "";
        expect(answerOnly).toBe("最终答案");
        expect(answerOnly).not.toContain("思考");
        expect(answerOnly).not.toContain("工具");
    });

    it("keeps html-sensitive tool text inside quoted markdown lines", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateTool("<div>hello</div>");
        await vi.advanceTimersByTimeAsync(0);

        const rendered = ctrl.getRenderedContent?.() ?? "";
        expect(rendered).toContain("> <div>hello</div>");
    });

    it("uses a tighter separator between process blocks and answer text", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateTool("Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateAnswer("当前工作目录是 /Users/sym/clawd");
        await vi.advanceTimersByTimeAsync(0);

        const rendered = ctrl.getRenderedContent?.() ?? "";
        const streamed = streamAICardMock.mock.calls.at(-1)?.[1] as string;
        expect(streamed).toContain("> Exec: pwd\n当前工作目录是 /Users/sym/clawd");
        expect(streamed).not.toContain("> Exec: pwd\n\n当前工作目录是 /Users/sym/clawd");
        expect(rendered).toContain("> Exec: pwd\n\n当前工作目录是 /Users/sym/clawd");
    });

    it("uses tight separators across thinking, tool, and answer while streaming", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateReasoning("Reason: 先检查当前目录");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateTool("Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateAnswer("当前工作目录是 /Users/sym/clawd");
        await vi.advanceTimersByTimeAsync(0);

        const streamed = streamAICardMock.mock.calls.at(-1)?.[1] as string;
        expect(streamed).toContain(
            "> Reason: 先检查当前目录\n> Exec: pwd\n当前工作目录是 /Users/sym/clawd",
        );
        expect(streamed).not.toContain(
            "> Reason: 先检查当前目录\n\n> Exec: pwd",
        );
        expect(streamed).not.toContain(
            "> Exec: pwd\n\n当前工作目录是 /Users/sym/clawd",
        );
    });

    it("uses tight separators between adjacent tool blocks while streaming", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateTool("Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateTool("Exec: printf ok");
        await vi.advanceTimersByTimeAsync(0);

        const streamed = streamAICardMock.mock.calls.at(-1)?.[1] as string;
        expect(streamed).toContain("> Exec: pwd\n> Exec: printf ok");
        expect(streamed).not.toContain("> Exec: pwd\n\n> Exec: printf ok");
    });

    it("final rendered timeline keeps a blank line between process blocks and answer text", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        await ctrl.updateTool("Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);
        await ctrl.updateAnswer("当前工作目录是 /Users/sym/clawd");
        await vi.advanceTimersByTimeAsync(0);

        const finalRendered = ctrl.getRenderedContent?.() ?? "";
        expect(finalRendered).toContain("> Exec: pwd\n\n当前工作目录是 /Users/sym/clawd");
        expect(finalRendered).not.toContain("> Exec: pwd\n当前工作目录是 /Users/sym/clawd");
    });

    it("preserves interleaved answer and tool blocks in event order", async () => {
        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

        ctrl.updateAnswer("阶段1答案：准备先检查当前目录");
        await vi.advanceTimersByTimeAsync(0);

        await ctrl.updateTool("🛠️ Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);

        ctrl.notifyNewAssistantTurn();
        ctrl.updateAnswer("阶段2答案：pwd 已返回结果");
        await vi.advanceTimersByTimeAsync(0);

        await ctrl.updateTool("🛠️ Exec: printf ok");
        await vi.advanceTimersByTimeAsync(0);

        ctrl.notifyNewAssistantTurn();
        ctrl.updateAnswer("阶段3答案：两次工具都已完成");
        await vi.advanceTimersByTimeAsync(0);

        const rendered = ctrl.getRenderedContent?.() ?? "";
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

    it("flushes the latest answer frame before appending a new tool block", async () => {
        const sent: string[] = [];
        streamAICardMock.mockImplementation(async (_card, content) => {
            sent.push(content);
        });

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 300 }) as any;

        await ctrl.updateAnswer("阶段1答案：初版");
        await vi.advanceTimersByTimeAsync(0);

        await ctrl.updateAnswer("阶段1答案：完整版");
        await ctrl.updateTool("🛠️ Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);

        expect(sent).toHaveLength(3);
        expect(sent[1]).toContain("阶段1答案：完整版");
        expect(sent[1]).not.toContain("🛠️ Exec: pwd");
        expect(sent[2]).toContain("阶段1答案：完整版");
        expect(sent[2]).toContain("🛠️ Exec: pwd");
    });

    it("waits for the tool boundary frame before starting the next answer block", async () => {
        const sent: string[] = [];
        let resolveToolFrame!: () => void;
        streamAICardMock.mockImplementation(async (_card, content) => {
            sent.push(content);
            if (content.includes("🛠️ Exec: pwd") && !content.includes("阶段2答案")) {
                await new Promise<void>((r) => { resolveToolFrame = r; });
            }
        });

        const card = makeCard();
        const ctrl = createCardDraftController({ card, throttleMs: 300 }) as any;

        await ctrl.updateAnswer("阶段1答案：准备先检查当前目录");
        await vi.advanceTimersByTimeAsync(0);

        const toolPromise = ctrl.updateTool("🛠️ Exec: pwd");
        await vi.advanceTimersByTimeAsync(0);

        const answerPromise = ctrl.updateAnswer("阶段2答案：pwd 已返回结果");
        await vi.advanceTimersByTimeAsync(0);

        expect(sent.at(-1)).toContain("🛠️ Exec: pwd");
        expect(sent.at(-1)).not.toContain("阶段2答案：pwd 已返回结果");

        resolveToolFrame();
        await toolPromise;
        await answerPromise;
        await vi.advanceTimersByTimeAsync(0);

        expect(sent.at(-1)).toContain("阶段2答案：pwd 已返回结果");
    });
});
