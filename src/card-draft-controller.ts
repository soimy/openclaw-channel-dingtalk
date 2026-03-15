/**
 * Card draft controller for throttled AI Card streaming updates.
 *
 * Wraps {@link createDraftStreamLoop} with a phase-based state machine
 * (idle → reasoning → answer) that manages what content is sent to the
 * DingTalk AI Card during the reply lifecycle.
 *
 * Responsibilities (and non-responsibilities):
 * - DOES manage throttled card preview updates via streamAICard
 * - DOES enforce single-flight, latest-wins, phase-gated semantics
 * - Does NOT handle tool append, finalize, or markdown fallback —
 *   those stay in inbound-handler's deliver callback.
 */

import { formatContentForCard, streamAICard } from "./card-service";
import { createDraftStreamLoop } from "./draft-stream-loop";
import type { AICardInstance, Logger } from "./types";

export type CardDraftPhase = "idle" | "reasoning" | "answer";

export interface CardDraftController {
    updateAnswer: (text: string) => void;
    updateReasoning: (text: string) => void;
    flush: () => Promise<void>;
    waitForInFlight: () => Promise<void>;
    stop: () => void;
    isFailed: () => boolean;
    getLastContent: () => string;
}

export function createCardDraftController(params: {
    card: AICardInstance;
    throttleMs?: number;
    log?: Logger;
}): CardDraftController {
    let phase: CardDraftPhase = "idle";
    let failed = false;
    let stopped = false;
    let lastSentContent = "";
    let answerPrefix = "";
    let lastPartialLen = 0;

    const loop = createDraftStreamLoop({
        throttleMs: params.throttleMs ?? 300,
        isStopped: () => stopped || failed,
        sendOrEditStreamMessage: async (content: string) => {
            try {
                await streamAICard(params.card, content, false, params.log);
                lastSentContent = content;
            } catch (err: unknown) {
                failed = true;
                const message = err instanceof Error ? err.message : String(err);
                params.log?.warn?.(`[DingTalk][AICard] Stream failed: ${message}`);
            }
        },
    });

    return {
        updateReasoning: (text: string) => {
            if (stopped || failed || phase === "answer") { return; }
            phase = "reasoning";
            const formatted = formatContentForCard(text, "thinking");
            if (formatted) {
                loop.update(formatted);
            }
        },

        updateAnswer: (text: string) => {
            if (stopped || failed) { return; }
            if (phase !== "answer") {
                if (phase === "reasoning") {
                    loop.resetPending();
                }
                params.log?.debug?.(`[DingTalk][Draft] phase ${phase} → answer`);
                phase = "answer";
            }
            if (text) {
                // Heuristic: runtime resets payload.text per assistant turn
                // (e.g. after a tool call). A dramatic length drop (>50%)
                // signals a new turn; minor trimming is ignored.
                if (text.length < lastPartialLen * 0.5 && lastSentContent) {
                    answerPrefix = lastSentContent + "\n\n";
                }
                lastPartialLen = text.length;
                loop.update(answerPrefix + text);
            }
        },

        flush: () => loop.flush(),
        waitForInFlight: () => loop.waitForInFlight(),

        stop: () => {
            stopped = true;
            loop.stop();
        },

        isFailed: () => failed,
        getLastContent: () => lastSentContent,
    };
}
