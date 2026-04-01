import { readFile } from "node:fs/promises";
import * as os from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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

function isPathWithinDirectory(targetPath: string, directoryPath: string): boolean {
    const resolvedTarget = resolve(targetPath);
    const resolvedDirectory = resolve(directoryPath);
    const relativePath = relative(resolvedDirectory, resolvedTarget);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function resolveSessionTranscriptPath(params: {
    agentId: string;
    sessionKey: string;
}): Promise<string | undefined> {
    const sessionsDir = join(
        os.homedir(),
        ".openclaw",
        "agents",
        params.agentId,
        "sessions",
    );
    const sessionsPath = join(sessionsDir, "sessions.json");
    const raw = await readFile(sessionsPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, SessionIndexEntry> | null;
    const session = parsed?.[params.sessionKey];
    if (!session || typeof session !== "object") {
        return undefined;
    }

    if (typeof session.sessionFile === "string" && session.sessionFile.trim()) {
        const candidatePath = resolve(session.sessionFile);
        return isPathWithinDirectory(candidatePath, sessionsDir) ? candidatePath : undefined;
    }

    if (typeof session.sessionId === "string" && session.sessionId.trim()) {
        const candidatePath = join(
            sessionsDir,
            `${session.sessionId}.jsonl`,
        );
        return isPathWithinDirectory(candidatePath, sessionsDir) ? candidatePath : undefined;
    }

    return undefined;
}

export async function readLatestAssistantTextFromTranscript(params: {
    agentId: string;
    sessionKey: string;
}): Promise<string | undefined> {
    const log = getLogger();

    try {
        const transcriptPath = await resolveSessionTranscriptPath(params);
        if (!transcriptPath) {
            return undefined;
        }

        const lines = (await readFile(transcriptPath, "utf-8"))
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
