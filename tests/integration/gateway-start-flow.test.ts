import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
    connectMock: vi.fn(),
    waitForStopMock: vi.fn(),
    stopMock: vi.fn(),
    isConnectedMock: vi.fn(),
    cleanupOrphanedTempFilesMock: vi.fn(),
    connectionConfig: undefined as any,
    clientGetEndpointMock: vi.fn(),
    clientConnectMock: vi.fn(),
    clientDisconnectMock: vi.fn(),
    dwClientConfig: undefined as any,
    httpReceiverCloseMock: vi.fn(),
    startHttpReceiverMock: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('dingtalk-stream', () => ({
    TOPIC_CARD: 'TOPIC_CARD',
    TOPIC_ROBOT: 'TOPIC_ROBOT',
    DWClient: class {
        config: Record<string, unknown>;
        getEndpoint: () => Promise<void>;
        _connect: () => Promise<void>;
        connect: () => Promise<void>;
        disconnect: () => void;
        registerCallbackListener: (topic: string, cb: (res: unknown) => Promise<void>) => void;
        socketCallBackResponse: (messageId: string, payload: unknown) => void;

        constructor(config: Record<string, unknown>) {
            this.config = config;
            shared.dwClientConfig = this.config;
            this.getEndpoint = async () => {
                this.config.endpoint = { endpoint: 'wss://wss-open-connection.dingtalk.com:443/connect' };
                await shared.clientGetEndpointMock();
            };
            this._connect = shared.clientConnectMock;
            this.connect = async () => {
                await this.getEndpoint();
                await this._connect();
            };
            this.disconnect = shared.clientDisconnectMock;
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

vi.mock('../../src/http-receiver', () => ({
    startHttpReceiver: shared.startHttpReceiverMock,
}));

import { dingtalkPlugin } from '../../src/channel';

const startGatewayAccount = (ctx: any): Promise<any> => dingtalkPlugin.gateway!.startAccount!(ctx as any);

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
        shared.clientGetEndpointMock.mockReset();
        shared.clientConnectMock.mockReset();
        shared.clientDisconnectMock.mockReset();
        shared.dwClientConfig = undefined;
        shared.httpReceiverCloseMock.mockReset();
        shared.startHttpReceiverMock.mockReset();

        shared.connectMock.mockResolvedValue(undefined);
        shared.waitForStopMock.mockResolvedValue(undefined);
        shared.isConnectedMock.mockReturnValue(true);
        shared.clientGetEndpointMock.mockResolvedValue(undefined);
        shared.clientConnectMock.mockResolvedValue(undefined);
        shared.startHttpReceiverMock.mockReturnValue({
            close: shared.httpReceiverCloseMock,
        });
    });

    it('fails fast when abortSignal is already aborted before start', async () => {
        const controller = new AbortController();
        controller.abort();
        const { ctx, setStatusCalls } = createStartContext(controller.signal);

        await expect(startGatewayAccount(ctx as any)).rejects.toThrow('Connection aborted before start');

        expect(shared.connectMock).not.toHaveBeenCalled();
        expect(setStatusCalls.some((s) => s.lastError === 'Connection aborted before start')).toBe(true);
    });

    it('connects, waits for stop, and executes stop callback', async () => {
        const { ctx, setStatusCalls } = createStartContext();

        const stopResult = await startGatewayAccount(ctx as any);

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

        const result = await startGatewayAccount(ctx as any);

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

        await startGatewayAccount(ctx as any);

        expect(shared.connectionConfig).toMatchObject({
            maxReconnectCycles: 7,
        });
    });

    it('uses DWClient native heartbeat and reconnect when useConnectionManager is false', async () => {
        const controller = new AbortController();
        const { ctx, setStatusCalls } = createStartContext(controller.signal);
        ctx.account.config = {
            clientId: 'ding_id',
            clientSecret: 'ding_secret',
            useConnectionManager: false,
        } as any;
        shared.clientConnectMock.mockImplementation(async () => {
            controller.abort();
        });

        const stopResult = await startGatewayAccount(ctx as any);

        expect(shared.connectMock).not.toHaveBeenCalled();
        expect(shared.connectionConfig).toBeUndefined();
        expect(shared.clientConnectMock).toHaveBeenCalledTimes(1);
        expect(shared.dwClientConfig).toMatchObject({
            keepAlive: true,
            autoReconnect: true,
        });
        expect(setStatusCalls.some((s) => s.running === false && s.lastStopAt !== null)).toBe(true);

        stopResult.stop();
        expect(shared.clientDisconnectMock).toHaveBeenCalledTimes(1);
        expect(shared.stopMock).not.toHaveBeenCalled();
    });

    it('labels websocket-stage failures when native connect fails after open succeeds', async () => {
        const { ctx } = createStartContext();
        ctx.account.config = {
            clientId: 'ding_id',
            clientSecret: 'ding_secret',
            useConnectionManager: false,
        } as any;
        shared.clientConnectMock.mockRejectedValue(new Error('Unexpected server response: 400'));

        await expect(startGatewayAccount(ctx as any)).rejects.toThrow('Unexpected server response: 400');

        expect(shared.clientGetEndpointMock).toHaveBeenCalledTimes(1);
        expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining('[DingTalk][ConnectionError][connect.websocket]'));
        expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining('wss-open-connection.dingtalk.com'));
    });

    it('warns and falls back to markdown when http mode is configured with card replies', async () => {
        const { ctx, setStatusCalls } = createStartContext();
        ctx.account.config = {
            clientId: 'ding_id',
            clientSecret: 'ding_secret',
            mode: 'http',
            messageType: 'card',
            cardTemplateId: 'template-id',
        } as any;

        const stopResult = await startGatewayAccount(ctx as any);

        expect(shared.startHttpReceiverMock).toHaveBeenCalledTimes(1);
        expect(shared.startHttpReceiverMock).toHaveBeenCalledWith(
            expect.objectContaining({
                dingtalkConfig: expect.objectContaining({
                    mode: 'http',
                    messageType: 'markdown',
                    cardTemplateId: 'template-id',
                }),
            })
        );
        expect(ctx.log.warn).toHaveBeenCalledWith(
            expect.stringContaining('HTTP mode does not support AI card replies yet; falling back to markdown')
        );
        expect(shared.connectMock).not.toHaveBeenCalled();
        expect(shared.clientConnectMock).not.toHaveBeenCalled();
        expect(setStatusCalls.some((s) => s.running === true && s.lastStartAt !== null)).toBe(true);

        await stopResult.stop();

        expect(shared.httpReceiverCloseMock).toHaveBeenCalledTimes(1);
        expect(setStatusCalls.some((s) => s.running === false && s.lastStopAt !== null)).toBe(true);
    });

    it('fails fast when multiple http-mode accounts share the same port', async () => {
        const { ctx, setStatusCalls } = createStartContext();
        ctx.cfg = {
            channels: {
                dingtalk: {
                    accounts: {
                        main: {
                            clientId: 'ding_id',
                            clientSecret: 'ding_secret',
                            mode: 'http',
                            httpPort: 3000,
                        },
                        backup: {
                            clientId: 'ding_id_backup',
                            clientSecret: 'ding_secret_backup',
                            mode: 'http',
                            httpPort: 3000,
                        },
                    },
                },
            },
        };
        ctx.account.config = {
            clientId: 'ding_id',
            clientSecret: 'ding_secret',
            mode: 'http',
            httpPort: 3000,
        } as any;

        await expect(startGatewayAccount(ctx as any)).rejects.toThrow(
            'HTTP mode port conflict on 3000: accounts main, backup must use distinct httpPort values'
        );

        expect(shared.startHttpReceiverMock).not.toHaveBeenCalled();
        expect(setStatusCalls.some((s) => s.lastError === null)).toBe(false);
    });

    it('treats omitted httpPort as default 3000 when checking http-mode conflicts', async () => {
        const { ctx } = createStartContext();
        ctx.cfg = {
            channels: {
                dingtalk: {
                    accounts: {
                        main: {
                            clientId: 'ding_id',
                            clientSecret: 'ding_secret',
                            mode: 'http',
                        },
                        backup: {
                            clientId: 'ding_id_backup',
                            clientSecret: 'ding_secret_backup',
                            mode: 'http',
                            httpPort: 3000,
                        },
                    },
                },
            },
        };
        ctx.account.config = {
            clientId: 'ding_id',
            clientSecret: 'ding_secret',
            mode: 'http',
        } as any;

        await expect(startGatewayAccount(ctx as any)).rejects.toThrow(
            'HTTP mode port conflict on 3000: accounts main, backup must use distinct httpPort values'
        );

        expect(shared.startHttpReceiverMock).not.toHaveBeenCalled();
    });
});
