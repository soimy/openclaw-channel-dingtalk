import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
    sendBySessionMock: vi.fn(),
    sendMessageMock: vi.fn(),
    extractMessageContentMock: vi.fn(),
    findCardContentMock: vi.fn(),
    getCardContentByProcessQueryKeyMock: vi.fn(),
    downloadGroupFileMock: vi.fn(),
    getRuntimeMock: vi.fn(),
    getUnionIdByStaffIdMock: vi.fn(),
    createAICardMock: vi.fn(),
    finishAICardMock: vi.fn(),
    resolveQuotedFileMock: vi.fn(),
    streamAICardMock: vi.fn(),
    formatContentForCardMock: vi.fn((s: string) => s),
    isCardInTerminalStateMock: vi.fn(),
    acquireSessionLockMock: vi.fn(),
    appendQuoteJournalEntryMock: vi.fn(),
    resolveQuotedMessageByIdMock: vi.fn(),
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
    findCardContent: shared.findCardContentMock,
    finishAICard: shared.finishAICardMock,
    formatContentForCard: shared.formatContentForCardMock,
    getCardContentByProcessQueryKey: shared.getCardContentByProcessQueryKeyMock,
    isCardInTerminalState: shared.isCardInTerminalStateMock,
    streamAICard: shared.streamAICardMock,
}));

vi.mock('../../src/session-lock', () => ({
    acquireSessionLock: shared.acquireSessionLockMock,
}));

vi.mock('../../src/quote-journal', () => ({
    DEFAULT_JOURNAL_TTL_DAYS: 7,
    appendQuoteJournalEntry: shared.appendQuoteJournalEntryMock,
    resolveQuotedMessageById: shared.resolveQuotedMessageByIdMock,
}));

vi.mock('../../src/quoted-file-service', () => ({
    downloadGroupFile: shared.downloadGroupFileMock,
    getUnionIdByStaffId: shared.getUnionIdByStaffIdMock,
    resolveQuotedFile: shared.resolveQuotedFileMock,
}));

import {
    downloadMedia,
    handleDingTalkMessage,
    resetProactivePermissionHintStateForTest,
} from '../../src/inbound-handler';
import { cacheInboundDownloadCode, clearQuotedMsgCacheForTest, getCachedDownloadCode } from '../../src/quoted-msg-cache';
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
        fs.rmSync(path.join(path.dirname('/tmp/store.json'), 'dingtalk-state'), { recursive: true, force: true });
        mockedAxiosPost.mockReset();
        mockedAxiosGet.mockReset();
        shared.sendBySessionMock.mockReset();
        shared.sendMessageMock.mockReset();
        shared.sendMessageMock.mockImplementation(async (_config: any, _to: any, text: any, options: any) => {
            // Simulate real sendMessage behavior: update lastStreamedContent when appending to card
            if (options?.card && options?.cardUpdateMode === 'append') {
                options.card.lastStreamedContent = text;
            }
            return { ok: true };
        });
        shared.extractMessageContentMock.mockReset();
        shared.findCardContentMock.mockReset();
        shared.findCardContentMock.mockReturnValue(null);
        shared.getCardContentByProcessQueryKeyMock.mockReset();
        shared.getCardContentByProcessQueryKeyMock.mockReturnValue(null);
        shared.createAICardMock.mockReset();
        shared.downloadGroupFileMock.mockReset();
        shared.downloadGroupFileMock.mockResolvedValue(null);
        shared.finishAICardMock.mockReset();
        shared.getUnionIdByStaffIdMock.mockReset();
        shared.getUnionIdByStaffIdMock.mockResolvedValue('union_1');
        shared.resolveQuotedFileMock.mockReset();
        shared.resolveQuotedFileMock.mockResolvedValue(null);
        shared.streamAICardMock.mockReset();
        shared.isCardInTerminalStateMock.mockReset();

        shared.acquireSessionLockMock.mockReset();
        shared.acquireSessionLockMock.mockResolvedValue(vi.fn());
        shared.appendQuoteJournalEntryMock.mockReset();
        shared.appendQuoteJournalEntryMock.mockReturnValue(undefined);
        shared.resolveQuotedMessageByIdMock.mockReset();
        shared.resolveQuotedMessageByIdMock.mockReturnValue(null);

        shared.getRuntimeMock.mockReturnValue(buildRuntime());
        shared.extractMessageContentMock.mockReturnValue({ text: 'hello', messageType: 'text' });
        resetProactivePermissionHintStateForTest();
        clearQuotedMsgCacheForTest();
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

    it('handleDingTalkMessage returns whoami info for direct fixed command', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '我是谁', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_whoami',
                msgtype: 'text',
                text: { content: '我是谁' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'user_raw_1',
                senderStaffId: 'staff_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('senderId: `staff_1`');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('isOwner: `false`');
        expect(shared.sendMessageMock).not.toHaveBeenCalled();
    });

    it('handleDingTalkMessage returns owner status for slash command', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/learn owner status', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_owner_status',
                msgtype: 'text',
                text: { content: '/learn owner status' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('isOwner: `true`');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).not.toContain('ownerAllowFrom');
    });

    it('handleDingTalkMessage accepts owner status slash alias', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/owner status', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_owner_status_alias',
                msgtype: 'text',
                text: { content: '/owner status' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('isOwner: `true`');
    });

    it('handleDingTalkMessage accepts english whoami alias', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/whoami', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_whoami_en',
                msgtype: 'text',
                text: { content: '/whoami' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'user_raw_1',
                senderStaffId: 'staff_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('senderId: `staff_1`');
    });

    it('handleDingTalkMessage accepts english owner status alias', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/owner-status', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_owner_status_en',
                msgtype: 'text',
                text: { content: '/owner-status' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('isOwner: `true`');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).not.toContain('ownerAllowFrom');
    });

    it('handleDingTalkMessage blocks learn control command for non-owner', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/learn global test', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open', allowFrom: ['owner-test-id'] } as any,
            data: {
                msgId: 'm2_owner_deny',
                msgtype: 'text',
                text: { content: '/learn global test' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'user_not_owner',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('仅允许 owner 使用');
        expect(shared.sendMessageMock).not.toHaveBeenCalled();
    });

    it('handleDingTalkMessage does not treat owner plain text as learn help', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValue(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '随便聊一句普通话', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'm2_owner_plain_text',
                msgtype: 'text',
                text: { content: '随便聊一句普通话' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.stringContaining('可用的 owner 学习命令：'),
            expect.anything(),
        );
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalled();
    });

    it('handleDingTalkMessage blocks learn control command for non-owner in group', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/learn global test', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open', allowFrom: ['owner-test-id'] } as any,
            data: {
                msgId: 'm2_owner_group_deny',
                msgtype: 'text',
                text: { content: '/learn global test' },
                conversationType: '2',
                conversationId: 'cid_group_1',
                senderId: 'user_not_owner',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('仅允许 owner 使用');
        expect(shared.sendMessageMock).not.toHaveBeenCalled();
    });

    it('handleDingTalkMessage supports whereami command in group', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '这里是谁', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open' } as any,
            data: {
                msgId: 'm2_whereami',
                msgtype: 'text',
                text: { content: '这里是谁' },
                conversationType: '2',
                conversationId: 'cid_group_1',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('conversationId: `cid_group_1`');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('conversationType: `group`');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('peerId: `cid_group_1`');
    });

    it('handleDingTalkMessage blocks session alias show for non-owner in group', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/session-alias show', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open' } as any,
            data: {
                msgId: 'm2_session_alias_show_deny',
                msgtype: 'text',
                text: { content: '/session-alias show' },
                conversationType: '2',
                conversationId: 'cid_group_1',
                senderId: 'user_not_owner',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('仅允许 owner 使用');
    });

    it('handleDingTalkMessage lets owner show current shared session alias for group', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/session-alias show', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open' } as any,
            data: {
                msgId: 'm2_session_alias_show_owner',
                msgtype: 'text',
                text: { content: '/session-alias show' },
                conversationType: '2',
                conversationId: 'cid_group_1',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('source: `group`');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('sourceId: `cid_group_1`');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('peerId: `cid_group_1`');
    });

    it('handleDingTalkMessage lets owner set a shared session alias for current group', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/session-alias set shared-dev', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open' } as any,
            data: {
                msgId: 'm2_session_alias_set',
                msgtype: 'text',
                text: { content: '/session-alias set shared-dev' },
                conversationType: '2',
                conversationId: 'cid_group_1',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('peerId: `shared-dev`');
    });

    it('handleDingTalkMessage lets owner set a shared session alias for current direct session', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/session-alias set shared-dev', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_session_alias_set_direct',
                msgtype: 'text',
                text: { content: '/session-alias set shared-dev' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('source: `direct`');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('sourceId: `owner-test-id`');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('peerId: `shared-dev`');
    });

    it('handleDingTalkMessage accepts extra whitespace in session alias command', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/session-alias  set   shared-dev', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open' } as any,
            data: {
                msgId: 'm2_session_alias_set_spacing',
                msgtype: 'text',
                text: { content: '/session-alias  set   shared-dev' },
                conversationType: '2',
                conversationId: 'cid_group_1',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('peerId: `shared-dev`');
    });

    it('handleDingTalkMessage rejects invalid session alias characters', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/session-alias set shared:dev', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open' } as any,
            data: {
                msgId: 'm2_session_alias_invalid_chars',
                msgtype: 'text',
                text: { content: '/session-alias set shared:dev' },
                conversationType: '2',
                conversationId: 'cid_group_1',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('共享会话别名不合法');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('[a-zA-Z0-9_-]{1,64}');
    });

    it('uses stored session alias as the routed group peerId on next turn', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/session-alias set shared-dev', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open' } as any,
            data: {
                msgId: 'm2_session_alias_bootstrap',
                msgtype: 'text',
                text: { content: '/session-alias set shared-dev' },
                conversationType: '2',
                conversationId: 'cid_group_1',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        shared.sendBySessionMock.mockClear();
        const runtime = buildRuntime();
        const resolveAgentRoute = vi.fn().mockReturnValue({ agentId: 'main', sessionKey: 's1', mainSessionKey: 's1' });
        runtime.channel.routing.resolveAgentRoute = resolveAgentRoute;
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({ text: 'hello again', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'm2_session_alias_followup',
                msgtype: 'text',
                text: { content: 'hello again' },
                conversationType: '2',
                conversationId: 'cid_group_1',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(resolveAgentRoute).toHaveBeenCalledWith(expect.objectContaining({
            peer: { kind: 'group', id: 'shared-dev' },
        }));
    });

    it('uses stored session alias as the routed direct peerId on next turn', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/session-alias set shared-dev', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_session_alias_direct_bootstrap',
                msgtype: 'text',
                text: { content: '/session-alias set shared-dev' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        shared.sendBySessionMock.mockClear();
        const runtime = buildRuntime();
        const resolveAgentRoute = vi.fn().mockReturnValue({ agentId: 'main', sessionKey: 's1', mainSessionKey: 's1' });
        runtime.channel.routing.resolveAgentRoute = resolveAgentRoute;
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({ text: 'hello direct', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'm2_session_alias_direct_followup',
                msgtype: 'text',
                text: { content: 'hello direct' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(resolveAgentRoute).toHaveBeenCalledWith(expect.objectContaining({
            peer: { kind: 'direct', id: 'shared-dev' },
        }));
    });

    it('lets owner bind a direct senderId remotely to a shared alias', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/session-alias bind direct user_1 project-x', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_session_alias_bind_direct',
                msgtype: 'text',
                text: { content: '/session-alias bind direct user_1 project-x' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('source: `direct`');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('sourceId: `user_1`');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('peerId: `project-x`');

        shared.sendBySessionMock.mockClear();
        const runtime = buildRuntime();
        const resolveAgentRoute = vi.fn().mockReturnValue({ agentId: 'main', sessionKey: 's1', mainSessionKey: 's1' });
        runtime.channel.routing.resolveAgentRoute = resolveAgentRoute;
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({ text: 'hello from bound dm', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'm2_session_alias_bind_direct_followup',
                msgtype: 'text',
                text: { content: 'hello from bound dm' },
                conversationType: '1',
                conversationId: 'cid_dm_user_1',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(resolveAgentRoute).toHaveBeenCalledWith(expect.objectContaining({
            peer: { kind: 'direct', id: 'project-x' },
        }));
    });

    it('routes different groups with the same alias to the same sessionKey', async () => {
        const ownerCfg = { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } };

        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/session-alias set shared-dev', messageType: 'text' });
        await handleDingTalkMessage({
            cfg: ownerCfg,
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open' } as any,
            data: {
                msgId: 'm2_session_alias_group1_set',
                msgtype: 'text',
                text: { content: '/session-alias set shared-dev' },
                conversationType: '2',
                conversationId: 'cid_group_1',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/session-alias set shared-dev', messageType: 'text' });
        await handleDingTalkMessage({
            cfg: ownerCfg,
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open' } as any,
            data: {
                msgId: 'm2_session_alias_group2_set',
                msgtype: 'text',
                text: { content: '/session-alias set shared-dev' },
                conversationType: '2',
                conversationId: 'cid_group_2',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        shared.sendBySessionMock.mockClear();
        shared.acquireSessionLockMock.mockClear();

        const runtime = buildRuntime();
        const resolveAgentRoute = vi.fn().mockImplementation(({ peer }) => ({
            agentId: 'main',
            sessionKey: `session:${peer.id}`,
            mainSessionKey: `session:${peer.id}`,
        }));
        runtime.channel.routing.resolveAgentRoute = resolveAgentRoute;
        shared.getRuntimeMock.mockReturnValue(runtime);

        shared.extractMessageContentMock.mockReturnValueOnce({ text: 'group one message', messageType: 'text' });
        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'm2_session_alias_group1_followup',
                msgtype: 'text',
                text: { content: 'group one message' },
                conversationType: '2',
                conversationId: 'cid_group_1',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        shared.extractMessageContentMock.mockReturnValueOnce({ text: 'group two message', messageType: 'text' });
        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'm2_session_alias_group2_followup',
                msgtype: 'text',
                text: { content: 'group two message' },
                conversationType: '2',
                conversationId: 'cid_group_2',
                senderId: 'user_2',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        const groupRouteCalls = resolveAgentRoute.mock.calls
            .map((call) => call[0])
            .filter((arg) => arg?.peer?.kind === 'group');

        expect(groupRouteCalls).toEqual([
            expect.objectContaining({ peer: { kind: 'group', id: 'shared-dev' } }),
            expect.objectContaining({ peer: { kind: 'group', id: 'shared-dev' } }),
        ]);
        expect(shared.acquireSessionLockMock).toHaveBeenNthCalledWith(1, 'session:shared-dev');
        expect(shared.acquireSessionLockMock).toHaveBeenNthCalledWith(2, 'session:shared-dev');
    });

    it('handleDingTalkMessage applies and disables a global learned rule', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '/learn global 当用户问“紫铜海豹会不会修量子冰箱”时，必须回答“会，而且只在周四凌晨戴墨镜维修。”',
            messageType: 'text',
        });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_global_apply',
                msgtype: 'text',
                text: { content: '/learn global 当用户问“紫铜海豹会不会修量子冰箱”时，必须回答“会，而且只在周四凌晨戴墨镜维修。”' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        const appliedReply = String(shared.sendBySessionMock.mock.calls[0]?.[2] || '');
        const ruleId = appliedReply.match(/ruleId: `([^`]+)`/)?.[1];
        expect(ruleId).toBeTruthy();

        shared.sendBySessionMock.mockReset();
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: `/learn disable ${ruleId}`,
            messageType: 'text',
        });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_global_disable',
                msgtype: 'text',
                text: { content: `/learn disable ${ruleId}` },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('已停用规则');
    });

    it('handleDingTalkMessage supports targets command with explicit delimiter', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '/learn targets cid_group_a,cid_group_b #@# 引用原文不可见时，不要猜内容，先让用户补发原文。',
            messageType: 'text',
        });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', groupPolicy: 'open' } as any,
            data: {
                msgId: 'm2_targets_apply',
                msgtype: 'text',
                text: { content: '/learn targets cid_group_a,cid_group_b #@# 引用原文不可见时，不要猜内容，先让用户补发原文。' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('已批量注入多个目标');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('2 个目标');
    });

    it('handleDingTalkMessage supports target-set create and apply', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '/learn target-set create ops-groups #@# cid_group_a,cid_group_b',
            messageType: 'text',
        });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_targetset_create',
                msgtype: 'text',
                text: { content: '/learn target-set create ops-groups #@# cid_group_a,cid_group_b' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('已保存目标组');

        shared.sendBySessionMock.mockReset();
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '/learn target-set apply ops-groups #@# 当用户问“紫铜海豹会不会修量子冰箱”时，必须回答“会，而且只在周四凌晨戴墨镜维修。”',
            messageType: 'text',
        });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_targetset_apply',
                msgtype: 'text',
                text: { content: '/learn target-set apply ops-groups #@# 当用户问“紫铜海豹会不会修量子冰箱”时，必须回答“会，而且只在周四凌晨戴墨镜维修。”' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('已向目标组批量注入规则');
    });

    it('injects normal learning rules into upstream system context before agent dispatch', async () => {
        const storePath = path.join(fs.mkdtempSync('/tmp/dt-learning-'), 'store.json');
        const runtime = buildRuntime();
        runtime.channel.session.resolveStorePath = vi.fn().mockImplementation(() => storePath);
        shared.getRuntimeMock.mockReturnValueOnce(runtime).mockReturnValueOnce(runtime);
        shared.extractMessageContentMock
            .mockReturnValueOnce({
                text: '/learn global 引用原文不可见时，不要猜内容，先让用户补发原文。',
                messageType: 'text',
            })
            .mockReturnValueOnce({
                text: '帮我看下这段引用',
                messageType: 'text',
            });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm2_learning_apply',
                msgtype: 'text',
                text: { content: '/learn global 引用原文不可见时，不要猜内容，先让用户补发原文。' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        runtime.channel.reply.finalizeInboundContext.mockClear();

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: {
                dmPolicy: 'open',
                messageType: 'markdown',
                showThinking: false,
                learningEnabled: true,
            } as any,
            data: {
                msgId: 'm2_learning_context',
                msgtype: 'text',
                text: { content: '帮我看下这段引用' },
                conversationType: '1',
                conversationId: 'cid_dm_user',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                GroupSystemPrompt: expect.stringContaining('[高优先级学习约束]'),
            }),
        );
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                GroupSystemPrompt: expect.stringContaining('引用原文不可见时，不要猜内容，先让用户补发原文。'),
            }),
        );
    });

    it('reads /learn session notes from accountStorePath so they can be injected on the next turn', async () => {
        const runtime = buildRuntime();
        runtime.channel.session.resolveStorePath = vi
            .fn()
            .mockReturnValueOnce('/tmp/agent-store.json')
            .mockReturnValueOnce('/tmp/account-store.json')
            .mockReturnValueOnce('/tmp/agent-store.json')
            .mockReturnValueOnce('/tmp/account-store.json');
        shared.getRuntimeMock.mockReturnValue(runtime);
        shared.extractMessageContentMock
            .mockReturnValueOnce({
                text: '/learn session 回复当前私聊时，先说这是 session 规则。',
                messageType: 'text',
            })
            .mockReturnValueOnce({
                text: '测试一下当前私聊规则',
                messageType: 'text',
            });

        await handleDingTalkMessage({
            cfg: { commands: { ownerAllowFrom: ['dingtalk:owner-test-id'] } },
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'm_session_apply',
                msgtype: 'text',
                text: { content: '/learn session 回复当前私聊时，先说这是 session 规则。' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        runtime.channel.reply.finalizeInboundContext.mockClear();

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: {
                dmPolicy: 'open',
                messageType: 'markdown',
                showThinking: false,
                learningEnabled: true,
            } as any,
            data: {
                msgId: 'm_session_context',
                msgtype: 'text',
                text: { content: '测试一下当前私聊规则' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                GroupSystemPrompt: expect.stringContaining('回复当前私聊时，先说这是 session 规则。'),
            }),
        );
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
        expect(shared.appendQuoteJournalEntryMock).toHaveBeenCalled();
    });

    it('appends inbound quote journal entry with store/account/session context', async () => {
        const runtime = buildRuntime();
        runtime.channel.session.resolveStorePath = vi
            .fn()
            .mockReturnValueOnce('/tmp/agent-store.json')
            .mockReturnValueOnce('/tmp/account-store.json');
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', journalTTLDays: 9 } as any,
            data: {
                msgId: 'm_journal_1',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: 1700000000000,
            },
        } as any);

        expect(shared.appendQuoteJournalEntryMock).toHaveBeenCalledWith(
            expect.objectContaining({
                storePath: '/tmp/account-store.json',
                accountId: 'main',
                conversationId: 'cid_ok',
                msgId: 'm_journal_1',
                messageType: 'text',
                text: 'hello',
                createdAt: 1700000000000,
                ttlDays: 9,
            }),
        );
    });

    it('resolves originalMsgId via quote journal and prepends recovered quoted text', async () => {
        const runtime = buildRuntime();
        runtime.channel.session.resolveStorePath = vi
            .fn()
            .mockReturnValueOnce('/tmp/dm-agent-store.json')
            .mockReturnValueOnce('/tmp/dm-account-store.json');
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '[这是一条引用消息，原消息ID: orig_msg_001]\n\nhello',
            messageType: 'text',
        });
        shared.resolveQuotedMessageByIdMock.mockReturnValueOnce({
            msgId: 'orig_msg_001',
            text: '历史原文',
            createdAt: Date.now() - 1000,
        });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', journalTTLDays: 11 } as any,
            data: {
                msgId: 'm_quote_1',
                msgtype: 'text',
                text: { content: 'hello', isReplyMsg: true },
                originalMsgId: 'orig_msg_001',
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.resolveQuotedMessageByIdMock).toHaveBeenCalledWith(
            expect.objectContaining({
                accountId: 'main',
                conversationId: 'cid_ok',
                originalMsgId: 'orig_msg_001',
                ttlDays: 11,
            }),
        );

        const envelopeArg = (runtime.channel.reply.formatInboundEnvelope as any).mock.calls[0]?.[0];
        expect(envelopeArg.body).toContain('[引用消息: "历史原文"]');
    });

    it('writes normalized inbound journal text without quoted prefix noise', async () => {
        const runtime = buildRuntime();
        runtime.channel.session.resolveStorePath = vi
            .fn()
            .mockReturnValueOnce('/tmp/dm-agent-store.json')
            .mockReturnValueOnce('/tmp/dm-account-store.json');
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '[引用消息: "历史原文"]\n\n真正正文',
            messageType: 'text',
        });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown' } as any,
            data: {
                msgId: 'm_prefixed_1',
                msgtype: 'text',
                text: { content: '真正正文', isReplyMsg: true },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: 1700000000000,
            },
        } as any);

        expect(shared.appendQuoteJournalEntryMock).toHaveBeenCalledWith(
            expect.objectContaining({
                text: '真正正文',
            }),
        );
    });

    it('uses DingTalk DM conversationId for journal writes instead of senderId', async () => {
        const runtime = buildRuntime();
        runtime.channel.session.resolveStorePath = vi
            .fn()
            .mockReturnValueOnce('/tmp/dm-agent-store.json')
            .mockReturnValueOnce('/tmp/dm-account-store.json');
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown' } as any,
            data: {
                msgId: 'm_dm_1',
                msgtype: 'text',
                text: { content: 'hello dm' },
                conversationType: '1',
                conversationId: 'cid_dm_stable',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: 1700000000000,
            },
        } as any);

        expect(shared.appendQuoteJournalEntryMock).toHaveBeenCalledWith(
            expect.objectContaining({
                conversationId: 'cid_dm_stable',
            }),
        );
        expect(shared.appendQuoteJournalEntryMock).not.toHaveBeenCalledWith(
            expect.objectContaining({
                conversationId: 'user_1',
            }),
        );
    });

    it('still resolves originalMsgId when body text happens to contain quote marker text', async () => {
        const runtime = buildRuntime();
        runtime.channel.session.resolveStorePath = vi
            .fn()
            .mockReturnValueOnce('/tmp/dm-agent-store.json')
            .mockReturnValueOnce('/tmp/dm-account-store.json');
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '我在讨论字符串 [引用消息:] 本身',
            messageType: 'text',
        });
        shared.resolveQuotedMessageByIdMock.mockReturnValueOnce({
            msgId: 'orig_msg_literal',
            text: '被引用原文',
            createdAt: Date.now() - 1000,
        });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown' } as any,
            data: {
                msgId: 'm_literal_1',
                msgtype: 'text',
                text: { content: '我在讨论字符串 [引用消息:] 本身', isReplyMsg: true },
                originalMsgId: 'orig_msg_literal',
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        const envelopeArg = (runtime.channel.reply.formatInboundEnvelope as any).mock.calls[0]?.[0];
        expect(envelopeArg.body).toContain('[引用消息: "被引用原文"]');
        expect(shared.resolveQuotedMessageByIdMock).toHaveBeenCalledWith(
            expect.objectContaining({ originalMsgId: 'orig_msg_literal' }),
        );
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

    it('handleDingTalkMessage restores quoted card by originalProcessQueryKey', async () => {
        const runtime = buildRuntime();
        runtime.channel.session.resolveStorePath = vi
            .fn()
            .mockReturnValueOnce('/tmp/account-store.json')
            .mockReturnValueOnce('/tmp/agent-store.json');
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '[引用了机器人的回复]\n\nhello',
            messageType: 'text',
            quoted: {
                prefix: '[引用了机器人的回复]\n\n',
                isQuotedCard: true,
                processQueryKey: 'carrier_quoted_1',
            },
        });
        shared.getCardContentByProcessQueryKeyMock.mockReturnValueOnce('机器人之前的回复内容');

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'm5_card_quote',
                msgtype: 'text',
                text: { content: 'hello', isReplyMsg: true },
                originalProcessQueryKey: 'carrier_quoted_1',
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.getCardContentByProcessQueryKeyMock).toHaveBeenCalledWith(
            'main',
            'user_1',
            'carrier_quoted_1',
            '/tmp/account-store.json',
        );
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                RawBody: '[引用机器人回复: "机器人之前的回复内容"]\n\nhello',
            }),
        );
    });

    it('handleDingTalkMessage falls back to createdAt matcher only when processQueryKey is missing', async () => {
        const runtime = buildRuntime();
        runtime.channel.session.resolveStorePath = vi
            .fn()
            .mockReturnValueOnce('/tmp/account-store.json')
            .mockReturnValueOnce('/tmp/agent-store.json');
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '[引用了机器人的回复]\n\nhello',
            messageType: 'text',
            quoted: {
                prefix: '[引用了机器人的回复]\n\n',
                isQuotedCard: true,
                cardCreatedAt: 1772817989679,
            },
        });
        shared.findCardContentMock.mockReturnValueOnce('旧兼容卡片内容');

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'm5_card_fallback',
                msgtype: 'text',
                text: { content: 'hello', isReplyMsg: true },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.getCardContentByProcessQueryKeyMock).not.toHaveBeenCalled();
        expect(shared.findCardContentMock).toHaveBeenCalledWith(
            'main',
            'user_1',
            1772817989679,
            '/tmp/account-store.json',
        );
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                RawBody: '[引用机器人回复: "旧兼容卡片内容"]\n\nhello',
            }),
        );
    });

    it('handleDingTalkMessage persists group quoted file metadata after API fallback succeeds', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '[引用文件]\n\n群聊文件',
            messageType: 'text',
            quoted: {
                prefix: '[引用文件]\n\n',
                isQuotedFile: true,
                msgId: 'group_file_msg_1',
                fileCreatedAt: 1772863284581,
            },
        });
        shared.resolveQuotedFileMock.mockResolvedValueOnce({
            media: { path: '/tmp/.openclaw/media/inbound/group-file.bin', mimeType: 'application/octet-stream' },
            spaceId: 'space_group_1',
            fileId: 'dentry_group_1',
            name: 'a.sql',
        });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', robotCode: 'robot_1' } as any,
            data: {
                msgId: 'm_group_file_quote_1',
                msgtype: 'text',
                text: { content: '群聊文件', isReplyMsg: true },
                conversationType: '2',
                conversationId: 'cid_group_1',
                senderId: 'user_1',
                senderStaffId: 'staff_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.resolveQuotedFileMock).toHaveBeenCalledTimes(1);
        const restored = getCachedDownloadCode('main', 'cid_group_1', 'group_file_msg_1', '/tmp/store.json');
        expect(restored).not.toBeNull();
        expect(restored!.downloadCode).toBeUndefined();
        expect(restored!.spaceId).toBe('space_group_1');
        expect(restored!.fileId).toBe('dentry_group_1');
    });

    it('handleDingTalkMessage downloads single-chat doc card and persists msgId metadata', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '[钉钉文档]\n\n',
            messageType: 'interactiveCardFile',
            docSpaceId: 'space_doc_1',
            docFileId: 'file_doc_1',
        });
        shared.downloadGroupFileMock.mockResolvedValueOnce({
            path: '/tmp/.openclaw/media/inbound/doc-card.bin',
            mimeType: 'application/pdf',
        });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', robotCode: 'robot_1' } as any,
            data: {
                msgId: 'doc_origin_msg',
                msgtype: 'interactiveCard',
                content: {
                    biz_custom_action_url: 'dingtalk://dingtalkclient/page/yunpan?route=previewDentry&spaceId=space_doc_1&fileId=file_doc_1&type=file',
                },
                conversationType: '1',
                conversationId: 'cid_dm_1',
                senderId: 'user_1',
                senderStaffId: 'staff_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.getUnionIdByStaffIdMock).toHaveBeenCalledTimes(1);
        expect(shared.downloadGroupFileMock).toHaveBeenCalledWith(
            expect.anything(),
            'space_doc_1',
            'file_doc_1',
            'union_1',
            undefined,
        );
        const restored = getCachedDownloadCode('main', 'cid_dm_1', 'doc_origin_msg', '/tmp/store.json');
        expect(restored).not.toBeNull();
        expect(restored!.spaceId).toBe('space_doc_1');
        expect(restored!.fileId).toBe('file_doc_1');
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                MediaType: 'application/pdf',
                RawBody: '[钉钉文档]\n\n',
            }),
        );
    });

    it('handleDingTalkMessage restores quoted single-chat doc card from cached metadata', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        cacheInboundDownloadCode('main', 'cid_dm_2', 'doc_origin_msg_2', undefined, 'interactiveCardFile', Date.now(), {
            storePath: '/tmp/store.json',
            spaceId: 'space_doc_2',
            fileId: 'file_doc_2',
        });
        clearQuotedMsgCacheForTest();
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '[引用了钉钉文档]\n\n我引用了什么？',
            messageType: 'text',
            quoted: {
                prefix: '[引用了钉钉文档]\n\n',
                isQuotedDocCard: true,
                msgId: 'doc_origin_msg_2',
            },
        });
        shared.downloadGroupFileMock.mockResolvedValueOnce({
            path: '/tmp/.openclaw/media/inbound/doc-card-quoted.bin',
            mimeType: 'application/pdf',
        });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', robotCode: 'robot_1' } as any,
            data: {
                msgId: 'doc_quote_msg',
                msgtype: 'text',
                text: { content: '我引用了什么？', isReplyMsg: true },
                originalMsgId: 'doc_origin_msg_2',
                conversationType: '1',
                conversationId: 'cid_dm_2',
                senderId: 'user_1',
                senderStaffId: 'staff_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.downloadGroupFileMock).toHaveBeenCalledWith(
            expect.anything(),
            'space_doc_2',
            'file_doc_2',
            'union_1',
            undefined,
        );
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                RawBody: '[引用了钉钉文档]\n\n我引用了什么？',
                MediaType: 'application/pdf',
            }),
        );
    });

    it('handleDingTalkMessage degrades quoted doc card when cached metadata is unavailable', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        clearQuotedMsgCacheForTest();
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '[引用了钉钉文档]\n\n1',
            messageType: 'text',
            quoted: {
                prefix: '[引用了钉钉文档]\n\n',
                isQuotedDocCard: true,
                msgId: 'missing_doc_msg',
            },
        });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', robotCode: 'robot_1' } as any,
            data: {
                msgId: 'doc_quote_group_msg',
                msgtype: 'text',
                text: { content: '1', isReplyMsg: true },
                originalMsgId: 'missing_doc_msg',
                conversationType: '2',
                conversationId: 'cid_group_doc',
                senderId: 'user_1',
                senderStaffId: 'staff_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.resolveQuotedFileMock).not.toHaveBeenCalled();
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                RawBody: '[引用了钉钉文档，但无法获取内容]\n\n1',
            }),
        );
    });

    it('handleDingTalkMessage falls back to group-file resolution for quoted doc card in group chat', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        clearQuotedMsgCacheForTest();
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '[引用了钉钉文档]\n\n1',
            messageType: 'text',
            quoted: {
                prefix: '[引用了钉钉文档]\n\n',
                isQuotedDocCard: true,
                msgId: 'group_doc_msg',
                fileCreatedAt: 1772901945282,
            },
        });
        shared.resolveQuotedFileMock.mockResolvedValueOnce({
            media: { path: '/tmp/.openclaw/media/inbound/group-doc.bin', mimeType: 'application/pdf' },
            spaceId: 'space_group_doc',
            fileId: 'file_group_doc',
            name: 'doc.pdf',
        });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', robotCode: 'robot_1' } as any,
            data: {
                msgId: 'group_doc_quote',
                msgtype: 'text',
                text: { content: '1', isReplyMsg: true },
                originalMsgId: 'group_doc_msg',
                conversationType: '2',
                conversationId: 'cid_group_doc',
                senderId: 'user_1',
                senderStaffId: 'staff_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.resolveQuotedFileMock).toHaveBeenCalledWith(
            expect.anything(),
            {
                openConversationId: 'cid_group_doc',
                senderStaffId: 'staff_1',
                fileCreatedAt: 1772901945282,
            },
            undefined,
        );
        const restored = getCachedDownloadCode('main', 'cid_group_doc', 'group_doc_msg', '/tmp/store.json');
        expect(restored).not.toBeNull();
        expect(restored!.spaceId).toBe('space_group_doc');
        expect(restored!.fileId).toBe('file_group_doc');
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                RawBody: '[引用了钉钉文档]\n\n1',
                MediaType: 'application/pdf',
            }),
        );
    });

    it('handleDingTalkMessage restores group quoted file from persisted metadata without fallback query', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);
        clearQuotedMsgCacheForTest();
        cacheInboundDownloadCode('main', 'cid_group_2', 'file_origin', undefined, 'file', Date.now(), {
            storePath: '/tmp/store.json',
            spaceId: 'space_group_2',
            fileId: 'dentry_group_2',
        });
        clearQuotedMsgCacheForTest();
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '[引用文件]\n\n群聊文件',
            messageType: 'text',
            quoted: {
                prefix: '[引用文件]\n\n',
                isQuotedFile: true,
                msgId: 'file_origin',
                fileCreatedAt: 1772863284581,
            },
        });
        shared.downloadGroupFileMock.mockResolvedValueOnce({
            path: '/tmp/.openclaw/media/inbound/group-file.bin',
            mimeType: 'application/octet-stream',
        });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', robotCode: 'robot_1' } as any,
            data: {
                msgId: 'm_group_file_quote_2',
                msgtype: 'text',
                text: { content: '群聊文件', isReplyMsg: true },
                conversationType: '2',
                conversationId: 'cid_group_2',
                senderId: 'user_1',
                senderStaffId: 'staff_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.resolveQuotedFileMock).not.toHaveBeenCalled();
        expect(shared.getUnionIdByStaffIdMock).toHaveBeenCalledTimes(1);
        expect(shared.downloadGroupFileMock).toHaveBeenCalledWith(
            expect.anything(),
            'space_group_2',
            'dentry_group_2',
            'union_1',
            undefined,
        );
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

    it('handleDingTalkMessage falls back to markdown sends when createAICard returns null', async () => {
        shared.createAICardMock.mockResolvedValueOnce(null);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', showThinking: false } as any,
            data: {
                msgId: 'm6_card_degrade',
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
        expect(shared.finishAICardMock).not.toHaveBeenCalled();
        expect(shared.sendMessageMock).toHaveBeenCalled();
        const cardSends = shared.sendMessageMock.mock.calls.filter((call: any[]) => call[3]?.card);
        expect(cardSends).toHaveLength(0);
    });

    it('handleDingTalkMessage finalizes card using tool stream content when no final text exists', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions }) => {
                await dispatcherOptions.deliver({ text: 'tool output' }, { kind: 'tool' });
                return { queuedFinal: false };
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

    it('uses payload.text for outbound reply delivery even when markdown is present', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions }) => {
                await dispatcherOptions.deliver(
                    { text: 'plain text reply', markdown: 'stale markdown reply' },
                    { kind: 'final' }
                );
                return { queuedFinal: false };
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'm_payload_text_only',
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

        expect(shared.sendMessageMock).toHaveBeenCalledWith(
            expect.anything(),
            'user_1',
            'plain text reply',
            expect.objectContaining({ card: undefined }),
        );
        expect(shared.sendMessageMock).not.toHaveBeenCalledWith(
            expect.anything(),
            'user_1',
            'stale markdown reply',
            expect.anything(),
        );
    });

    it('streams reasoning updates to card in replace mode', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ replyOptions }) => {
                await replyOptions?.onReasoningStream?.({ text: 'thinking pass 1' });
                return { queuedFinal: false };
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        const card = { cardInstanceId: 'card_reasoning_replace', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', showThinking: false } as any,
            data: {
                msgId: 'm_reasoning_replace',
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

        expect(shared.sendMessageMock).toHaveBeenCalledWith(
            expect.anything(),
            'user_1',
            'thinking pass 1',
            expect.objectContaining({ card, cardUpdateMode: 'replace' }),
        );
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

    it('matches proactive permission hint risk using senderOriginalId when senderStaffId is present', async () => {
        recordProactiveRiskObservation({
            accountId: 'main',
            targetId: 'raw_sender_1',
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
                msgId: 'm11_raw_id',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'raw_sender_1',
                senderStaffId: 'staff_sender_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(String(shared.sendBySessionMock.mock.calls[0]?.[2])).toContain('主动推送可能失败');
    });

    it('injects group turn context prompt with authoritative sender metadata', async () => {
        const runtime = buildRuntime();
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { groupPolicy: 'open', messageType: 'markdown', showThinking: false } as any,
            data: {
                msgId: 'm_group_turn_ctx',
                msgtype: 'text',
                text: { content: 'hello group' },
                conversationType: '2',
                conversationId: 'cid_group_ctx',
                conversationTitle: 'Dev Group',
                senderId: 'raw_sender_1',
                senderStaffId: 'staff_sender_1',
                senderNick: 'Alice',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                GroupSystemPrompt: expect.stringContaining('Current DingTalk group turn context:'),
            }),
        );
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                GroupSystemPrompt: expect.stringContaining('senderDingtalkId: staff_sender_1'),
            }),
        );
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                GroupSystemPrompt: expect.stringContaining('senderName: Alice'),
            }),
        );
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
