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

type TimelineEntryKind = "thinking" | "tool" | "answer";

type TimelineEntry = {
    kind: TimelineEntryKind;
    text: string;
};

export interface CardDraftController {
    updateAnswer: (text: string) => Promise<void>;
    updateReasoning: (text: string) => Promise<void>;
    updateThinking: (text: string) => Promise<void>;
    updateTool: (text: string) => Promise<void>;
    appendTool: (text: string) => Promise<void>;
    /** Signal that a new assistant turn has started (e.g. after a tool call). */
    notifyNewAssistantTurn: () => Promise<void>;
    startAssistantTurn: () => Promise<void>;
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
    getRenderedContent: (options?: { fallbackAnswer?: string; overrideAnswer?: string }) => string;
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

function renderProcessBlock(kind: "thinking" | "tool", text: string): string {
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

    let timelineEntries: TimelineEntry[] = [];
    let activeThinkingIndex: number | null = null;
    let activeAnswerIndex: number | null = null;
    let pendingBoundaryPromise: Promise<void> | null = null;

    const effectiveThrottleMs = params.throttleMs ?? (params.verboseMode ? 50 : 300);

    const getFinalAnswerContent = (): string => {
        return timelineEntries
            .filter((entry) => entry.kind === "answer" && entry.text)
            .map((entry) => entry.text)
            .join("\n\n");
    };

    const removeTimelineEntry = (index: number) => {
        timelineEntries.splice(index, 1);
        if (activeThinkingIndex !== null) {
            if (activeThinkingIndex === index) {
                activeThinkingIndex = null;
            } else if (activeThinkingIndex > index) {
                activeThinkingIndex -= 1;
            }
        }
        if (activeAnswerIndex !== null) {
            if (activeAnswerIndex === index) {
                activeAnswerIndex = null;
            } else if (activeAnswerIndex > index) {
                activeAnswerIndex -= 1;
            }
        }
    };

    const appendTimelineEntry = (kind: TimelineEntryKind, text: string): number => {
        timelineEntries.push({ kind, text });
        return timelineEntries.length - 1;
    };

    const renderTimeline = (options: { fallbackAnswer?: string; overrideAnswer?: string } = {}): string => {
        const parts: string[] = [];
        const entries = timelineEntries.map((entry) => ({ ...entry }));

        const overrideAnswer = normalizeAnswerText(options.overrideAnswer);
        if (overrideAnswer) {
            const lastAnswerIndex = [...entries]
                .map((entry, index) => ({ entry, index }))
                .toReversed()
                .find(({ entry }) => entry.kind === "answer")?.index;
            if (lastAnswerIndex !== undefined) {
                entries[lastAnswerIndex] = { kind: "answer", text: overrideAnswer };
            } else {
                entries.push({ kind: "answer", text: overrideAnswer });
            }
        } else if (!entries.some((entry) => entry.kind === "answer" && entry.text)) {
            const fallbackAnswer = normalizeAnswerText(options.fallbackAnswer);
            if (fallbackAnswer) {
                entries.push({ kind: "answer", text: fallbackAnswer });
            }
        }

        for (const entry of entries) {
            if (!entry.text) {
                continue;
            }
            if (entry.kind === "answer") {
                parts.push(entry.text);
            } else {
                parts.push(renderProcessBlock(entry.kind, entry.text));
            }
        }

        return parts.join("\n\n");
    };

    const sealLiveThinking = () => {
        activeThinkingIndex = null;
    };

    const sealCurrentAnswer = () => {
        activeAnswerIndex = null;
    };

    const queueRender = () => {
        const rendered = renderTimeline();
        if (rendered) {
            loop.update(rendered);
            return;
        }
        loop.resetPending();
    };

    const flushBoundaryFrame = async () => {
        if (stopped || failed) {
            return;
        }
        await loop.flush();
        await loop.waitForInFlight();
        loop.resetThrottleWindow();
    };

    const beginBoundaryFlush = () => {
        if (pendingBoundaryPromise) {
            return pendingBoundaryPromise;
        }
        const current = flushBoundaryFrame().finally(() => {
            if (pendingBoundaryPromise === current) {
                pendingBoundaryPromise = null;
            }
        });
        pendingBoundaryPromise = current;
        return current;
    };

    const waitForPendingBoundary = async () => {
        if (pendingBoundaryPromise) {
            await pendingBoundaryPromise;
        }
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

    const updateReasoning = async (text: string) => {
        await waitForPendingBoundary();
        if (stopped || failed || activeAnswerIndex !== null) {
            return;
        }
        const normalized = normalizeProcessText(text);
        if (!normalized) {
            return;
        }
        if (activeThinkingIndex === null && timelineEntries.length > 0) {
            const lastKind = timelineEntries.at(-1)?.kind;
            if (lastKind && lastKind !== "thinking") {
                await flushBoundaryFrame();
            }
        }
        if (activeThinkingIndex !== null) {
            timelineEntries[activeThinkingIndex] = { kind: "thinking", text: normalized };
        } else {
            activeThinkingIndex = appendTimelineEntry("thinking", normalized);
        }
        queueRender();
    };

    const updateAnswer = async (text: string) => {
        await waitForPendingBoundary();
        if (stopped || failed) {
            return;
        }
        const normalized = normalizeAnswerText(text);
        if (!normalized.trim()) {
            return;
        }
        if (activeAnswerIndex === null && timelineEntries.length > 0) {
            const lastKind = timelineEntries.at(-1)?.kind;
            if (lastKind && lastKind !== "answer") {
                await flushBoundaryFrame();
            }
        }
        sealLiveThinking();
        if (activeAnswerIndex !== null) {
            timelineEntries[activeAnswerIndex] = { kind: "answer", text: normalized };
        } else {
            activeAnswerIndex = appendTimelineEntry("answer", normalized);
        }
        queueRender();
    };

    const updateTool = async (text: string) => {
        await waitForPendingBoundary();
        if (stopped || failed) {
            return;
        }
        const normalized = normalizeProcessText(text);
        if (!normalized) {
            return;
        }
        if (timelineEntries.length > 0) {
            await flushBoundaryFrame();
        }
        sealLiveThinking();
        sealCurrentAnswer();
        appendTimelineEntry("tool", normalized);
        queueRender();
    };

    const notifyNewAssistantTurn = async () => {
        if (stopped || failed) {
            return;
        }
        if (activeAnswerIndex !== null) {
            sealCurrentAnswer();
            await beginBoundaryFlush();
            return;
        }
        if (activeThinkingIndex !== null) {
            removeTimelineEntry(activeThinkingIndex);
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
