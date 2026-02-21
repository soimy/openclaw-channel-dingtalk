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

        constructor() {
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

        shared.listener = undefined;
        shared.connectMock.mockResolvedValue(undefined);
        shared.waitForStopMock.mockResolvedValue(undefined);
        shared.isConnectedMock.mockReturnValue(false);
    });

    it('acknowledges callback and dispatches non-duplicate message', async () => {
        shared.isMessageProcessedMock.mockReturnValue(false);
        const ctx = createStartContext();

        await dingtalkPlugin.gateway.startAccount(ctx as any);

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

        await dingtalkPlugin.gateway.startAccount(ctx as any);

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
    });
});
