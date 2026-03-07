import axios from "axios";
import { getAccessToken } from "./auth";
import { getDingTalkRuntime } from "./runtime";
import type { DingTalkConfig, Logger, MediaFile } from "./types";
import { formatDingTalkErrorPayloadLog } from "./utils";

const DINGTALK_API = "https://api.dingtalk.com";
const DINGTALK_OAPI = "https://oapi.dingtalk.com";

const MATCH_WINDOW_MS = 5000;
const MAX_PAGES = 3;
const PAGE_SIZE = 50;

const UNION_ID_CACHE_MAX = 5000;
const SPACE_ID_CACHE_MAX = 500;

// ============ LRU caches ============

const unionIdCache = new Map<string, string>();
const spaceIdCache = new Map<string, string>();

function lruSet<V>(map: Map<string, V>, key: string, value: V, maxSize: number): void {
    if (map.has(key)) {
        map.delete(key);
    }
    map.set(key, value);
    if (map.size > maxSize) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) {
            map.delete(oldest);
        }
    }
}

function lruGet<V>(map: Map<string, V>, key: string): V | undefined {
    const value = map.get(key);
    if (value === undefined) {
        return undefined;
    }
    map.delete(key);
    map.set(key, value);
    return value;
}

// ============ Time parsing ============

export function parseDingTalkFileTime(timeStr: string): number {
    const normalized = timeStr.replace(/\bCST\b/, "+0800");
    const ms = new Date(normalized).getTime();
    if (Number.isNaN(ms)) {
        throw new Error(`Cannot parse DingTalk file time: ${timeStr}`);
    }
    return ms;
}

// ============ API helpers ============

export async function getUnionIdByStaffId(
    config: DingTalkConfig,
    staffId: string,
    log?: Logger,
): Promise<string> {
    const cacheKey = `${config.clientId}:${staffId}`;
    const cached = lruGet(unionIdCache, cacheKey);
    if (cached) {
        return cached;
    }

    const token = await getAccessToken(config, log);
    const resp = await axios.post(
        `${DINGTALK_OAPI}/topapi/v2/user/get?access_token=${token}`,
        { userid: staffId },
    );

    const payload = resp.data as Record<string, any>;
    if (payload.errcode !== 0) {
        throw new Error(`topapi/v2/user/get failed: errcode=${payload.errcode} errmsg=${payload.errmsg}`);
    }

    const unionId = payload.result?.unionid as string;
    if (!unionId) {
        throw new Error(`topapi/v2/user/get returned no unionid for staffId=${staffId}`);
    }

    lruSet(unionIdCache, cacheKey, unionId, UNION_ID_CACHE_MAX);
    return unionId;
}

export async function getGroupFileSpaceId(
    config: DingTalkConfig,
    openConversationId: string,
    unionId: string,
    log?: Logger,
): Promise<string> {
    const cacheKey = `${config.clientId}:${openConversationId}`;
    const cached = lruGet(spaceIdCache, cacheKey);
    if (cached) {
        return cached;
    }

    const token = await getAccessToken(config, log);
    const resp = await axios.post(
        `${DINGTALK_API}/v1.0/convFile/conversations/spaces/query`,
        { openConversationId, unionId },
        { headers: { "x-acs-dingtalk-access-token": token } },
    );

    const spaceId = (resp.data as Record<string, any>)?.space?.spaceId as string;
    if (!spaceId) {
        throw new Error(`convFile spaces/query returned no spaceId for conversationId=${openConversationId}`);
    }

    lruSet(spaceIdCache, cacheKey, spaceId, SPACE_ID_CACHE_MAX);
    return spaceId;
}

interface DentryMatch {
    dentryId: string;
    name: string;
}

export interface ResolvedQuotedFile {
    media: MediaFile;
    spaceId: string;
    fileId: string;
    name?: string;
}

export async function findFileByTimestamp(
    config: DingTalkConfig,
    spaceId: string,
    unionId: string,
    createdAt: number,
    log?: Logger,
): Promise<DentryMatch | null> {
    const token = await getAccessToken(config, log);

    let bestMatch: DentryMatch | null = null;
    let bestDelta = Infinity;
    let nextToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
        const body: Record<string, any> = { option: { maxResults: PAGE_SIZE } };
        if (nextToken) {
            body.option.nextToken = nextToken;
        }

        const resp = await axios.post(
            `${DINGTALK_API}/v1.0/storage/spaces/${spaceId}/dentries/listAll?unionId=${unionId}`,
            body,
            { headers: { "x-acs-dingtalk-access-token": token } },
        );

        const data = resp.data as Record<string, any>;
        const dentries = (data.dentries || []) as Array<Record<string, any>>;

        for (const entry of dentries) {
            if (entry.type !== "FILE" || !entry.createTime) {
                continue;
            }
            try {
                const fileTime = parseDingTalkFileTime(entry.createTime as string);
                const delta = Math.abs(fileTime - createdAt);
                if (delta <= MATCH_WINDOW_MS && delta < bestDelta) {
                    bestDelta = delta;
                    bestMatch = { dentryId: entry.id as string, name: entry.name as string };
                }
            } catch {
                log?.debug?.(`[DingTalk][QuotedFile] Failed to parse createTime: ${entry.createTime}`);
            }
        }

        if (bestMatch && bestDelta < 1000) {
            break;
        }

        nextToken = data.nextToken as string | undefined;
        if (!nextToken) {
            break;
        }
    }

    return bestMatch;
}

export async function downloadGroupFile(
    config: DingTalkConfig,
    spaceId: string,
    dentryId: string,
    unionId: string,
    log?: Logger,
): Promise<MediaFile | null> {
    const rt = getDingTalkRuntime();
    const token = await getAccessToken(config, log);

    const infoResp = await axios.post(
        `${DINGTALK_API}/v1.0/storage/spaces/${spaceId}/dentries/${dentryId}/downloadInfos/query?unionId=${unionId}`,
        {},
        { headers: { "x-acs-dingtalk-access-token": token } },
    );

    const info = infoResp.data as Record<string, any>;
    const headerSig = info?.headerSignatureInfo;
    const resourceUrl = headerSig?.resourceUrls?.[0] as string | undefined;
    if (!resourceUrl) {
        log?.warn?.("[DingTalk][QuotedFile] downloadInfos/query returned no resourceUrl");
        return null;
    }

    const sigHeaders: Record<string, string> = {};
    if (headerSig?.headers) {
        for (const [k, v] of Object.entries(headerSig.headers)) {
            if (typeof v === "string") {
                sigHeaders[k] = v;
            }
        }
    }

    const fileResp = await axios.get(resourceUrl, {
        headers: sigHeaders,
        responseType: "arraybuffer",
    });

    const contentType = (fileResp.headers["content-type"] as string) || "application/octet-stream";
    const buffer = Buffer.from(fileResp.data as ArrayBuffer);

    const maxBytes =
        config.mediaMaxMb && config.mediaMaxMb > 0 ? config.mediaMaxMb * 1024 * 1024 : undefined;
    const saved = maxBytes
        ? await rt.channel.media.saveMediaBuffer(buffer, contentType, "inbound", maxBytes)
        : await rt.channel.media.saveMediaBuffer(buffer, contentType, "inbound");

    return { path: saved.path, mimeType: saved.contentType ?? contentType };
}

// ============ Composite entry point ============

export interface ResolveQuotedFileParams {
    openConversationId: string;
    senderStaffId?: string;
    fileCreatedAt?: number;
}

export async function resolveQuotedFile(
    config: DingTalkConfig,
    params: ResolveQuotedFileParams,
    log?: Logger,
): Promise<ResolvedQuotedFile | null> {
    const { openConversationId, senderStaffId, fileCreatedAt } = params;

    if (!senderStaffId || !fileCreatedAt) {
        log?.warn?.("[DingTalk][QuotedFile] Missing senderStaffId or fileCreatedAt, skipping");
        return null;
    }

    try {
        const unionId = await getUnionIdByStaffId(config, senderStaffId, log);
        const spaceId = await getGroupFileSpaceId(config, openConversationId, unionId, log);
        const match = await findFileByTimestamp(config, spaceId, unionId, fileCreatedAt, log);

        if (!match) {
            log?.warn?.(
                `[DingTalk][QuotedFile] No file matched within ±${MATCH_WINDOW_MS}ms window for createdAt=${fileCreatedAt}`,
            );
            return null;
        }

        log?.debug?.(
            `[DingTalk][QuotedFile] Matched file: dentryId=${match.dentryId} name=${match.name}`,
        );

        const media = await downloadGroupFile(config, spaceId, match.dentryId, unionId, log);
        if (!media) {
            return null;
        }
        return {
            media,
            spaceId,
            fileId: match.dentryId,
            name: match.name,
        };
    } catch (err: any) {
        if (log?.warn) {
            if (axios.isAxiosError(err) && err.response?.data !== undefined) {
                log.warn(formatDingTalkErrorPayloadLog("quotedFile.resolve", err.response.data));
            }
            log.warn(`[DingTalk][QuotedFile] Failed to resolve quoted file: ${err.message}`);
        }
        return null;
    }
}

// ============ Test helpers ============

export function clearQuotedFileServiceCachesForTest(): void {
    unionIdCache.clear();
    spaceIdCache.clear();
}
