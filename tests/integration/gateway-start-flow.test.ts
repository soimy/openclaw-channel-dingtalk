import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
    connectMock: vi.fn(),
    waitForStopMock: vi.fn(),
    stopMock: vi.fn(),
    isConnectedMock: vi.fn(),
    cleanupOrphanedTempFilesMock: vi.fn(),
    connectionConfig: undefined as any,
}));

vi.mock('openclaw/plugin-sdk', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('dingtalk-stream', () => ({
    TOPIC_ROBOT: 'TOPIC_ROBOT',
    DWClient: class {
        config: Record<string, unknown>;
        registerCallbackListener: (topic: string, cb: (res: unknown) => Promise<void>) => void;
        socketCallBackResponse: (messageId: string, payload: unknown) => void;

        constructor() {
            this.config = {};
            this.registerCallbackListener = vi.fn();
            this.socketCallBackResponse = vi.fn();
        }
    },
}));

vi.mock('../../src/connection-manager', () => ({
    ConnectionManager: class {
        connect: () => Promise<void>;
        waitForStop: () => Promise<void>;
        stop: () => void;
        isConnected: () => boolean;

        constructor(_client: unknown, _accountId: string, config: unknown) {
            shared.connectionConfig = config;
            this.connect = shared.connectMock;
            this.waitForStop = shared.waitForStopMock;
            this.stop = shared.stopMock;
            this.isConnected = shared.isConnectedMock;
        }
    },
}));

vi.mock('../../src/utils', async () => {
    const actual = await vi.importActual<typeof import('../../src/utils')>('../../src/utils');
    return {
        ...actual,
        cleanupOrphanedTempFiles: shared.cleanupOrphanedTempFilesMock,
    };
});

import { dingtalkPlugin } from '../../src/channel';

function createStartContext(abortSignal?: AbortSignal) {
    let status = {
        accountId: 'main',
        running: false,
        lastStartAt: null as number | null,
        lastStopAt: null as number | null,
        lastError: null as string | null,
    };

    const setStatusCalls: Array<typeof status> = [];

    return {
        ctx: {
            cfg: {},
            account: {
                accountId: 'main',
                config: { clientId: 'ding_id', clientSecret: 'ding_secret' },
            },
            abortSignal,
            log: {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            },
            getStatus: () => status,
            setStatus: (next: typeof status) => {
                status = next;
                setStatusCalls.push(next);
            },
        },
        setStatusCalls,
    };
}

describe('gateway.startAccount lifecycle', () => {
    beforeEach(() => {
        shared.connectMock.mockReset();
        shared.waitForStopMock.mockReset();
        shared.stopMock.mockReset();
        shared.isConnectedMock.mockReset();
        shared.cleanupOrphanedTempFilesMock.mockReset();
        shared.connectionConfig = undefined;

        shared.connectMock.mockResolvedValue(undefined);
        shared.waitForStopMock.mockResolvedValue(undefined);
        shared.isConnectedMock.mockReturnValue(true);
    });

    it('fails fast when abortSignal is already aborted before start', async () => {
        const controller = new AbortController();
        controller.abort();
        const { ctx, setStatusCalls } = createStartContext(controller.signal);

        await expect(dingtalkPlugin.gateway.startAccount(ctx as any)).rejects.toThrow('Connection aborted before start');

        expect(shared.connectMock).not.toHaveBeenCalled();
        expect(setStatusCalls.some((s) => s.lastError === 'Connection aborted before start')).toBe(true);
    });

    it('connects, waits for stop, and executes stop callback', async () => {
        const { ctx, setStatusCalls } = createStartContext();

        const stopResult = await dingtalkPlugin.gateway.startAccount(ctx as any);

        expect(shared.cleanupOrphanedTempFilesMock).toHaveBeenCalledTimes(1);
        expect(shared.connectMock).toHaveBeenCalledTimes(1);
        expect(shared.waitForStopMock).toHaveBeenCalledTimes(1);
        expect(setStatusCalls.some((s) => s.running === true && s.lastStartAt !== null)).toBe(true);

        stopResult.stop();

        expect(shared.stopMock).toHaveBeenCalledTimes(1);
        expect(setStatusCalls.some((s) => s.running === false && s.lastStopAt !== null)).toBe(true);
    });

    it('handles abort signal by stopping connection manager and setting stopped status', async () => {
        const controller = new AbortController();
        const { ctx, setStatusCalls } = createStartContext(controller.signal);

        shared.connectMock.mockImplementation(async () => {
            controller.abort();
        });
        shared.isConnectedMock.mockReturnValue(false);

        const result = await dingtalkPlugin.gateway.startAccount(ctx as any);

        expect(shared.stopMock).toHaveBeenCalledTimes(1);
        expect(setStatusCalls.some((s) => s.running === false && s.lastStopAt !== null)).toBe(true);

        result.stop();
        expect(shared.stopMock).toHaveBeenCalledTimes(1);
    });

    it('passes maxReconnectCycles from account config to connection manager', async () => {
        const { ctx } = createStartContext();
        ctx.account.config = {
            clientId: 'ding_id',
            clientSecret: 'ding_secret',
            maxReconnectCycles: 7,
        } as any;

        await dingtalkPlugin.gateway.startAccount(ctx as any);

        expect(shared.connectionConfig).toMatchObject({
            maxReconnectCycles: 7,
        });
    });
});
