import { readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { getLogger } from "./logger-context";

type SessionIndexEntry = {
    sessionId?: unknown;
    sessionFile?: unknown;
};

type TranscriptMessage = {
    role?: unknown;
    content?: unknown;
};

type TranscriptContentItem = {
    type?: unknown;
    text?: unknown;
};

function resolveSessionTranscriptPath(params: {
    agentId: string;
    sessionKey: string;
}): string | undefined {
    const sessionsPath = join(
        os.homedir(),
        ".openclaw",
        "agents",
        params.agentId,
        "sessions",
        "sessions.json",
    );
    const raw = readFileSync(sessionsPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, SessionIndexEntry> | null;
    const session = parsed?.[params.sessionKey];
    if (!session || typeof session !== "object") {
        return undefined;
    }

    if (typeof session.sessionFile === "string" && session.sessionFile.trim()) {
        return session.sessionFile;
    }

    if (typeof session.sessionId === "string" && session.sessionId.trim()) {
        return join(
            os.homedir(),
            ".openclaw",
            "agents",
            params.agentId,
            "sessions",
            `${session.sessionId}.jsonl`,
        );
    }

    return undefined;
}

export async function readLatestAssistantTextFromTranscript(params: {
    agentId: string;
    sessionKey: string;
}): Promise<string | undefined> {
    const log = getLogger();

    try {
        const transcriptPath = resolveSessionTranscriptPath(params);
        if (!transcriptPath) {
            return undefined;
        }

        const lines = readFileSync(transcriptPath, "utf-8")
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0);

        for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
            const entry = JSON.parse(lines[lineIndex]) as {
                type?: unknown;
                message?: TranscriptMessage;
            };
            if (entry.type !== "message") {
                continue;
            }

            const message = entry.message;
            if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
                continue;
            }

            for (let itemIndex = message.content.length - 1; itemIndex >= 0; itemIndex -= 1) {
                const item = message.content[itemIndex] as TranscriptContentItem;
                if (item?.type !== "text" || typeof item.text !== "string" || !item.text.trim()) {
                    continue;
                }
                return item.text;
            }
        }
    } catch (err: unknown) {
        log?.debug?.(
            `[DingTalk][TempFallback] Failed to read transcript final answer for agentId=${params.agentId} sessionKey=${params.sessionKey}: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }

    return undefined;
}
