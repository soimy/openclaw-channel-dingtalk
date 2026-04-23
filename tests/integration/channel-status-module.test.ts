import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
    getAccessTokenMock: vi.fn(),
}));

vi.mock("../../src/auth", () => ({
    getAccessToken: shared.getAccessTokenMock,
}));

import { createDingTalkStatus } from "../../src/platform/channel-status";

describe("createDingTalkStatus", () => {
    beforeEach(() => {
        shared.getAccessTokenMock.mockReset().mockResolvedValue("token_abc");
    });

    it("probes configured accounts through getAccessToken", async () => {
        const status = createDingTalkStatus();
        const account = {
            accountId: "main",
            configured: true,
            config: { clientId: "id", clientSecret: "sec" },
        };

        const result = await status.probeAccount?.({
            account,
            timeoutMs: 1000,
        } as any);

        expect(shared.getAccessTokenMock).toHaveBeenCalledWith(account.config);
        expect(result).toEqual({
            ok: true,
            details: { clientId: "id" },
        });
    });
});
