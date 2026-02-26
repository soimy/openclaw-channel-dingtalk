import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_QUOTE_JOURNAL_TTL_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface QuoteJournalEntry {
    ts: number;
    accountId: string;
    conversationId: string;
    msgId: string;
    messageType: string;
    text: string;
}

export interface AppendQuoteJournalEntryParams {
    storePath: string;
    accountId: string;
    conversationId: string;
    msgId: string;
    messageType: string;
    text: string;
    createdAt?: number;
    ttlDays?: number;
    nowMs?: number;
}

export interface ResolveQuotedMessageByIdParams {
    storePath: string;
    accountId: string;
    conversationId: string;
    originalMsgId: string;
    ttlDays?: number;
    nowMs?: number;
}

export interface CleanupExpiredQuoteJournalEntriesParams {
    storePath: string;
    accountId: string;
    conversationId: string;
    ttlDays?: number;
    nowMs?: number;
}

function sanitizeSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function resolveQuoteJournalFile(params: {
    storePath: string;
    accountId: string;
    conversationId: string;
}): string {
    const dir = path.join(
        path.dirname(path.resolve(params.storePath)),
        "dingtalk-quote-journal",
        sanitizeSegment(params.accountId),
    );
    return path.join(dir, `${sanitizeSegment(params.conversationId)}.jsonl`);
}

function isEntryWithinTtl(entryTs: number, nowMs: number, ttlDays: number): boolean {
    return nowMs - entryTs <= ttlDays * MS_PER_DAY;
}

function safeParseLine(line: string): QuoteJournalEntry | null {
    if (!line.trim()) {
        return null;
    }
    try {
        const parsed = JSON.parse(line) as Partial<QuoteJournalEntry>;
        if (
            typeof parsed.ts !== "number" ||
            typeof parsed.accountId !== "string" ||
            typeof parsed.conversationId !== "string" ||
            typeof parsed.msgId !== "string" ||
            typeof parsed.messageType !== "string" ||
            typeof parsed.text !== "string"
        ) {
            return null;
        }
        return parsed as QuoteJournalEntry;
    } catch {
        return null;
    }
}

export async function appendQuoteJournalEntry(params: AppendQuoteJournalEntryParams): Promise<void> {
    if (!params.msgId || !params.text.trim()) {
        return;
    }
    const filePath = resolveQuoteJournalFile(params);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const entry: QuoteJournalEntry = {
        ts: params.createdAt ?? Date.now(),
        accountId: params.accountId,
        conversationId: params.conversationId,
        msgId: params.msgId,
        messageType: params.messageType,
        text: params.text,
    };
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");

    const ttlDays =
        typeof params.ttlDays === "number" && params.ttlDays > 0
            ? Math.floor(params.ttlDays)
            : DEFAULT_QUOTE_JOURNAL_TTL_DAYS;
    await cleanupExpiredQuoteJournalEntries({
        storePath: params.storePath,
        accountId: params.accountId,
        conversationId: params.conversationId,
        ttlDays,
        nowMs: params.nowMs,
    });
}

export async function cleanupExpiredQuoteJournalEntries(
    params: CleanupExpiredQuoteJournalEntriesParams,
): Promise<number> {
    const filePath = resolveQuoteJournalFile(params);
    const nowMs = params.nowMs ?? Date.now();
    const ttlDays =
        typeof params.ttlDays === "number" && params.ttlDays > 0
            ? Math.floor(params.ttlDays)
            : DEFAULT_QUOTE_JOURNAL_TTL_DAYS;

    let content: string;
    try {
        content = await fs.readFile(filePath, "utf8");
    } catch {
        return 0;
    }

    const kept: QuoteJournalEntry[] = [];
    let removed = 0;
    for (const line of content.split("\n")) {
        const entry = safeParseLine(line);
        if (!entry) {
            continue;
        }
        if (isEntryWithinTtl(entry.ts, nowMs, ttlDays)) {
            kept.push(entry);
        } else {
            removed += 1;
        }
    }

    if (removed > 0) {
        const next = kept.map((entry) => JSON.stringify(entry)).join("\n");
        await fs.writeFile(filePath, next ? `${next}\n` : "", "utf8");
    }

    return removed;
}

export async function resolveQuotedMessageById(
    params: ResolveQuotedMessageByIdParams,
): Promise<QuoteJournalEntry | null> {
    if (!params.originalMsgId) {
        return null;
    }

    const filePath = resolveQuoteJournalFile(params);
    const nowMs = params.nowMs ?? Date.now();
    const ttlDays =
        typeof params.ttlDays === "number" && params.ttlDays > 0
            ? Math.floor(params.ttlDays)
            : DEFAULT_QUOTE_JOURNAL_TTL_DAYS;

    let content: string;
    try {
        content = await fs.readFile(filePath, "utf8");
    } catch {
        return null;
    }

    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const entry = safeParseLine(lines[i] || "");
        if (!entry) {
            continue;
        }
        if (!isEntryWithinTtl(entry.ts, nowMs, ttlDays)) {
            continue;
        }
        if (entry.msgId === params.originalMsgId) {
            return entry;
        }
    }

    return null;
}
