import { describe, expect, it, vi, beforeEach } from "vitest";

const mockedAxiosCall = vi.fn();
vi.mock("axios", () => {
    const fn = (...args: any[]) => mockedAxiosCall(...args);
    fn.isAxiosError = () => false;
    return { default: fn };
});
vi.mock("../../src/auth", () => ({
    getAccessToken: vi.fn().mockResolvedValue("test_token"),
}));

import {
    searchDingTalkUsers,
    resolveAtMentionUserIds,
    clearDirectoryLiveCache,
} from "../../src/targeting/directory-live-service";

describe("directory-live-service", () => {
    beforeEach(() => {
        mockedAxiosCall.mockReset();
        clearDirectoryLiveCache();
    });

    const config = { clientId: "test_app", clientSecret: "test_secret" } as any;

    it("returns exact-match users from search results", async () => {
        mockedAxiosCall.mockResolvedValueOnce({
            data: { list: ["uid_1", "uid_2"], totalCount: 2, hasMore: false },
        });
        mockedAxiosCall.mockResolvedValueOnce({
            data: { errcode: 0, result: { userid: "uid_1", name: "朱敏", dept_id_list: [1] } },
        });
        mockedAxiosCall.mockResolvedValueOnce({
            data: { errcode: 0, result: { userid: "uid_2", name: "朱倩宇", dept_id_list: [2] } },
        });

        const result = await searchDingTalkUsers(config, "朱敏");

        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("朱敏");
        expect(result[0].userid).toBe("uid_1");
    });

    it("returns empty array when no exact match found", async () => {
        mockedAxiosCall.mockResolvedValueOnce({
            data: { list: ["uid_1"], totalCount: 1, hasMore: false },
        });
        mockedAxiosCall.mockResolvedValueOnce({
            data: { errcode: 0, result: { userid: "uid_1", name: "朱倩宇", dept_id_list: [1] } },
        });

        const result = await searchDingTalkUsers(config, "朱敏");

        expect(result).toHaveLength(0);
    });

    it("returns empty array when search API returns no results", async () => {
        mockedAxiosCall.mockResolvedValueOnce({
            data: { list: [], totalCount: 0, hasMore: false },
        });

        const result = await searchDingTalkUsers(config, "不存在的人");

        expect(result).toHaveLength(0);
    });

    it("returns empty array silently on 403 permission error", async () => {
        mockedAxiosCall.mockRejectedValueOnce({
            response: { status: 403, data: { code: "Forbidden" } },
            message: "Request failed with status code 403",
        });

        const result = await searchDingTalkUsers(config, "朱敏");

        expect(result).toHaveLength(0);
    });

    it("returns empty array for empty query", async () => {
        const result = await searchDingTalkUsers(config, "   ");

        expect(result).toHaveLength(0);
        expect(mockedAxiosCall).not.toHaveBeenCalled();
    });

    it("uses cached user detail on second call", async () => {
        mockedAxiosCall.mockResolvedValueOnce({
            data: { list: ["uid_1"], totalCount: 1, hasMore: false },
        });
        mockedAxiosCall.mockResolvedValueOnce({
            data: { errcode: 0, result: { userid: "uid_1", name: "朱敏", dept_id_list: [1] } },
        });

        await searchDingTalkUsers(config, "朱敏");

        mockedAxiosCall.mockResolvedValueOnce({
            data: { list: ["uid_1"], totalCount: 1, hasMore: false },
        });

        const result = await searchDingTalkUsers(config, "朱敏");

        expect(result).toHaveLength(1);
        expect(mockedAxiosCall).toHaveBeenCalledTimes(3);
    });

    describe("resolveAtMentionUserIds", () => {
        it("resolves names to userIds", async () => {
            mockedAxiosCall.mockResolvedValueOnce({
                data: { list: ["uid_zs"], totalCount: 1, hasMore: false },
            });
            mockedAxiosCall.mockResolvedValueOnce({
                data: { errcode: 0, result: { userid: "uid_zs", name: "张三", dept_id_list: [1] } },
            });

            const ids = await resolveAtMentionUserIds(config, ["张三"]);

            expect(ids).toEqual(["uid_zs"]);
        });

        it("skips unresolvable names silently", async () => {
            mockedAxiosCall.mockResolvedValueOnce({
                data: { list: [], totalCount: 0, hasMore: false },
            });

            const ids = await resolveAtMentionUserIds(config, ["不存在"]);

            expect(ids).toEqual([]);
        });

        it("resolves multiple names", async () => {
            mockedAxiosCall.mockResolvedValueOnce({
                data: { list: ["uid_zs"], totalCount: 1, hasMore: false },
            });
            mockedAxiosCall.mockResolvedValueOnce({
                data: { errcode: 0, result: { userid: "uid_zs", name: "张三", dept_id_list: [1] } },
            });
            mockedAxiosCall.mockResolvedValueOnce({
                data: { list: ["uid_ls"], totalCount: 1, hasMore: false },
            });
            mockedAxiosCall.mockResolvedValueOnce({
                data: { errcode: 0, result: { userid: "uid_ls", name: "李四", dept_id_list: [1] } },
            });

            const ids = await resolveAtMentionUserIds(config, ["张三", "李四"]);

            expect(ids).toEqual(["uid_zs", "uid_ls"]);
        });

        it("skips empty names without calling API", async () => {
            const ids = await resolveAtMentionUserIds(config, ["", "  "]);

            expect(ids).toEqual([]);
        });
    });
});
