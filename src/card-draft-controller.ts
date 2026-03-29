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
import type { AICardInstance, CardBlock, Logger } from "./types";

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
    getRenderedContent: (options?: {
        fallbackAnswer?: string;
        overrideAnswer?: string;
        compactProcessAnswerSpacing?: boolean;
    }) => string;
    /** Get a copy of the current block list. */
    getBlockList: () => CardBlock[];
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
        .map((line) => line.trim() ? `> ${line.trim()}` : ">")
        .join("\n");
}

function renderProcessBlock(text: string): string {
    return quoteMarkdown(text);
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

    let timelineEntries: CardBlock[] = [];
    let activeProcessIndex: number | null = null;
    let activeAnswerIndex: number | null = null;
    let pendingBoundaryPromise: Promise<void> | null = null;

    const effectiveThrottleMs = params.throttleMs ?? (params.verboseMode ? 50 : 300);

    const getFinalAnswerContent = (): string => {
        return timelineEntries
            .filter((entry) => !entry.isTool && entry.text)
            .map((entry) => entry.text)
            .join("\n\n");
    };

    const removeTimelineEntry = (index: number) => {
        timelineEntries.splice(index, 1);
        if (activeProcessIndex !== null) {
            if (activeProcessIndex === index) {
                activeProcessIndex = null;
            } else if (activeProcessIndex > index) {
                activeProcessIndex -= 1;
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

    const appendTimelineEntry = (isTool: boolean, text: string): number => {
        timelineEntries.push({ text, markdown: text, isTool });
        return timelineEntries.length - 1;
    };

    const renderTimeline = (options: {
        fallbackAnswer?: string;
        overrideAnswer?: string;
        compactProcessAnswerSpacing?: boolean;
    } = {}): string => {
        const entries = timelineEntries.map((entry) => ({ ...entry }));

        const overrideAnswer = normalizeAnswerText(options.overrideAnswer);
        if (overrideAnswer) {
            const lastAnswerIndex = [...entries]
                .map((entry, index) => ({ entry, index }))
                .toReversed()
                .find(({ entry }) => !entry.isTool)?.index;
            if (lastAnswerIndex !== undefined) {
                entries[lastAnswerIndex] = { text: overrideAnswer, markdown: overrideAnswer, isTool: false };
            } else {
                entries.push({ text: overrideAnswer, markdown: overrideAnswer, isTool: false });
            }
        } else if (!entries.some((entry) => !entry.isTool && entry.text)) {
            const fallbackAnswer = normalizeAnswerText(options.fallbackAnswer);
            if (fallbackAnswer) {
                entries.push({ text: fallbackAnswer, markdown: fallbackAnswer, isTool: false });
            }
        }

        let rendered = "";
        const compactProcessAnswerSpacing = options.compactProcessAnswerSpacing === true;
        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            if (!entry?.text) {
                continue;
            }
            const part = entry.isTool
                ? renderProcessBlock(entry.text)
                : entry.text;
            if (!rendered) {
                rendered = part;
                continue;
            }
            const previousIsTool = entries[index - 1]?.isTool;
            const separator =
                compactProcessAnswerSpacing && previousIsTool !== undefined
                    ? "\n"
                    : "\n\n";
            rendered += `${separator}${part}`;
        }

        return rendered;
    };

    const sealActiveProcess = () => {
        activeProcessIndex = null;
    };

    const sealCurrentAnswer = () => {
        activeAnswerIndex = null;
    };

    const queueRender = () => {
        const rendered = renderTimeline({ compactProcessAnswerSpacing: true });
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
                const blockList = timelineEntries;
                await streamAICard(params.card, blockList, false, params.log);
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
        if (activeProcessIndex === null && timelineEntries.length > 0) {
            const lastIsTool = timelineEntries.at(-1)?.isTool;
            if (lastIsTool === false) {
                await flushBoundaryFrame();
            }
        }
        if (activeProcessIndex !== null) {
            timelineEntries[activeProcessIndex] = { text: normalized, markdown: normalized, isTool: true };
        } else {
            activeProcessIndex = appendTimelineEntry(true, normalized);
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
            const lastIsTool = timelineEntries.at(-1)?.isTool;
            if (lastIsTool === true) {
                await flushBoundaryFrame();
            }
        }
        sealActiveProcess();
        if (activeAnswerIndex !== null) {
            timelineEntries[activeAnswerIndex] = { text: normalized, markdown: normalized, isTool: false };
        } else {
            activeAnswerIndex = appendTimelineEntry(false, normalized);
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
        sealActiveProcess();
        sealCurrentAnswer();
        appendTimelineEntry(true, normalized);
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
        if (activeProcessIndex !== null) {
            removeTimelineEntry(activeProcessIndex);
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
        getBlockList: () => [...timelineEntries],
    };
}
