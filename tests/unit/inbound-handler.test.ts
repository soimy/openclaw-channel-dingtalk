import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccessToken } from '../../src/auth';

const shared = vi.hoisted(() => ({
    sendBySessionMock: vi.fn(),
    sendMessageMock: vi.fn(),
    sendProactiveMediaMock: vi.fn(),
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
    extractAttachmentTextMock: vi.fn(),
    prepareMediaInputMock: vi.fn(),
    resolveOutboundMediaTypeMock: vi.fn(),
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

vi.mock('../../src/attachment-text-extractor', () => ({
    extractAttachmentText: shared.extractAttachmentTextMock,
}));

vi.mock('../../src/send-service', () => ({
    sendBySession: shared.sendBySessionMock,
    sendMessage: shared.sendMessageMock,
    sendProactiveMedia: shared.sendProactiveMediaMock,
}));

vi.mock('../../src/media-utils', async () => {
    const actual = await vi.importActual<typeof import('../../src/media-utils')>('../../src/media-utils');
    return {
        ...actual,
        prepareMediaInput: shared.prepareMediaInputMock,
        resolveOutboundMediaType: shared.resolveOutboundMediaTypeMock,
    };
});

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
const mockedGetAccessToken = vi.mocked(getAccessToken);

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
        mockedGetAccessToken.mockReset();
        mockedGetAccessToken.mockResolvedValue('token_abc');
        shared.sendBySessionMock.mockReset();
        shared.sendMessageMock.mockReset();
        shared.sendProactiveMediaMock.mockReset();
        shared.sendProactiveMediaMock.mockResolvedValue({ ok: true });
        shared.prepareMediaInputMock.mockReset();
        shared.prepareMediaInputMock.mockImplementation(async (rawMediaUrl: string) => ({
            path: `/tmp/prepared/${path.basename(rawMediaUrl) || 'media.bin'}`,
            cleanup: vi.fn().mockResolvedValue(undefined),
        }));
        shared.resolveOutboundMediaTypeMock.mockReset();
        shared.resolveOutboundMediaTypeMock.mockReturnValue('file');
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
        shared.extractAttachmentTextMock.mockReset();
        shared.extractAttachmentTextMock.mockResolvedValue(null);

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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
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
            dingtalkConfig: { groupPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
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
            dingtalkConfig: { groupPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
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
            dingtalkConfig: { groupPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
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
                ackReaction: '',
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
                ackReaction: '',
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '🤔思考中' } as any,
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
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

    it('handleDingTalkMessage injects extracted attachment text into inbound context', async () => {
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
        shared.extractAttachmentTextMock.mockResolvedValueOnce({
            text: '第一段\n第二段',
            sourceType: 'pdf',
            truncated: false,
        });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', robotCode: 'robot_1' } as any,
            data: {
                msgId: 'doc_origin_msg_extract',
                msgtype: 'interactiveCard',
                content: {
                    fileName: 'manual.pdf',
                    biz_custom_action_url: 'dingtalk://dingtalkclient/page/yunpan?route=previewDentry&spaceId=space_doc_1&fileId=file_doc_1&type=file',
                },
                conversationType: '1',
                conversationId: 'cid_dm_extract',
                senderId: 'user_1',
                senderStaffId: 'staff_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.extractAttachmentTextMock).toHaveBeenCalledWith({
            path: '/tmp/.openclaw/media/inbound/doc-card.bin',
            mimeType: 'application/pdf',
            fileName: 'manual.pdf',
        });
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                RawBody: '[钉钉文档]\n\n\n\n[附件内容摘录]\n第一段\n第二段',
                CommandBody: '[钉钉文档]\n\n\n\n[附件内容摘录]\n第一段\n第二段',
            }),
        );
    });

    it('handleDingTalkMessage keeps processing when attachment extraction fails', async () => {
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
        shared.extractAttachmentTextMock.mockRejectedValueOnce(new Error('parse failed'));
        const log = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        };

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', robotCode: 'robot_1' } as any,
            data: {
                msgId: 'doc_origin_msg_extract_error',
                msgtype: 'interactiveCard',
                content: {
                    fileName: 'manual.pdf',
                    biz_custom_action_url: 'dingtalk://dingtalkclient/page/yunpan?route=previewDentry&spaceId=space_doc_1&fileId=file_doc_1&type=file',
                },
                conversationType: '1',
                conversationId: 'cid_dm_extract_error',
                senderId: 'user_1',
                senderStaffId: 'staff_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(log.warn).toHaveBeenCalledWith('[DingTalk] Failed to extract attachment text: parse failed');
        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', ackReaction: '' } as any,
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
        expect(shared.finishAICardMock).toHaveBeenCalledWith(card, '✅ Done', undefined);
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

        expect(shared.finishAICardMock).not.toHaveBeenCalled();
    });

    it('deliver callback sends single media payload through session webhook', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions }) => {
                await dispatcherOptions.deliver({ mediaUrl: 'https://cdn.example.com/report.pdf' }, { kind: 'final' });
                return { queuedFinal: false };
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        const cleanup = vi.fn().mockResolvedValue(undefined);
        shared.prepareMediaInputMock.mockResolvedValueOnce({
            path: '/tmp/prepared/report.pdf',
            cleanup,
        });
        shared.resolveOutboundMediaTypeMock.mockReturnValueOnce('file');

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
            data: {
                msgId: 'm_media_single',
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

        expect(shared.prepareMediaInputMock).toHaveBeenCalledWith(
            'https://cdn.example.com/report.pdf',
            undefined,
            undefined,
        );
        expect(shared.sendBySessionMock).toHaveBeenCalledWith(
            expect.anything(),
            'https://session.webhook',
            '',
            expect.objectContaining({ mediaPath: '/tmp/prepared/report.pdf', mediaType: 'file' }),
        );
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('deliver callback sends multiple media payloads sequentially', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions }) => {
                await dispatcherOptions.deliver(
                    { mediaUrls: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'] },
                    { kind: 'final' },
                );
                return { queuedFinal: false };
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        const cleanupA = vi.fn().mockResolvedValue(undefined);
        const cleanupB = vi.fn().mockResolvedValue(undefined);
        shared.prepareMediaInputMock
            .mockResolvedValueOnce({ path: '/tmp/prepared/a.png', cleanup: cleanupA })
            .mockResolvedValueOnce({ path: '/tmp/prepared/b.png', cleanup: cleanupB });
        shared.resolveOutboundMediaTypeMock.mockReturnValue('image');

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
            data: {
                msgId: 'm_media_multi',
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

        expect(shared.sendBySessionMock).toHaveBeenNthCalledWith(
            1,
            expect.anything(),
            'https://session.webhook',
            '',
            expect.objectContaining({ mediaPath: '/tmp/prepared/a.png', mediaType: 'image' }),
        );
        expect(shared.sendBySessionMock).toHaveBeenNthCalledWith(
            2,
            expect.anything(),
            'https://session.webhook',
            '',
            expect.objectContaining({ mediaPath: '/tmp/prepared/b.png', mediaType: 'image' }),
        );
        expect(cleanupA).toHaveBeenCalledTimes(1);
        expect(cleanupB).toHaveBeenCalledTimes(1);
    });

    it('deliver callback sends mixed text and media payloads', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions }) => {
                await dispatcherOptions.deliver(
                    { text: 'final output', mediaUrl: 'https://cdn.example.com/report.pdf' },
                    { kind: 'final' },
                );
                return { queuedFinal: false };
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
            data: {
                msgId: 'm_media_text',
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

        expect(shared.sendBySessionMock).toHaveBeenCalledWith(
            expect.anything(),
            'https://session.webhook',
            '',
            expect.objectContaining({ mediaPath: '/tmp/prepared/report.pdf', mediaType: 'file' }),
        );
        expect(shared.sendMessageMock).toHaveBeenCalledWith(
            expect.anything(),
            'user_1',
            'final output',
            expect.objectContaining({ sessionWebhook: 'https://session.webhook' }),
        );
    });

    it('card mode + media bypasses finalContent accumulation and still finalizes with text', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions }) => {
                await dispatcherOptions.deliver(
                    { text: 'final output', mediaUrl: 'https://cdn.example.com/report.pdf' },
                    { kind: 'final' },
                );
                return { queuedFinal: true };
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        const card = { cardInstanceId: 'card_media_final', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', ackReaction: '' } as any,
            data: {
                msgId: 'm_card_media_text',
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

        expect(shared.sendBySessionMock).toHaveBeenCalledWith(
            expect.anything(),
            'https://session.webhook',
            '',
            expect.objectContaining({ mediaPath: '/tmp/prepared/report.pdf', mediaType: 'file' }),
        );
        expect(shared.finishAICardMock).toHaveBeenCalledWith(card, 'final output', undefined);
    });

    it('deliver callback falls back to proactive media send when sessionWebhook is absent', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions }) => {
                await dispatcherOptions.deliver({ mediaUrl: 'https://cdn.example.com/report.pdf' }, { kind: 'final' });
                return { queuedFinal: false };
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: undefined,
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
            data: {
                msgId: 'm_media_proactive',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).not.toHaveBeenCalled();
        expect(shared.sendProactiveMediaMock).toHaveBeenCalledWith(
            expect.anything(),
            'user_1',
            '/tmp/prepared/report.pdf',
            'file',
            expect.objectContaining({ accountId: 'main' }),
        );
    });

    it('deliver callback cleans up prepared media when send fails', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions }) => {
                await dispatcherOptions.deliver({ mediaUrl: 'https://cdn.example.com/report.pdf' }, { kind: 'final' });
                return { queuedFinal: false };
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        const cleanup = vi.fn().mockResolvedValue(undefined);
        shared.prepareMediaInputMock.mockResolvedValueOnce({
            path: '/tmp/prepared/report.pdf',
            cleanup,
        });
        shared.sendBySessionMock.mockRejectedValueOnce(new Error('send failed'));

        await expect(handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
            data: {
                msgId: 'm_media_cleanup_failure',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any)).rejects.toThrow('send failed');

        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('handleDingTalkMessage attaches and recalls native ack reaction in markdown mode', async () => {
        vi.useFakeTimers();
        mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
        const releaseFn = vi.fn();
        shared.acquireSessionLockMock.mockResolvedValueOnce(releaseFn);
        try {
            await handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: {
                    clientId: 'ding_client',
                    clientSecret: 'secret',
                    dmPolicy: 'open',
                    messageType: 'markdown',
                    ackReaction: '🤔思考中',
                } as any,
                data: {
                    msgId: 'm5_reaction',
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
            await vi.advanceTimersByTimeAsync(1200);

            expect(mockedAxiosPost).toHaveBeenNthCalledWith(
                1,
                'https://api.dingtalk.com/v1.0/robot/emotion/reply',
                expect.objectContaining({
                    robotCode: 'ding_client',
                    openMsgId: 'm5_reaction',
                    openConversationId: 'cid_ok',
                    emotionName: '🤔思考中',
                }),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'x-acs-dingtalk-access-token': 'token_abc',
                    }),
                }),
            );
            expect(mockedAxiosPost).toHaveBeenNthCalledWith(
                2,
                'https://api.dingtalk.com/v1.0/robot/emotion/recall',
                expect.objectContaining({
                    robotCode: 'ding_client',
                    openMsgId: 'm5_reaction',
                    openConversationId: 'cid_ok',
                    emotionName: '🤔思考中',
                }),
                expect.any(Object),
            );
            expect(mockedAxiosPost.mock.invocationCallOrder[0]).toBeLessThan(
                shared.acquireSessionLockMock.mock.invocationCallOrder[0],
            );
            expect(releaseFn.mock.invocationCallOrder[0]).toBeLessThan(
                mockedAxiosPost.mock.invocationCallOrder[1],
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('handleDingTalkMessage uses native ack reaction when ackReaction is configured', async () => {
        vi.useFakeTimers();
        mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
        try {
            await handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: {
                    clientId: 'ding_client',
                    clientSecret: 'secret',
                    dmPolicy: 'open',
                    messageType: 'markdown',
                    ackReaction: '🤔思考中',
                } as any,
                data: {
                    msgId: 'm5_ackreaction_native',
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
            await vi.advanceTimersByTimeAsync(1200);

            expect(mockedAxiosPost).toHaveBeenNthCalledWith(
                1,
                'https://api.dingtalk.com/v1.0/robot/emotion/reply',
                expect.objectContaining({
                    openMsgId: 'm5_ackreaction_native',
                    openConversationId: 'cid_ok',
                    emotionName: '🤔思考中',
                }),
                expect.any(Object),
            );
            const sentTexts = shared.sendMessageMock.mock.calls.map((call: any[]) => String(call[2] ?? ''));
            expect(sentTexts.some((text: string) => text.includes('思考中'))).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('handleDingTalkMessage falls back to global messages.ackReaction when channel ackReaction is absent', async () => {
        vi.useFakeTimers();
        mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
        try {
            await handleDingTalkMessage({
                cfg: { messages: { ackReaction: '👀' } },
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: {
                    clientId: 'ding_client',
                    clientSecret: 'secret',
                    dmPolicy: 'open',
                    messageType: 'markdown',
                } as any,
                data: {
                    msgId: 'm5_global_ackreaction',
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
            await vi.advanceTimersByTimeAsync(1200);

            expect(mockedAxiosPost).toHaveBeenNthCalledWith(
                1,
                'https://api.dingtalk.com/v1.0/robot/emotion/reply',
                expect.objectContaining({
                    openMsgId: 'm5_global_ackreaction',
                    openConversationId: 'cid_ok',
                    emotionName: '👀',
                    textEmotion: expect.objectContaining({
                        emotionId: '2659900',
                        emotionName: '👀',
                        text: '👀',
                    }),
                }),
                expect.any(Object),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('handleDingTalkMessage falls back to agent identity emoji when account channel and messages ackReaction are absent', async () => {
        vi.useFakeTimers();
        mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
        try {
            await handleDingTalkMessage({
                cfg: {
                    agents: {
                        list: [
                            {
                                id: 'main',
                                identity: { emoji: '👀' },
                            },
                        ],
                    },
                },
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: {
                    clientId: 'ding_client',
                    clientSecret: 'secret',
                    dmPolicy: 'open',
                    messageType: 'markdown',
                } as any,
                data: {
                    msgId: 'm5_identity_ackreaction',
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
            await vi.advanceTimersByTimeAsync(1200);

            expect(mockedAxiosPost).toHaveBeenNthCalledWith(
                1,
                'https://api.dingtalk.com/v1.0/robot/emotion/reply',
                expect.objectContaining({
                    openMsgId: 'm5_identity_ackreaction',
                    openConversationId: 'cid_ok',
                    emotionName: '👀',
                    textEmotion: expect.objectContaining({
                        emotionId: '2659900',
                        emotionName: '👀',
                        text: '👀',
                    }),
                }),
                expect.any(Object),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('handleDingTalkMessage classifies emoji reaction when ackReaction=emoji', async () => {
        vi.useFakeTimers();
        mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
        shared.extractMessageContentMock.mockReturnValueOnce({
            text: '你真棒，快夸夸我',
            messageType: 'text',
        });
        try {
            await handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: {
                    clientId: 'ding_client',
                    clientSecret: 'secret',
                    dmPolicy: 'open',
                    messageType: 'markdown',
                    ackReaction: 'emoji',
                } as any,
                data: {
                    msgId: 'm5_emoji_ackreaction',
                    msgtype: 'text',
                    text: { content: '你真棒，快夸夸我' },
                    conversationType: '1',
                    conversationId: 'cid_ok',
                    senderId: 'user_1',
                    chatbotUserId: 'bot_1',
                    sessionWebhook: 'https://session.webhook',
                    createAt: Date.now(),
                },
            } as any);
            await vi.advanceTimersByTimeAsync(1200);

            expect(mockedAxiosPost).toHaveBeenNthCalledWith(
                1,
                'https://api.dingtalk.com/v1.0/robot/emotion/reply',
                expect.objectContaining({
                    openMsgId: 'm5_emoji_ackreaction',
                    openConversationId: 'cid_ok',
                    emotionName: '叽 (๑•̀ㅂ•́)و✧',
                    textEmotion: expect.objectContaining({
                        emotionId: '2659900',
                        emotionName: '叽 (๑•̀ㅂ•́)و✧',
                        text: '叽 (๑•̀ㅂ•́)و✧',
                    }),
                }),
                expect.any(Object),
            );
            expect(mockedAxiosPost).toHaveBeenNthCalledWith(
                2,
                'https://api.dingtalk.com/v1.0/robot/emotion/recall',
                expect.objectContaining({
                    openMsgId: 'm5_emoji_ackreaction',
                    openConversationId: 'cid_ok',
                    emotionName: '叽 (๑•̀ㅂ•́)و✧',
                }),
                expect.any(Object),
            );
        } finally {
            randomSpy.mockRestore();
            vi.useRealTimers();
        }
    });

    it('handleDingTalkMessage attaches default ack reaction (👀) when config and agent identity ackReaction are absent', async () => {
        vi.useFakeTimers();
        mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
        try {
            await handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: {
                    clientId: 'ding_client',
                    clientSecret: 'secret',
                    dmPolicy: 'open',
                    messageType: 'markdown',
                } as any,
                data: {
                    msgId: 'm5_default_ackreaction',
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
            await vi.advanceTimersByTimeAsync(1200);

            expect(mockedAxiosPost).toHaveBeenCalledWith(
                'https://api.dingtalk.com/v1.0/robot/emotion/reply',
                expect.objectContaining({
                    openMsgId: 'm5_default_ackreaction',
                    openConversationId: 'cid_ok',
                    emotionName: '👀',
                }),
                expect.any(Object),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('handleDingTalkMessage does not send standalone thinking message when ackReaction is enabled', async () => {
        vi.useFakeTimers();
        mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
        try {
            await handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: {
                    clientId: 'ding_client',
                    clientSecret: 'secret',
                    dmPolicy: 'open',
                    messageType: 'markdown',
                    ackReaction: '🤔思考中',
                } as any,
                data: {
                    msgId: 'm5_reaction_prefer',
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
            await vi.advanceTimersByTimeAsync(1200);

            expect(mockedAxiosPost).toHaveBeenCalledTimes(2);
            const sentTexts = shared.sendMessageMock.mock.calls.map((call: any[]) => String(call[2] ?? ''));
            expect(sentTexts.some((text: string) => text.includes('思考中'))).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('handleDingTalkMessage attaches native ack reaction in card mode', async () => {
        vi.useFakeTimers();
        mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
        try {
            await handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: {
                    clientId: 'ding_client',
                    clientSecret: 'secret',
                    dmPolicy: 'open',
                    messageType: 'card',
                    ackReaction: '🤔思考中',
                } as any,
                data: {
                    msgId: 'm5_card_reaction',
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
            await vi.advanceTimersByTimeAsync(1200);

            expect(mockedAxiosPost).toHaveBeenNthCalledWith(
                1,
                'https://api.dingtalk.com/v1.0/robot/emotion/reply',
                expect.objectContaining({
                    openMsgId: 'm5_card_reaction',
                    openConversationId: 'cid_ok',
                }),
                expect.any(Object),
            );
            expect(mockedAxiosPost).toHaveBeenNthCalledWith(
                2,
                'https://api.dingtalk.com/v1.0/robot/emotion/recall',
                expect.objectContaining({
                    openMsgId: 'm5_card_reaction',
                    openConversationId: 'cid_ok',
                    emotionName: '🤔思考中',
                }),
                expect.any(Object),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('handleDingTalkMessage keeps native ack reaction when configured card mode falls back', async () => {
        vi.useFakeTimers();
        shared.createAICardMock.mockResolvedValueOnce(null);
        mockedAxiosPost.mockResolvedValue({ data: { success: true } } as any);
        try {
            await handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: {
                    clientId: 'ding_client',
                    clientSecret: 'secret',
                    dmPolicy: 'open',
                    messageType: 'card',
                    ackReaction: '🤔思考中',
                } as any,
                data: {
                    msgId: 'm5_card_fallback_reaction',
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
            await vi.advanceTimersByTimeAsync(1200);

            expect(mockedAxiosPost).toHaveBeenCalledTimes(2);
            expect(shared.sendMessageMock).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('handleDingTalkMessage continues when native ack reaction attach fails', async () => {
        mockedAxiosPost.mockRejectedValueOnce(new Error('reaction failed'));

        await expect(handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: {
                clientId: 'ding_client',
                clientSecret: 'secret',
                dmPolicy: 'open',
                messageType: 'markdown',
                ackReaction: '🤔思考中',
            } as any,
            data: {
                msgId: 'm5_reaction_fail',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any)).resolves.toBeUndefined();

        expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
        const sentTexts = shared.sendMessageMock.mock.calls.map((call: any[]) => String(call[2] ?? ''));
        expect(sentTexts.some((text: string) => text.includes('思考中'))).toBe(false);
    });

    it('handleDingTalkMessage does not recall when native ack reaction attach fails', async () => {
        vi.useFakeTimers();
        mockedAxiosPost.mockRejectedValueOnce(new Error('reaction failed'));

        try {
            await expect(handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: {
                    clientId: 'ding_client',
                    clientSecret: 'secret',
                    dmPolicy: 'open',
                    messageType: 'markdown',
                    ackReaction: '🤔思考中',
                } as any,
                data: {
                    msgId: 'm5_reaction_fail_no_recall',
                    msgtype: 'text',
                    text: { content: 'hello' },
                    conversationType: '1',
                    conversationId: 'cid_ok',
                    senderId: 'user_1',
                    chatbotUserId: 'bot_1',
                    sessionWebhook: 'https://session.webhook',
                    createAt: Date.now(),
                },
            } as any)).resolves.toBeUndefined();

            await vi.advanceTimersByTimeAsync(6000);

            expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
            expect(mockedAxiosPost).toHaveBeenCalledWith(
                'https://api.dingtalk.com/v1.0/robot/emotion/reply',
                expect.any(Object),
                expect.any(Object),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('handleDingTalkMessage does not fall back to standalone thinking message when reaction attach fails', async () => {
        mockedAxiosPost.mockRejectedValueOnce(new Error('reaction failed'));

        await expect(handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: {
                clientId: 'ding_client',
                clientSecret: 'secret',
                dmPolicy: 'open',
                messageType: 'markdown',
                ackReaction: '🤔思考中',
            } as any,
            data: {
                msgId: 'm5_reaction_fail_fallback',
                msgtype: 'text',
                text: { content: 'hello' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any)).resolves.toBeUndefined();

        expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
        const sentTexts = shared.sendMessageMock.mock.calls.map((call: any[]) => String(call[2] ?? ''));
        expect(sentTexts.some((text: string) => text.includes('思考中'))).toBe(false);
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

        expect(shared.sendMessageMock).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'tool output',
            expect.objectContaining({ cardUpdateMode: 'append' }),
        );
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
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
            expect.not.objectContaining({ card: expect.anything() }),
        );
        expect(shared.sendMessageMock).not.toHaveBeenCalledWith(
            expect.anything(),
            'user_1',
            'stale markdown reply',
            expect.anything(),
        );
    });

    it('streams reasoning updates to card via controller (streamAICard)', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
                await replyOptions?.onReasoningStream?.({ text: 'thinking pass 1' });
                await dispatcherOptions.deliver({ text: 'done' }, { kind: 'final' });
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', ackReaction: '', cardRealTimeStream: true } as any,
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

        expect(shared.streamAICardMock).toHaveBeenCalledWith(
            card,
            expect.stringContaining('thinking pass 1'),
            false,
            undefined,
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
                ackReaction: '',
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
                ackReaction: '',
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
                ackReaction: '',
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
                ackReaction: '',
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
            dingtalkConfig: { groupPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', ackReaction: '' } as any,
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', ackReaction: '' } as any,
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', ackReaction: '' } as any,
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

    it('sends markdown fallback in post-dispatch when card fails mid-stream', async () => {
        const card = { cardInstanceId: 'card_mid_fail', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockImplementation((state: string) => state === '3' || state === '5');

        shared.streamAICardMock.mockImplementation(async () => {
            card.state = '5';
            throw new Error('stream api error');
        });

        const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };

        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
                replyOptions?.onPartialReply?.({ text: 'partial content' });
                await new Promise((r) => setTimeout(r, 350));
                await dispatcherOptions.deliver({ text: 'complete final answer' }, { kind: 'final' });
                return { queuedFinal: 'complete final answer' };
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: log as any,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', cardRealTimeStream: true } as any,
            data: {
                msgId: 'mid_fail_test', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        const debugLogs = log.debug.mock.calls.map((args: unknown[]) => String(args[0]));
        expect(debugLogs.some((msg) => msg.includes('Card failed during streaming, sending markdown fallback'))).toBe(true);

        // Fallback now uses sendBySession directly (bypassing sendMessage to avoid
        // sendProactiveCardText creating a second card).
        expect(shared.sendBySessionMock).toHaveBeenCalled();
        const sessionCalls = shared.sendBySessionMock.mock.calls;
        const fallbackCall = sessionCalls.find((call: any[]) => call[2] === 'complete final answer');
        expect(fallbackCall).toBeTruthy();
    });

    it('acquires session lock with the resolved sessionKey', async () => {
        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'markdown', ackReaction: '' } as any,
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
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', ackReaction: '' } as any,
            data: {
                msgId: 'lock_crash_card', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any)).rejects.toThrow('dispatch crash');

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        expect(shared.finishAICardMock).toHaveBeenCalledWith(card, '❌ 处理失败', expect.anything());
    });

    it('cardRealTimeStream finalize uses accumulated multi-turn content instead of last-turn-only deliver text', async () => {
        const card = { cardInstanceId: 'card_accum', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
                // Turn 1
                replyOptions?.onPartialReply?.({ text: 'Turn 1: Full inspection report with tables and analysis' });
                await new Promise((r) => setTimeout(r, 350));

                // Runtime signals new assistant turn (after tool call)
                replyOptions?.onAssistantMessageStart?.();

                // Turn 2: text starts fresh
                replyOptions?.onPartialReply?.({ text: 'Turn 2 short summary' });
                await new Promise((r) => setTimeout(r, 350));

                // deliver(final) only provides last turn's text
                await dispatcherOptions.deliver({ text: 'Turn 2 short summary' }, { kind: 'final' });
                return {};
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', cardRealTimeStream: true, ackReaction: '', showThinking: false } as any,
            data: {
                msgId: 'mid_accum_test', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        const finalizeContent = shared.finishAICardMock.mock.calls[0][1];
        expect(finalizeContent).toContain('Turn 1');
        expect(finalizeContent).toContain('Turn 2');
        expect(finalizeContent).not.toBe('Turn 2 short summary');
    });

    it('card finalize with empty deliver(final) text still finalizes card instead of early-returning', async () => {
        const card = { cardInstanceId: 'card_empty_final', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions }) => {
                await dispatcherOptions.deliver({ text: '' }, { kind: 'final' });
                return {};
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', showThinking: false } as any,
            data: {
                msgId: 'mid_empty_final', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
    });

    it('cardRealTimeStream=false: finalize uses rawFinalText not reasoning content from controller', async () => {
        const card = { cardInstanceId: 'card_no_realtime', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
                replyOptions?.onReasoningStream?.({ text: 'deep thinking about the problem' });
                await new Promise((r) => setTimeout(r, 350));
                await dispatcherOptions.deliver({ text: 'Here is the final answer.' }, { kind: 'final' });
                return {};
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', showThinking: false, cardRealTimeStream: false } as any,
            data: {
                msgId: 'mid_norealtime', msgtype: 'text', text: { content: 'hello' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        const finalizeContent = shared.finishAICardMock.mock.calls[0][1];
        expect(finalizeContent).toBe('Here is the final answer.');
        expect(finalizeContent).not.toContain('思考中');
    });

    it('file-only response finalizes card with Done instead of reasoning content', async () => {
        const card = { cardInstanceId: 'card_file_only', state: '1', lastUpdated: Date.now() } as any;
        shared.createAICardMock.mockResolvedValueOnce(card);
        shared.isCardInTerminalStateMock.mockReturnValue(false);

        const runtime = buildRuntime();
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = vi
            .fn()
            .mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
                replyOptions?.onReasoningStream?.({ text: 'Let me send the file' });
                await new Promise((r) => setTimeout(r, 350));
                // Bot sent file via tool, deliver(final) has no text and no media
                await dispatcherOptions.deliver({ text: '' }, { kind: 'final' });
                return {};
            });
        shared.getRuntimeMock.mockReturnValueOnce(runtime);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', messageType: 'card', cardRealTimeStream: true, showThinking: false } as any,
            data: {
                msgId: 'mid_file_only', msgtype: 'text', text: { content: 'send me the file' },
                conversationType: '1', conversationId: 'cid_ok', senderId: 'user_1',
                chatbotUserId: 'bot_1', sessionWebhook: 'https://session.webhook', createAt: Date.now(),
            },
        } as any);

        expect(shared.finishAICardMock).toHaveBeenCalledTimes(1);
        const finalizeContent = shared.finishAICardMock.mock.calls[0][1];
        expect(finalizeContent).not.toContain('思考中');
        expect(finalizeContent).not.toContain('send');
    });
});
