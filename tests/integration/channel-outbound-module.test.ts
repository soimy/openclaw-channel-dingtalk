import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
    sendMessageMock: vi.fn(),
    sendMediaMock: vi.fn(),
    getRuntimeMock: vi.fn(),
    getLoggerMock: vi.fn(),
    getConfigMock: vi.fn(),
}));

vi.mock("../../src/send-service", () => ({
    sendMessage: shared.sendMessageMock,
    sendMedia: shared.sendMediaMock,
}));

vi.mock("../../src/runtime", () => ({
    getDingTalkRuntime: shared.getRuntimeMock,
}));

vi.mock("../../src/logger-context", () => ({
    getLogger: shared.getLoggerMock,
}));

vi.mock("../../src/config", () => ({
    getConfig: shared.getConfigMock,
}));

import { createDingTalkOutbound } from "../../src/messaging/channel-outbound";

describe("createDingTalkOutbound", () => {
    beforeEach(() => {
        shared.sendMessageMock.mockReset().mockResolvedValue({
            ok: true,
            data: { processQueryKey: "text_1" },
        });
        shared.sendMediaMock.mockReset().mockResolvedValue({
            ok: true,
            messageId: "media_1",
            data: { messageId: "media_1" },
        });
        shared.getRuntimeMock.mockReset().mockReturnValue({
            channel: {
                session: {
                    resolveStorePath: vi.fn().mockReturnValue("/tmp/store.json"),
                },
            },
        });
        shared.getLoggerMock.mockReset().mockReturnValue(undefined);
        shared.getConfigMock.mockReset().mockReturnValue({ clientId: "id", clientSecret: "sec" });
    });

    it("routes outbound sendText through sendMessage with persisted store context", async () => {
        const outbound = createDingTalkOutbound();

        const result = await outbound.sendText?.({
            cfg: {} as any,
            to: "cidA1B2C3",
            text: "hello",
            accountId: "main",
            log: undefined,
        } as any);

        expect(shared.sendMessageMock).toHaveBeenCalledWith(
            expect.any(Object),
            "cidA1B2C3",
            "hello",
            expect.objectContaining({
                accountId: "main",
                storePath: "/tmp/store.json",
                conversationId: "cidA1B2C3",
            }),
        );
        expect(result).toMatchObject({
            channel: "dingtalk",
            messageId: "text_1",
        });
    });
});
