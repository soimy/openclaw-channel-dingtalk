import axios from "axios";
import { getAccessToken } from "../auth";
import { formatDingTalkErrorPayloadLog, getProxyBypassOption } from "../utils";
import type { DingTalkConfig, Logger } from "../types";

export interface DingTalkUserDetail {
    userid: string;
    name: string;
    mobile?: string;
    dept_id_list?: number[];
    title?: string;
}

interface UserDetailCacheEntry {
    user: DingTalkUserDetail;
    cachedAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_PAGE_SIZE = 20;

const userDetailCache = new Map<string, UserDetailCacheEntry>();

function isCacheValid(entry: UserDetailCacheEntry): boolean {
    return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

export function clearDirectoryLiveCache(): void {
    userDetailCache.clear();
}

async function searchUserIds(
    config: DingTalkConfig,
    query: string,
    log?: Logger,
): Promise<string[]> {
    try {
        const token = await getAccessToken(config, log);
        const response = await axios({
            url: "https://api.dingtalk.com/v1.0/contact/users/search",
            method: "POST",
            headers: {
                "x-acs-dingtalk-access-token": token,
                "Content-Type": "application/json",
            },
            data: { queryWord: query, offset: 0, size: SEARCH_PAGE_SIZE },
            ...getProxyBypassOption(config),
        });
        const list = response.data?.list;
        return Array.isArray(list) ? list.filter((id: unknown) => typeof id === "string") : [];
    } catch (err: unknown) {
        const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
        if (axiosErr.response?.status === 403 || axiosErr.response?.status === 401) {
            log?.debug?.(
                `[DingTalk][DirectoryLive] Contact search permission denied (${axiosErr.response.status}), skipping`,
            );
            return [];
        }
        log?.warn?.(
            `[DingTalk][DirectoryLive] Contact search failed: ${axiosErr.message || String(err)}`,
        );
        if (axiosErr.response?.data !== undefined) {
            log?.warn?.(formatDingTalkErrorPayloadLog("directory.search", axiosErr.response.data));
        }
        return [];
    }
}

async function fetchUserDetail(
    config: DingTalkConfig,
    userid: string,
    log?: Logger,
): Promise<DingTalkUserDetail | null> {
    const cached = userDetailCache.get(userid);
    if (cached && isCacheValid(cached)) {
        return cached.user;
    }

    try {
        const token = await getAccessToken(config, log);
        const response = await axios({
            url: `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${token}`,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            data: { userid },
            ...getProxyBypassOption(config),
        });

        if (response.data?.errcode === 0 && response.data?.result) {
            const user: DingTalkUserDetail = {
                userid: response.data.result.userid,
                name: response.data.result.name,
                mobile: response.data.result.mobile,
                dept_id_list: response.data.result.dept_id_list,
                title: response.data.result.title,
            };
            userDetailCache.set(userid, { user, cachedAt: Date.now() });
            return user;
        }

        log?.warn?.(
            `[DingTalk][DirectoryLive] User detail query returned unexpected result for ${userid}`,
        );
        if (response.data !== undefined) {
            log?.warn?.(formatDingTalkErrorPayloadLog("directory.userGet", response.data));
        }
        return null;
    } catch (err: unknown) {
        const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
        log?.warn?.(
            `[DingTalk][DirectoryLive] User detail fetch failed for ${userid}: ${axiosErr.message || String(err)}`,
        );
        if (axiosErr.response?.data !== undefined) {
            log?.warn?.(formatDingTalkErrorPayloadLog("directory.userGet", axiosErr.response.data));
        }
        return null;
    }
}

/**
 * Search DingTalk contacts by name, returning only exact-match results.
 * Results are cached for 24 hours per userId.
 */
export async function searchDingTalkUsers(
    config: DingTalkConfig,
    query: string,
    log?: Logger,
    limit?: number,
): Promise<DingTalkUserDetail[]> {
    const trimmed = query.trim();
    if (!trimmed) {
        return [];
    }

    const userIds = await searchUserIds(config, trimmed, log);
    if (userIds.length === 0) {
        return [];
    }

    const details = await Promise.all(
        userIds.map((uid) => fetchUserDetail(config, uid, log)),
    );

    const exactMatches = details.filter(
        (user): user is DingTalkUserDetail => user !== null && user.name === trimmed,
    );

    if (limit && limit > 0) {
        return exactMatches.slice(0, limit);
    }
    return exactMatches;
}

/**
 * Resolve a list of display names to DingTalk userIds via contact search.
 * Used by the message send action's `at` parameter.
 * Names that cannot be resolved are silently skipped.
 */
export async function resolveAtMentionUserIds(
    config: DingTalkConfig,
    names: string[],
    log?: Logger,
): Promise<string[]> {
    const resolvedIds: string[] = [];

    for (const name of names) {
        const trimmed = name.trim();
        if (!trimmed) {
            continue;
        }
        const matches = await searchDingTalkUsers(config, trimmed, log, 1);
        if (matches.length > 0) {
            resolvedIds.push(matches[0].userid);
        } else {
            log?.debug?.(
                `[DingTalk][DirectoryLive] Could not resolve @mention "${trimmed}", skipping`,
            );
        }
    }

    return resolvedIds;
}
