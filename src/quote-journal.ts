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
    mediaPath?: string;
    mediaType?: string;
}

export interface AppendQuoteJournalEntryParams {
    storePath: string;
    accountId: string;
    conversationId: string;
    msgId: string;
    messageType: string;
    text: string;
    mediaPath?: string;
    mediaType?: string;
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

export interface ResolveQuotedMessageWithBacktrackParams extends ResolveQuotedMessageByIdParams {
    windowSize?: number;
    maxRounds?: number;
}

export interface CleanupExpiredQuoteJournalEntriesParams {
    storePath: string;
    accountId: string;
    conversationId: string;
    ttlDays?: number;
    nowMs?: number;
}

export interface AppendOutboundToQuoteJournalParams {
    storePath: string;
    accountId: string;
    conversationId: string;
    messageId?: string;
    messageType: string;
    text: string;
    log?: { debug?: (msg: string) => void };
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

function normalizeMsgId(value: string): string {
    let next = value.trim();
    if (!next) return "";
    if (
        (next.startsWith('"') && next.endsWith('"')) ||
        (next.startsWith("'") && next.endsWith("'"))
    ) {
        next = next.slice(1, -1);
    }
    try {
        next = decodeURIComponent(next);
    } catch {
        // ignore malformed percent-encoding
    }
    // Some transports decode '+' into space; convert back for msgId matching.
    next = next.replace(/ /g, "+");
    return next;
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
        if (parsed.mediaPath !== undefined && typeof parsed.mediaPath !== "string") {
            return null;
        }
        if (parsed.mediaType !== undefined && typeof parsed.mediaType !== "string") {
            return null;
        }
        return parsed as QuoteJournalEntry;
    } catch {
        return null;
    }
}

function extractReferencedMsgId(text: string): string | null {
    const match = text.match(/\[这是一条引用消息，原消息ID:\s*([^\]]+)\]/);
    if (!match?.[1]) {
        return null;
    }
    const id = normalizeMsgId(match[1]);
    return id || null;
}

async function readActiveEntries(
    params: ResolveQuotedMessageByIdParams,
): Promise<{ entries: QuoteJournalEntry[]; nowMs: number; ttlDays: number }> {
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
        return { entries: [], nowMs, ttlDays };
    }

    const entries = content
        .split("\n")
        .map((line) => safeParseLine(line))
        .filter((entry): entry is QuoteJournalEntry => Boolean(entry))
        .filter((entry) => isEntryWithinTtl(entry.ts, nowMs, ttlDays));

    return { entries, nowMs, ttlDays };
}

export async function appendQuoteJournalEntry(params: AppendQuoteJournalEntryParams): Promise<void> {
    if (!params.msgId) {
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
        mediaPath: params.mediaPath,
        mediaType: params.mediaType,
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

export async function appendOutboundToQuoteJournal(
    params: AppendOutboundToQuoteJournalParams,
): Promise<void> {
    if (!params.messageId || !params.text.trim()) {
        return;
    }
    try {
        await appendQuoteJournalEntry({
            storePath: params.storePath,
            accountId: params.accountId,
            conversationId: params.conversationId,
            msgId: params.messageId,
            messageType: params.messageType,
            text: params.text,
        });
    } catch (err) {
        params.log?.debug?.(
            `[DingTalk] Quote journal append failed for outbound messageId=${params.messageId}: ${String(err)}`,
        );
    }
}

export async function appendProactiveOutboundJournal(
    params: Omit<AppendOutboundToQuoteJournalParams, "messageType"> & { messageType?: string },
): Promise<void> {
    await appendOutboundToQuoteJournal({
        ...params,
        messageType: params.messageType || "outbound-proactive",
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
    const targetMsgId = normalizeMsgId(params.originalMsgId);
    if (!targetMsgId) {
        return null;
    }

    const { entries } = await readActiveEntries(params);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i]!;
        if (normalizeMsgId(entry.msgId) === targetMsgId) {
            return entry;
        }
    }

    return null;
}

export async function resolveQuotedMessageWithBacktrack(
    params: ResolveQuotedMessageWithBacktrackParams,
): Promise<QuoteJournalEntry | null> {
    if (!params.originalMsgId) {
        return null;
    }
    const targetMsgId = normalizeMsgId(params.originalMsgId);
    if (!targetMsgId) {
        return null;
    }

    const { entries } = await readActiveEntries(params);
    if (entries.length === 0) {
        return null;
    }

    const windowSize = Math.max(1, params.windowSize ?? 10);
    const maxRounds = Math.max(1, params.maxRounds ?? 5);

    const lastIndexByMsgId = new Map<string, number>();
    for (let i = 0; i < entries.length; i += 1) {
        const id = normalizeMsgId(entries[i]!.msgId);
        if (id) {
            lastIndexByMsgId.set(id, i);
        }
    }

    const hasReadableMedia = (entry: QuoteJournalEntry): boolean =>
        Boolean(entry.mediaPath);

    const exactIndex = lastIndexByMsgId.get(targetMsgId);
    if (typeof exactIndex === "number") {
        const exact = entries[exactIndex]!;
        if (hasReadableMedia(exact)) {
            return exact;
        }
    }

    let cursor = typeof exactIndex === "number" ? exactIndex + 1 : entries.length;
    const visitedRefs = new Set<string>([targetMsgId]);

    for (let round = 0; round < maxRounds && cursor > 0; round += 1) {
        const start = Math.max(0, cursor - windowSize);
        let jumped = false;

        for (let i = cursor - 1; i >= start; i -= 1) {
            const entry = entries[i]!;
            if (hasReadableMedia(entry)) {
                return entry;
            }

            const refId = extractReferencedMsgId(entry.text);
            if (!refId || visitedRefs.has(refId)) {
                continue;
            }
            visitedRefs.add(refId);

            const refIndex = lastIndexByMsgId.get(refId);
            if (typeof refIndex === "number") {
                cursor = refIndex + 1;
                jumped = true;
                break;
            }
        }

        if (!jumped) {
            cursor = start;
        }
    }

    return typeof exactIndex === "number" ? entries[exactIndex]! : null;
}
