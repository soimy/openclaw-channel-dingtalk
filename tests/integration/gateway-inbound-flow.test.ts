import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
    connectMock: vi.fn(),
    waitForStopMock: vi.fn(),
    stopMock: vi.fn(),
    isConnectedMock: vi.fn(),
    listener: undefined as undefined | ((res: any) => Promise<void>),
    socketCallBackResponseMock: vi.fn(),
    isMessageProcessedMock: vi.fn(),
    markMessageProcessedMock: vi.fn(),
    handleDingTalkMessageMock: vi.fn(),
    connectionConfig: undefined as any,
}));

vi.mock('openclaw/plugin-sdk', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('dingtalk-stream', () => ({
    TOPIC_ROBOT: 'TOPIC_ROBOT',
    DWClient: class {
        config: Record<string, unknown>;
        registerCallbackListener: (topic: string, cb: (res: any) => Promise<void>) => void;
        socketCallBackResponse: (messageId: string, payload: unknown) => void;

        constructor() {
            this.config = {};
            this.registerCallbackListener = vi.fn((_topic: string, cb: (res: any) => Promise<void>) => {
                shared.listener = cb;
            });
            this.socketCallBackResponse = shared.socketCallBackResponseMock;
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

vi.mock('../../src/dedup', () => ({
    isMessageProcessed: shared.isMessageProcessedMock,
    markMessageProcessed: shared.markMessageProcessedMock,
}));

vi.mock('../../src/inbound-handler', () => ({
    handleDingTalkMessage: shared.handleDingTalkMessageMock,
}));

import { dingtalkPlugin } from '../../src/channel';

const startGatewayAccount = (ctx: any) => dingtalkPlugin.gateway!.startAccount!(ctx);

function createStartContext() {
    let status = {
        accountId: 'main',
        running: false,
        lastStartAt: null as number | null,
        lastStopAt: null as number | null,
        lastError: null as string | null,
    };

    return {
        cfg: {},
        account: {
            accountId: 'main',
            config: { clientId: 'ding_id', clientSecret: 'ding_secret', robotCode: 'robot_1' },
        },
        log: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        },
        getStatus: () => status,
        setStatus: (next: typeof status) => {
            status = next;
        },
    };
}

describe('gateway inbound callback pipeline', () => {
    beforeEach(() => {
        shared.connectMock.mockReset();
        shared.waitForStopMock.mockReset();
        shared.stopMock.mockReset();
        shared.isConnectedMock.mockReset();
        shared.socketCallBackResponseMock.mockReset();
        shared.isMessageProcessedMock.mockReset();
        shared.markMessageProcessedMock.mockReset();
        shared.handleDingTalkMessageMock.mockReset();
        shared.connectionConfig = undefined;

        shared.listener = undefined;
        shared.connectMock.mockResolvedValue(undefined);
        shared.waitForStopMock.mockResolvedValue(undefined);
        shared.isConnectedMock.mockReturnValue(false);
    });

    it('acknowledges callback after successful dispatch for non-duplicate message', async () => {
        shared.isMessageProcessedMock.mockReturnValue(false);
        const ctx = createStartContext();

        await startGatewayAccount(ctx as any);

        expect(shared.listener).toBeTypeOf('function');

        await shared.listener?.({
            headers: { messageId: 'stream_msg_1' },
            data: JSON.stringify({
                msgId: 'msg_1',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cidA1B2C3',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://webhook',
            }),
        });

        expect(shared.socketCallBackResponseMock).toHaveBeenCalledTimes(1);
        expect(shared.socketCallBackResponseMock).toHaveBeenCalledWith('stream_msg_1', { success: true });
        expect(shared.markMessageProcessedMock).toHaveBeenCalledWith('robot_1:msg_1');
        expect(shared.handleDingTalkMessageMock).toHaveBeenCalledTimes(1);
        expect(shared.handleDingTalkMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({
                accountId: 'main',
                sessionWebhook: 'https://webhook',
            })
        );
    });

    it('skips duplicate message dispatch when dedup indicates already processed', async () => {
        shared.isMessageProcessedMock.mockReturnValue(true);
        const ctx = createStartContext();

        await startGatewayAccount(ctx as any);

        await shared.listener?.({
            headers: { messageId: 'stream_msg_2' },
            data: JSON.stringify({
                msgId: 'msg_2',
                msgtype: 'text',
                text: { content: 'hello duplicate' },
                conversationType: '1',
                conversationId: 'cidA1B2C3',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://webhook',
            }),
        });

        expect(shared.markMessageProcessedMock).not.toHaveBeenCalled();
        expect(shared.handleDingTalkMessageMock).not.toHaveBeenCalled();
        expect(ctx.log.info).toHaveBeenCalledWith(
            expect.stringContaining('Inbound counters (dedup-skipped)')
        );
    });

    it('does not mark dedup when handler fails, allowing retries', async () => {
        shared.isMessageProcessedMock.mockReturnValue(false);
        shared.handleDingTalkMessageMock
            .mockRejectedValueOnce(new Error('transient failure'))
            .mockResolvedValueOnce(undefined);
        const ctx = createStartContext();

        await startGatewayAccount(ctx as any);

        const payload = {
            headers: { messageId: 'stream_msg_retry' },
            data: JSON.stringify({
                msgId: 'msg_retry',
                msgtype: 'text',
                text: { content: 'retry me' },
                conversationType: '1',
                conversationId: 'cidA1B2C3',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://webhook',
            }),
        };

        await shared.listener?.(payload);
        expect(shared.markMessageProcessedMock).not.toHaveBeenCalled();
        expect(shared.socketCallBackResponseMock).not.toHaveBeenCalled();
        expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining('Inbound counters (failed)'));

        await shared.listener?.(payload);
        expect(shared.handleDingTalkMessageMock).toHaveBeenCalledTimes(2);
        expect(shared.markMessageProcessedMock).toHaveBeenCalledTimes(1);
        expect(shared.markMessageProcessedMock).toHaveBeenCalledWith('robot_1:msg_retry');
        expect(shared.socketCallBackResponseMock).toHaveBeenCalledTimes(1);
        expect(shared.socketCallBackResponseMock).toHaveBeenCalledWith('stream_msg_retry', { success: true });
    });

    it('does not acknowledge malformed payloads when parse fails', async () => {
        shared.isMessageProcessedMock.mockReturnValue(false);
        const ctx = createStartContext();

        await startGatewayAccount(ctx as any);

        await shared.listener?.({
            headers: { messageId: 'stream_msg_bad' },
            data: '{"msgId":',
        });

        expect(shared.socketCallBackResponseMock).not.toHaveBeenCalled();
        expect(shared.handleDingTalkMessageMock).not.toHaveBeenCalled();
        expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining('Inbound counters (failed)'));
    });

    it('skips concurrent in-flight duplicate callbacks for same message without acking the duplicate', async () => {
        shared.isMessageProcessedMock.mockReturnValue(false);
        let resolveFirst: (() => void) | undefined;
        shared.handleDingTalkMessageMock.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveFirst = resolve;
                })
        );
        const ctx = createStartContext();

        await startGatewayAccount(ctx as any);

        const payloadData = JSON.stringify({
            msgId: 'msg_inflight',
            msgtype: 'text',
            text: { content: 'in flight' },
            conversationType: '1',
            conversationId: 'cidA1B2C3',
            senderId: 'user_1',
            chatbotUserId: 'bot_1',
            sessionWebhook: 'https://webhook',
        });

        const first = shared.listener?.({
            headers: { messageId: 'stream_msg_inflight_1' },
            data: payloadData,
        });
        const second = shared.listener?.({
            headers: { messageId: 'stream_msg_inflight_2' },
            data: payloadData,
        });

        await Promise.resolve();
        expect(shared.handleDingTalkMessageMock).toHaveBeenCalledTimes(1);
        expect(shared.markMessageProcessedMock).not.toHaveBeenCalled();

        resolveFirst?.();
        await first;
        await second;

        expect(shared.markMessageProcessedMock).toHaveBeenCalledTimes(1);
        expect(shared.markMessageProcessedMock).toHaveBeenCalledWith('robot_1:msg_inflight');
        expect(shared.socketCallBackResponseMock).toHaveBeenCalledTimes(1);
        expect(shared.socketCallBackResponseMock).toHaveBeenCalledWith('stream_msg_inflight_1', { success: true });
        expect(shared.socketCallBackResponseMock).not.toHaveBeenCalledWith('stream_msg_inflight_2', { success: true });
    });

    it('releases stale in-flight lock after ttl and allows reprocessing', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
            shared.isMessageProcessedMock.mockReturnValue(false);
            let resolveFirst: (() => void) | undefined;
            shared.handleDingTalkMessageMock
                .mockImplementationOnce(
                    () =>
                        new Promise<void>((resolve) => {
                            resolveFirst = resolve;
                        })
                )
                .mockResolvedValueOnce(undefined);
            const ctx = createStartContext();

            await startGatewayAccount(ctx as any);

            const payloadData = JSON.stringify({
                msgId: 'msg_stale',
                msgtype: 'text',
                text: { content: 'stale me' },
                conversationType: '1',
                conversationId: 'cidA1B2C3',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://webhook',
            });

            const first = shared.listener?.({
                headers: { messageId: 'stream_msg_stale_1' },
                data: payloadData,
            });
            await Promise.resolve();

            await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);

            const second = shared.listener?.({
                headers: { messageId: 'stream_msg_stale_2' },
                data: payloadData,
            });

            await Promise.resolve();
            expect(shared.handleDingTalkMessageMock).toHaveBeenCalledTimes(2);
            expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringContaining('Releasing stale in-flight lock'));

            resolveFirst?.();
            await first;
            await second;
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears account in-flight locks on disconnect state change', async () => {
        shared.isMessageProcessedMock.mockReturnValue(false);
        let resolveFirst: (() => void) | undefined;
        shared.handleDingTalkMessageMock
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        resolveFirst = resolve;
                    })
            )
            .mockResolvedValueOnce(undefined);
        const ctx = createStartContext();

        await startGatewayAccount(ctx as any);

        const payloadData = JSON.stringify({
            msgId: 'msg_disconnect',
            msgtype: 'text',
            text: { content: 'disconnect me' },
            conversationType: '1',
            conversationId: 'cidA1B2C3',
            senderId: 'user_1',
            chatbotUserId: 'bot_1',
            sessionWebhook: 'https://webhook',
        });

        const first = shared.listener?.({
            headers: { messageId: 'stream_msg_disconnect_1' },
            data: payloadData,
        });
        await Promise.resolve();

        shared.connectionConfig?.onStateChange?.('DISCONNECTED', 'lost');

        const second = shared.listener?.({
            headers: { messageId: 'stream_msg_disconnect_2' },
            data: payloadData,
        });

        await Promise.resolve();
        expect(shared.handleDingTalkMessageMock).toHaveBeenCalledTimes(2);
        expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining('Cleared 1 stale in-flight lock'));

        resolveFirst?.();
        await first;
        await second;
    });
});
