import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
    sendBySessionMock: vi.fn(),
    sendMessageMock: vi.fn(),
    extractMessageContentMock: vi.fn(),
    getRuntimeMock: vi.fn(),
    createAICardMock: vi.fn(),
    finishAICardMock: vi.fn(),
    streamAICardMock: vi.fn(),
    formatContentForCardMock: vi.fn((s: string) => s),
    isCardInTerminalStateMock: vi.fn(),
    acquireSessionLockMock: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        post: vi.fn(),
        get: vi.fn(),
    },
    isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
}));

vi.mock('../../src/auth', () => ({
    getAccessToken: vi.fn().mockResolvedValue('token_abc'),
}));

vi.mock('../../src/runtime', () => ({
    getDingTalkRuntime: shared.getRuntimeMock,
}));

vi.mock('../../src/message-utils', () => ({
    extractMessageContent: shared.extractMessageContentMock,
}));

vi.mock('../../src/send-service', () => ({
    sendBySession: shared.sendBySessionMock,
    sendMessage: shared.sendMessageMock,
}));

vi.mock('../../src/card-service', () => ({
    createAICard: shared.createAICardMock,
    finishAICard: shared.finishAICardMock,
    formatContentForCard: shared.formatContentForCardMock,
    isCardInTerminalState: shared.isCardInTerminalStateMock,
    streamAICard: shared.streamAICardMock,
}));

vi.mock('../../src/session-lock', () => ({
    acquireSessionLock: shared.acquireSessionLockMock,
}));

import {
    downloadMedia,
    handleDingTalkMessage,
    resetProactivePermissionHintStateForTest,
} from '../../src/inbound-handler';
import { recordProactiveRiskObservation } from '../../src/proactive-risk-registry';

const mockedAxiosPost = vi.mocked(axios.post);
const mockedAxiosGet = vi.mocked(axios.get);

function buildRuntime() {
    return {
        channel: {
            routing: { resolveAgentRoute: vi.fn().mockReturnValue({ agentId: 'main', sessionKey: 's1', mainSessionKey: 's1' }) },
            media: {
                saveMediaBuffer: vi.fn().mockResolvedValue({
                    path: '/tmp/.openclaw/media/inbound/test-file.png',
                    contentType: 'image/png',
                }),
            },
            session: {
                resolveStorePath: vi.fn().mockReturnValue('/tmp/store.json'),
                readSessionUpdatedAt: vi.fn().mockReturnValue(null),
                recordInboundSession: vi.fn().mockResolvedValue(undefined),
            },
            reply: {
                resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
                formatInboundEnvelope: vi.fn().mockReturnValue('body'),
                finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: 's1' }),
                dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
                    await replyOptions?.onReasoningStream?.({ text: 'thinking' });
                    await dispatcherOptions.deliver({ text: 'tool output' }, { kind: 'tool' });
                    await dispatcherOptions.deliver({ text: 'final output' }, { kind: 'final' });
                    return { queuedFinal: 'queued final' };
                }),
            },
        },
    };
}

describe('inbound-handler', () => {
    beforeEach(() => {
        mockedAxiosPost.mockReset();
        mockedAxiosGet.mockReset();
        shared.sendBySessionMock.mockReset();
        shared.sendMessageMock.mockReset();
        shared.sendMessageMock.mockResolvedValue({ ok: true });
        shared.extractMessageContentMock.mockReset();
        shared.createAICardMock.mockReset();
        shared.finishAICardMock.mockReset();
        shared.streamAICardMock.mockReset();
        shared.isCardInTerminalStateMock.mockReset();

        shared.acquireSessionLockMock.mockReset();
        shared.acquireSessionLockMock.mockResolvedValue(vi.fn());

        shared.getRuntimeMock.mockReturnValue(buildRuntime());
        shared.extractMessageContentMock.mockReturnValue({ text: 'hello', messageType: 'text' });
        resetProactivePermissionHintStateForTest();
        shared.createAICardMock.mockResolvedValue({
            cardInstanceId: 'card_1',
            state: '1',
            lastUpdated: Date.now(),
        });
    });

    it('downloadMedia returns file meta when DingTalk download succeeds', async () => {
        mockedAxiosPost.mockResolvedValueOnce({ data: { downloadUrl: 'https://download.url/file' } } as any);
        mockedAxiosGet.mockResolvedValueOnce({
            data: Buffer.from('abc'),
            headers: { 'content-type': 'image/png' },
        } as any);

        const result = await downloadMedia({ clientId: 'id', clientSecret: 'sec', robotCode: 'robot_1' } as any, 'download_code_1');

        expect(result).toBeTruthy();
        expect(result?.mimeType).toBe('image/png');
        expect(result?.path).toContain('/.openclaw/media/inbound/');
    });

    it('downloadMedia passes mediaMaxMb as maxBytes to saveMediaBuffer', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValue(runtime);

        mockedAxiosPost.mockResolvedValueOnce({ data: { downloadUrl: 'https://download.url/file' } } as any);
        mockedAxiosGet.mockResolvedValueOnce({
            data: Buffer.from('abc'),
            headers: { 'content-type': 'application/pdf' },
        } as any);

        await downloadMedia(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'robot_1', mediaMaxMb: 50 } as any,
            'download_code_1',
        );

        expect(runtime.channel.media.saveMediaBuffer).toHaveBeenCalledWith(
            expect.any(Buffer),
            'application/pdf',
            'inbound',
            50 * 1024 * 1024,
        );
    });

    it('downloadMedia uses runtime default when mediaMaxMb is not set', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValue(runtime);

        mockedAxiosPost.mockResolvedValueOnce({ data: { downloadUrl: 'https://download.url/file' } } as any);
        mockedAxiosGet.mockResolvedValueOnce({
            data: Buffer.from('abc'),
            headers: { 'content-type': 'image/png' },
        } as any);

        await downloadMedia(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'robot_1' } as any,
            'download_code_1',
        );

        const call = runtime.channel.media.saveMediaBuffer.mock.calls[0];
        expect(call).toHaveLength(3);
        expect(call[2]).toBe('inbound');
    });

    it('downloadMedia returns null when robotCode missing', async () => {
        const result = await downloadMedia({ clientId: 'id', clientSecret: 'sec' } as any, 'download_code_1');

        expect(result).toBeNull();
        expect(mockedAxiosPost).not.toHaveBeenCalled();
    });

    it('handleDingTalkMessage ignores self-message', async () => {
        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm1',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid1',
                senderId: 'bot_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).not.toHaveBeenCalled();
    });

    it('handleDingTalkMessage sends deny message when dmPolicy allowlist blocks sender', async () => {
        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'allowlist', allowFrom: ['user_ok'] } as any,
            data: {
                msgId: 'm2',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid1',
                senderId: 'user_blocked',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('访问受限');
    });

    it('handleDingTalkMessage sends group deny message when groupPolicy allowlist blocks group', async () => {
        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'allowlist', allowFrom: ['cid_allowed'] } as any,
            data: {
                msgId: 'm3',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '2',
                conversationId: 'cid_blocked',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('访问受限');
    });

    it('handleDingTalkMessage runs card flow and finalizes AI card', async () => {
        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card' } as any,
            data: {
                msgId: 'm4',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        expect(shared.sendMessageMock).toHaveBeenCalled();
        const cardSends = shared.sendMessageMock.mock.calls.filter((call: any[]) => call[3]?.card);
        expect(cardSends.length).toBeGreaterThan(0);
    });

    it('handleDingTalkMessage runs non-card flow and sends thinking + final outputs', async () => {
        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', showThinking: true } as any,
            data: {
                msgId: 'm5',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendMessageMock).toHaveBeenCalled();
    });

    it('handleDingTalkMessage finalizes card with default content when no textual output is produced', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({ queuedFinal: '' });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        const card = { cardInstanceId: 'card_2', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card' } as any,
            data: {
                msgId: 'm6',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        expect(shared.finishAICardMock).toHaveBeenCalledWith(card, '✅ Done', undefined);
    });

    it('handleDingTalkMessage finalizes card using tool stream content when no final text exists', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions }) => {
                await dispatcherOptions.deliver({ text: 'tool output' }, { kind: 'tool' });
                return { queuedFinal: '' };
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        const card = { cardInstanceId: 'card_tool_only', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card' } as any,
            data: {
                msgId: 'm6_tool',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        expect(shared.finishAICardMock).toHaveBeenCalledWith(card, 'tool output', undefined);
        expect(shared.sendMessageMock).toHaveBeenCalledWith(
            expect.anything(),
            'user_1',
            'tool output',
            expect.objectContaining({ card, cardUpdateMode: 'append' }),
        );
    });

    it('handleDingTalkMessage skips finishAICard when current card is already terminal', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockResolvedValue({ queuedFinal: 'queued final' });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        const card = { cardInstanceId: 'card_terminal', state: '5', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockImplementation((state: string) => state === '5');

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card' } as any,
            data: {
                msgId: 'm7_terminal',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.isCardInTerminalStateMock).toHaveBeenCalledWith('5');
        expect(shared.finishAICardMock).not.toHaveBeenCalled();
    });

    it('handleDingTalkMessage ignores thinking and tool card updates when card is already finalized', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
                await replyOptions?.onReasoningStream?.({ text: 'thinking' });
                await dispatcherOptions.deliver({ text: 'tool output' }, { kind: 'tool' });
                return { queuedFinal: '' };
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        const card = { cardInstanceId: 'card_finalized', state: '3', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockImplementation((state: string) => state === '3');

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card' } as any,
            data: {
                msgId: 'm7_finalized',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.streamAICardMock).not.toHaveBeenCalled();
        expect(shared.finishAICardMock).not.toHaveBeenCalled();
    });

    it('handleDingTalkMessage marks card FAILED when finishAICard throws', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        const card = { cardInstanceId: 'card_3', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.finishAICardMock.mockRejectedValueOnce({
            message: 'finish failed',
            response: { data: { code: 'invalidParameter', message: 'cannot finalize' } },
        });
        const log = { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: log as any,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card' } as any,
            data: {
                msgId: 'm7',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(card.state).toBe('5');
        const debugLogs = log.debug.mock.calls.map((args: unknown[]) => String(args[0]));
        expect(
            debugLogs.some(
                (entry) =>
                    entry.includes('[DingTalk][ErrorPayload][inbound.cardFinalize]') &&
                    entry.includes('code=invalidParameter') &&
                    entry.includes('message=cannot finalize')
            )
        ).toBe(true);
    });

    it('handleDingTalkMessage group card flow creates card and streams tool/reasoning', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        const createdCard = { cardInstanceId: 'card_new', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(createdCard);
        shared.isCardInTerminalStateMock.mockReturnValue(false);
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: 'group hello',
            mediaPath: 'download_code_1',
            messageType: 'text',
        });
        mockedAxiosPost.mockResolvedValueOnce({ data: { downloadUrl: 'https://download.url/file' } } as any);
        mockedAxiosGet.mockResolvedValueOnce({
            data: Buffer.from('abc'),
            headers: { 'content-type': 'image/png' },
        } as any);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: {
                groupPolicy: 'allowlist',
                allowFrom: ['cid_group_1'],
                messageType: 'card',
                robotCode: 'robot_1',
                groups: { cid_group_1: { systemPrompt: 'group prompt' } },
            } as any,
            data: {
                msgId: 'm8',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '2',
                conversationId: 'cid_group_1',
                conversationTitle: 'group-title',
                senderId: 'user_1',
                senderNick: 'Alice',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.createAICardMock).toHaveBeenCalledTimes(1);
        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    });

    it('sends proactive permission hint when proactive API risk was observed', async () => {
        recordProactiveRiskObservation({
            accountId: 'main',
            targetId: 'manager123',
            level: 'high',
            reason: 'Forbidden.AccessDenied.AccessTokenPermissionDenied',
            source: 'proactive-api',
        });
        shared.sendBySessionMock.mockResolvedValue(undefined);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: {
                dmPolicy: 'open',
                messageType: 'markdown',
                showThinking: false,
                proactivePermissionHint: { enabled: true, cooldownHours: 24 },
            } as any,
            data: {
                msgId: 'm9',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'manager123',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(String(shared.sendBySessionMock.mock.calls[0]?.[2])).toContain('主动推送可能失败');
    });

    it('sends proactive permission hint only once within cooldown window', async () => {
        recordProactiveRiskObservation({
            accountId: 'main',
            targetId: 'manager123',
            level: 'high',
            reason: 'Forbidden.AccessDenied.AccessTokenPermissionDenied',
            source: 'proactive-api',
        });
        shared.sendBySessionMock.mockResolvedValue(undefined);

        const params = {
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: {
                dmPolicy: 'open',
                messageType: 'markdown',
                showThinking: false,
                proactivePermissionHint: { enabled: true, cooldownHours: 24 },
            } as any,
            data: {
                msgId: 'm10',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'manager123',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any;

        await handleDingTalkMessage(params);
        await handleDingTalkMessage(params);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
    });

    it('does not send proactive permission hint without proactive API risk observation', async () => {
        shared.sendBySessionMock.mockResolvedValue(undefined);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: {
                dmPolicy: 'open',
                messageType: 'markdown',
                showThinking: false,
                proactivePermissionHint: { enabled: true, cooldownHours: 24 },
            } as any,
            data: {
                msgId: 'm11',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: '0341234567',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).not.toHaveBeenCalled();
    });

    it('concurrent messages create independent cards with distinct IDs', async () => {
        let resolveA!: () => void;
        const gateA = new Promise<void>((r) => { resolveA = r; });

        const cardA = { cardInstanceId: 'card_A', state: '1', lastUpdated: Date.now() } as any;
        const cardB = { cardInstanceId: 'card_B', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock
            .mockResolvedValueOnce(cardA)
            .mockResolvedValueOnce(cardB);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        const runtimeA = buildRuntime();
        runtimeA.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async ({ dispatcherOptions }) => {
            await gateA;
            await dispatcherOptions.deliver({ text: 'reply A' }, { kind: 'final' });
            return { queuedFinal: 'reply A' };
        });
        const runtimeB = buildRuntime();
        runtimeB.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: 'reply B' }, { kind: 'final' });
            return { queuedFinal: 'reply B' };
        });
        shared.getRuntimeMock
            .mockReturnValueOnce(runtimeA)
            .mockReturnValueOnce(runtimeB);

        const baseParams = {
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', showThinking: false } as any,
        };

        const promiseA = handleDingTalkMessage({
            ...baseParams,
            data: {
                msgId: 'concurrent_A', msgtype: 'text', text: { content: 'hello A' },
                conversationType: '1', conversationId: 'cid_same', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        const promiseB = handleDingTalkMessage({
            ...baseParams,
            data: {
                msgId: 'concurrent_B', msgtype: 'text', text: { content: 'hello B' },
                conversationType: '1', conversationId: 'cid_same', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        await promiseB;
        resolveA();
        await promiseA;

        expect(shared.createAICardMock).toHaveBeenCalledTimes(2);
        expect(shared.finishAICardMock).toHaveBeenCalledTimes(2);

        const finishCalls = shared.finishAICardMock.mock.calls;
        const finishedCardIds = finishCalls.map((call: any[]) => call[0].cardInstanceId);
        expect(finishedCardIds).toContain('card_A');
        expect(finishedCardIds).toContain('card_B');
    });

    it('concurrent messages pass correct card reference to sendMessage', async () => {
        let resolveA!: () => void;
        const gateA = new Promise<void>((r) => { resolveA = r; });

        const cardA = { cardInstanceId: 'card_A', state: '1', lastUpdated: Date.now() } as any;
        const cardB = { cardInstanceId: 'card_B', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock
            .mockResolvedValueOnce(cardA)
            .mockResolvedValueOnce(cardB);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        const runtimeA = buildRuntime();
        runtimeA.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async ({ dispatcherOptions }) => {
            await gateA;
            await dispatcherOptions.deliver({ text: 'tool A' }, { kind: 'tool' });
            await dispatcherOptions.deliver({ text: 'reply A' }, { kind: 'final' });
            return { queuedFinal: 'reply A' };
        });
        const runtimeB = buildRuntime();
        runtimeB.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: 'tool B' }, { kind: 'tool' });
            await dispatcherOptions.deliver({ text: 'reply B' }, { kind: 'final' });
            return { queuedFinal: 'reply B' };
        });
        shared.getRuntimeMock
            .mockReturnValueOnce(runtimeA)
            .mockReturnValueOnce(runtimeB);

        const baseParams = {
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', showThinking: false } as any,
        };

        const promiseA = handleDingTalkMessage({
            ...baseParams,
            data: {
                msgId: 'bind_A', msgtype: 'text', text: { content: 'hello A' },
                conversationType: '1', conversationId: 'cid_same', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        const promiseB = handleDingTalkMessage({
            ...baseParams,
            data: {
                msgId: 'bind_B', msgtype: 'text', text: { content: 'hello B' },
                conversationType: '1', conversationId: 'cid_same', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        await promiseB;
        resolveA();
        await promiseA;

        const sendCalls = shared.sendMessageMock.mock.calls;
        const toolCallA = sendCalls.find((call: any[]) => call[2] === 'tool A');
        const toolCallB = sendCalls.find((call: any[]) => call[2] === 'tool B');
        expect(toolCallA).toBeTruthy();
        expect(toolCallB).toBeTruthy();
        expect(toolCallA![3]?.card?.cardInstanceId).toBe('card_A');
        expect(toolCallB![3]?.card?.cardInstanceId).toBe('card_B');
        expect(toolCallA![3]?.cardUpdateMode).toBe('append');
        expect(toolCallB![3]?.cardUpdateMode).toBe('append');
    });

    it('message A card in terminal state still finalizes without affecting message B', async () => {
        const cardA = { cardInstanceId: 'card_term', state: '3', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(cardA);
        shared.isCardInTerminalStateMock.mockImplementation((state: string) => state === '3' || state === '5');

        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', showThinking: false } as any,
            data: {
                msgId: 'term_card', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).not.toHaveBeenCalled();
        const cardSendCalls = shared.sendMessageMock.mock.calls.filter((call: any[]) => call[3]?.card);
        expect(cardSendCalls).toHaveLength(0);
    });

    it('acquires session lock with the resolved sessionKey', async () => {
        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'lock_test', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.acquireSessionLockMock).toHaveBeenCalledTimes(1);
        expect(shared.acquireSessionLockMock).toHaveBeenCalledWith('s1');
    });

    it('releases session lock even when dispatchReply throws', async () => {
        const releaseFn = vi.fn();
        shared.acquireSessionLockMock.mockResolvedValueOnce(releaseFn);

        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockRejectedValueOnce(new Error('dispatch crash'));
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await expect(handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'lock_crash', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any)).rejects.toThrow('dispatch crash');

        expect(releaseFn).toHaveBeenCalledTimes(1);
    });

    it('attempts to finalize active card when dispatchReply throws', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockRejectedValueOnce(new Error('dispatch crash'));
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        const card = { cardInstanceId: 'card_on_error', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);

        await expect(handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', showThinking: false } as any,
            data: {
                msgId: 'lock_crash_card', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any)).rejects.toThrow('dispatch crash');

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        expect(shared.finishAICardMock).toHaveBeenCalledWith(card, '❌ 处理失败', expect.anything());
    });

    it('does not leak unhandled stop reason text to outbound chat messages', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(async ({ dispatcherOptions }) => {
            await dispatcherOptions.deliver({ text: 'Unhandled stop reason: network_error' }, { kind: 'final' });
            return { queuedFinal: 'Unhandled stop reason: network_error' };
        });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'm12',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendMessageMock).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.stringContaining('Unhandled stop reason:'),
            expect.anything(),
        );
    });
});
