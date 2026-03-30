export interface ReasoningBlockAssembler {
    ingestSnapshot: (text: string | undefined) => string[];
    flushPendingAtBoundary: () => string[];
    reset: () => void;
}

function stripReasoningPrefix(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith("Reasoning:")) {
        return trimmed.slice("Reasoning:".length).trimStart();
    }
    return trimmed;
}

function cleanReasoningLine(line: string): string {
    return line.trim().replace(/^_/, "").replace(/_$/, "").trim();
}

function isClosedReasoningLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith("_") && trimmed.endsWith("_") && trimmed.length >= 2;
}

function startsReasonBlock(line: string): boolean {
    return cleanReasoningLine(line).startsWith("Reason:");
}

function blocksStartWithPrefix(blocks: string[], prefix: string[]): boolean {
    if (prefix.length > blocks.length) {
        return false;
    }
    return prefix.every((entry, index) => blocks[index] === entry);
}

function parseReasoningSnapshot(text: string | undefined): {
    completeBlocks: string[];
    pendingBlock: string;
} {
    const normalized = typeof text === "string" ? stripReasoningPrefix(text) : "";
    if (!normalized.trim()) {
        return {
            completeBlocks: [],
            pendingBlock: "",
        };
    }

    const lines = normalized
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const completeBlocks: string[] = [];
    let currentLines: string[] = [];
    let currentComplete = true;

    const finalizeCurrent = () => {
        if (currentLines.length === 0) {
            return;
        }
        if (currentComplete) {
            completeBlocks.push(currentLines.join("\n"));
        }
    };

    for (const line of lines) {
        if (startsReasonBlock(line)) {
            finalizeCurrent();
            currentLines = [cleanReasoningLine(line)];
            currentComplete = isClosedReasoningLine(line);
            continue;
        }

        if (currentLines.length === 0) {
            continue;
        }

        currentLines.push(cleanReasoningLine(line));
        currentComplete = currentComplete && isClosedReasoningLine(line);
    }

    if (currentLines.length === 0) {
        return {
            completeBlocks,
            pendingBlock: "",
        };
    }

    if (currentComplete) {
        completeBlocks.push(currentLines.join("\n"));
        return {
            completeBlocks,
            pendingBlock: "",
        };
    }

    return {
        completeBlocks,
        pendingBlock: currentLines.join("\n").trim(),
    };
}

export function createReasoningBlockAssembler(): ReasoningBlockAssembler {
    let emittedBlocks: string[] = [];
    let pendingBlock = "";

    return {
        ingestSnapshot(text: string | undefined): string[] {
            const parsed = parseReasoningSnapshot(text);
            pendingBlock = parsed.pendingBlock;

            if (parsed.completeBlocks.length === 0) {
                return [];
            }

            if (blocksStartWithPrefix(parsed.completeBlocks, emittedBlocks)) {
                const nextBlocks = parsed.completeBlocks.slice(emittedBlocks.length);
                emittedBlocks = [...parsed.completeBlocks];
                return nextBlocks;
            }

            if (blocksStartWithPrefix(emittedBlocks, parsed.completeBlocks)) {
                return [];
            }

            return [];
        },

        flushPendingAtBoundary(): string[] {
            if (!pendingBlock.trim()) {
                return [];
            }
            const flushed = pendingBlock;
            pendingBlock = "";
            return [flushed];
        },

        reset(): void {
            emittedBlocks = [];
            pendingBlock = "";
        },
    };
}
