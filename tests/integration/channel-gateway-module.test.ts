import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
    connectMock: vi.fn(),
    waitForStopMock: vi.fn(),
    stopMock: vi.fn(),
    isConnectedMock: vi.fn(),
    resolvePluginDebugLogMock: vi.fn(),
    cleanupOrphanedTempFilesMock: vi.fn(),
    closePluginDebugLogMock: vi.fn(),
}));

vi.mock("dingtalk-stream", () => ({
    TOPIC_CARD: "TOPIC_CARD",
    TOPIC_ROBOT: "TOPIC_ROBOT",
    DWClient: class {
        config: Record<string, unknown>;
        registerCallbackListener: (topic: string, cb: (res: unknown) => Promise<void>) => void;
        socketCallBackResponse: (messageId: string, payload: unknown) => void;
        connect: () => Promise<void>;
        disconnect: () => void;

        constructor(config: Record<string, unknown>) {
            this.config = config;
            this.registerCallbackListener = vi.fn();
            this.socketCallBackResponse = vi.fn();
            this.connect = vi.fn();
            this.disconnect = vi.fn();
        }
    },
}));

vi.mock("../../src/connection-manager", () => ({
    ConnectionManager: class {
        connect: () => Promise<void>;
        waitForStop: () => Promise<void>;
        stop: () => void;
        isConnected: () => boolean;

        constructor() {
            this.connect = shared.connectMock;
            this.waitForStop = shared.waitForStopMock;
            this.stop = shared.stopMock;
            this.isConnected = shared.isConnectedMock;
        }
    },
}));

vi.mock("../../src/utils", async () => {
    const actual = await vi.importActual<typeof import("../../src/utils")>("../../src/utils");
    return {
        ...actual,
        resolvePluginDebugLog: shared.resolvePluginDebugLogMock,
        cleanupOrphanedTempFiles: shared.cleanupOrphanedTempFilesMock,
        closePluginDebugLog: shared.closePluginDebugLogMock,
    };
});

import {
    CHANNEL_INFLIGHT_NAMESPACE_POLICY,
    createDingTalkGateway,
} from "../../src/gateway/channel-gateway";

describe("createDingTalkGateway", () => {
    beforeEach(() => {
        shared.connectMock.mockReset().mockResolvedValue(undefined);
        shared.waitForStopMock.mockReset().mockResolvedValue(undefined);
        shared.stopMock.mockReset();
        shared.isConnectedMock.mockReset().mockReturnValue(true);
        shared.resolvePluginDebugLogMock.mockReset().mockImplementation(({ baseLog }: any) => baseLog);
        shared.cleanupOrphanedTempFilesMock.mockReset();
        shared.closePluginDebugLogMock.mockReset();
    });

    it("exports the memory-only inflight namespace policy", () => {
        expect(CHANNEL_INFLIGHT_NAMESPACE_POLICY).toBe("memory-only");
    });

    it("fails fast when account credentials are missing", async () => {
        const gateway = createDingTalkGateway();

        await expect(
            gateway.startAccount?.({
                cfg: {},
                account: { accountId: "main", config: { clientId: "id" } },
                log: {
                    info: vi.fn(),
                    warn: vi.fn(),
                    error: vi.fn(),
                    debug: vi.fn(),
                },
                getStatus: () => ({}),
                setStatus: vi.fn(),
            } as any),
        ).rejects.toThrow("DingTalk clientId and clientSecret are required");
    });
});
