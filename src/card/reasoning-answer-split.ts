export interface CardReasoningAnswerSplit {
    reasoningText?: string;
    answerText?: string;
}

const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;

function isWrappedReasoningLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith("_") && trimmed.endsWith("_") && trimmed.length >= 2;
}

function cleanReasoningLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed) {
        return "";
    }
    return trimmed.replace(/^_/, "").replace(/_$/, "").trim();
}

function joinAnswerParts(parts: string[]): string | undefined {
    const joined = parts.map((part) => part.trim()).filter(Boolean).join("\n\n").trim();
    return joined || undefined;
}

function hasStructuredMarkdown(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
        return false;
    }
    return (
        trimmed.includes("**")
        || trimmed.includes("```")
        || /(^|\n)\s*(?:[-*+]\s|#{1,6}\s|>\s|\d+\.\s)/.test(trimmed)
    );
}

function splitTopLevelReasoningPrefix(text: string): CardReasoningAnswerSplit | null {
    const markerIndex = text.indexOf("Reasoning:");
    if (markerIndex < 0) {
        return null;
    }

    const before = text.slice(0, markerIndex).trim();
    if (before && hasStructuredMarkdown(before)) {
        return {
            answerText: text,
        };
    }

    const trailing = text.slice(markerIndex + "Reasoning:".length);
    const lines = trailing.split("\n");
    const reasoningLines: string[] = [];
    let started = false;
    let remainderIndex = -1;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmed = line.trim();

        if (!started) {
            if (!trimmed) {
                continue;
            }
            if (!isWrappedReasoningLine(trimmed)) {
                return {
                    answerText: text,
                };
            }
            started = true;
            reasoningLines.push(cleanReasoningLine(trimmed));
            continue;
        }

        if (!trimmed) {
            continue;
        }

        if (isWrappedReasoningLine(trimmed)) {
            reasoningLines.push(cleanReasoningLine(trimmed));
            continue;
        }

        remainderIndex = index;
        break;
    }

    if (reasoningLines.length === 0) {
        return {
            answerText: text,
        };
    }

    const after = remainderIndex >= 0 ? lines.slice(remainderIndex).join("\n").trim() : "";
    return {
        reasoningText: reasoningLines.join("\n").trim() || undefined,
        answerText: joinAnswerParts([before, after]),
    };
}

function splitTopLevelThinkingTags(text: string): CardReasoningAnswerSplit | null {
    if (!THINKING_TAG_RE.test(text)) {
        return null;
    }
    THINKING_TAG_RE.lastIndex = 0;

    let reasoning = "";
    let answer = "";
    let lastIndex = 0;
    let inThinking = false;

    for (const match of text.matchAll(THINKING_TAG_RE)) {
        const matchIndex = match.index ?? 0;
        const segment = text.slice(lastIndex, matchIndex);
        if (inThinking) {
            reasoning += segment;
        } else {
            answer += segment;
        }
        inThinking = match[1] !== "/";
        lastIndex = matchIndex + match[0].length;
    }

    const tail = text.slice(lastIndex);
    if (inThinking) {
        reasoning += tail;
    } else {
        answer += tail;
    }

    const cleanedReasoning = reasoning.trim();
    if (!cleanedReasoning) {
        return {
            answerText: text,
        };
    }

    return {
        reasoningText: cleanedReasoning,
        answerText: answer.trim() || undefined,
    };
}

export function splitCardReasoningAnswerText(text?: string): CardReasoningAnswerSplit {
    if (typeof text !== "string") {
        return {};
    }

    const prefixed = splitTopLevelReasoningPrefix(text);
    if (prefixed) {
        return prefixed;
    }

    const tagged = splitTopLevelThinkingTags(text);
    if (tagged) {
        return tagged;
    }

    return {
        answerText: text,
    };
}
