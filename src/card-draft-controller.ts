/**
 * Card draft controller for throttled AI Card streaming updates.
 *
 * The controller keeps a single rendered card timeline made of:
 * - sealed process blocks (`thinking` / `tool`)
 * - an optional live thinking block
 * - accumulated answer turns rendered as plain markdown
 *
 * It delegates throttling and single-flight transport guarantees to
 * {@link createDraftStreamLoop}.
 */

import { streamAICard } from "./card-service";
import { createDraftStreamLoop } from "./draft-stream-loop";
import type { AICardInstance, Logger } from "./types";

type ProcessBlockKind = "thinking" | "tool";

type ProcessBlock = {
    kind: ProcessBlockKind;
    text: string;
};

export interface CardDraftController {
    updateAnswer: (text: string) => void;
    updateReasoning: (text: string) => void;
    updateThinking: (text: string) => void;
    updateTool: (text: string) => Promise<void>;
    appendTool: (text: string) => Promise<void>;
    /** Signal that a new assistant turn has started (e.g. after a tool call). */
    notifyNewAssistantTurn: () => void;
    startAssistantTurn: () => void;
    flush: () => Promise<void>;
    waitForInFlight: () => Promise<void>;
    stop: () => void;
    isFailed: () => boolean;
    /** Last content successfully sent to card. */
    getLastContent: () => string;
    /** Last answer-only content successfully sent to card. */
    getLastAnswerContent: () => string;
    /** Current answer-only content composed from all completed answer turns. */
    getFinalAnswerContent: () => string;
    /** Current rendered timeline, including process blocks and answer text. */
    getRenderedContent: (options?: { fallbackAnswer?: string }) => string;
}

function normalizeProcessText(text: string | undefined): string {
    return typeof text === "string" ? text.trim() : "";
}

function normalizeAnswerText(text: string | undefined): string {
    return typeof text === "string" ? text.trimStart() : "";
}

function quoteMarkdown(text: string): string {
    return text
        .split("\n")
        .map((line) => line.trim() ? `> ${line}` : ">")
        .join("\n");
}

function renderProcessBlock(kind: ProcessBlockKind, text: string): string {
    const title = kind === "thinking" ? "🤔 思考" : "🛠 工具";
    return `${title}\n${quoteMarkdown(text)}`;
}

export function createCardDraftController(params: {
    card: AICardInstance;
    throttleMs?: number;
    /** Legacy compatibility: verbose mode previously lowered the throttle. */
    verboseMode?: boolean;
    log?: Logger;
}): CardDraftController {
    let failed = false;
    let stopped = false;
    let lastSentContent = "";
    let lastAnswerContent = "";

    let processBlocks: ProcessBlock[] = [];
    let liveThinkingText = "";
    let answerTurns: string[] = [];
    let currentAnswerTurn = "";

    const effectiveThrottleMs = params.throttleMs ?? (params.verboseMode ? 50 : 300);

    const getFinalAnswerContent = (): string => {
        return [...answerTurns, currentAnswerTurn].filter(Boolean).join("\n\n");
    };

    const renderTimeline = (options: { fallbackAnswer?: string } = {}): string => {
        const parts: string[] = [];

        for (const block of processBlocks) {
            if (!block.text) {
                continue;
            }
            parts.push(renderProcessBlock(block.kind, block.text));
        }

        if (liveThinkingText) {
            parts.push(renderProcessBlock("thinking", liveThinkingText));
        }

        const answer = getFinalAnswerContent() || normalizeAnswerText(options.fallbackAnswer);
        if (answer) {
            parts.push(answer);
        }

        return parts.join("\n\n");
    };

    const sealLiveThinking = () => {
        if (!liveThinkingText) {
            return;
        }
        processBlocks.push({ kind: "thinking", text: liveThinkingText });
        liveThinkingText = "";
    };

    const queueRender = () => {
        const rendered = renderTimeline();
        if (rendered) {
            loop.update(rendered);
            return;
        }
        loop.resetPending();
    };

    const loop = createDraftStreamLoop({
        throttleMs: effectiveThrottleMs,
        isStopped: () => stopped || failed,
        sendOrEditStreamMessage: async (content: string) => {
            try {
                await streamAICard(params.card, content, false, params.log);
                lastSentContent = content;
                lastAnswerContent = getFinalAnswerContent();
            } catch (err: unknown) {
                failed = true;
                const message = err instanceof Error ? err.message : String(err);
                params.log?.warn?.(`[DingTalk][AICard] Stream failed: ${message}`);
            }
        },
    });

    const updateReasoning = (text: string) => {
        if (stopped || failed || currentAnswerTurn) {
            return;
        }
        const normalized = normalizeProcessText(text);
        if (!normalized) {
            return;
        }
        liveThinkingText = normalized;
        queueRender();
    };

    const updateAnswer = (text: string) => {
        if (stopped || failed) {
            return;
        }
        const normalized = normalizeAnswerText(text);
        if (!normalized.trim()) {
            return;
        }
        sealLiveThinking();
        currentAnswerTurn = normalized;
        queueRender();
    };

    const updateTool = async (text: string) => {
        if (stopped || failed) {
            return;
        }
        const normalized = normalizeProcessText(text);
        if (!normalized) {
            return;
        }
        sealLiveThinking();
        processBlocks.push({ kind: "tool", text: normalized });
        queueRender();
    };

    const notifyNewAssistantTurn = () => {
        if (stopped || failed) {
            return;
        }
        if (currentAnswerTurn) {
            answerTurns.push(currentAnswerTurn);
            currentAnswerTurn = "";
            return;
        }
        if (liveThinkingText) {
            liveThinkingText = "";
            loop.resetPending();
        }
    };

    return {
        updateAnswer,
        updateReasoning,
        updateThinking: updateReasoning,
        updateTool,
        appendTool: updateTool,
        notifyNewAssistantTurn,
        startAssistantTurn: notifyNewAssistantTurn,
        flush: () => loop.flush(),
        waitForInFlight: () => loop.waitForInFlight(),

        stop: () => {
            stopped = true;
            loop.stop();
        },

        isFailed: () => failed,
        getLastContent: () => lastSentContent,
        getLastAnswerContent: () => lastAnswerContent,
        getFinalAnswerContent,
        getRenderedContent: renderTimeline,
    };
}
