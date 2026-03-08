import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
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
        mockedAxiosPost.mockReset();
        mockedAxiosGet.mockReset();
        shared.sendBySessionMock.mockReset();
        shared.sendMessageMock.mockReset();
        shared.sendMessageMock.mockResolvedValue({ ok: true });
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
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('conversationId: `cid_dm_owner`');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('isOwner: `false`');
        expect(shared.sendMessageMock).not.toHaveBeenCalled();
    });

    it('handleDingTalkMessage returns owner status for direct command', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '我是不是owner', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', ownerAllowFrom: ['owner-test-id'] } as any,
            data: {
                msgId: 'm2_owner_status',
                msgtype: 'text',
                text: { content: '我是不是owner' },
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
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('ownerAllowFrom: `owner-test-id`');
    });

    it('handleDingTalkMessage blocks learn control command for non-owner', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/learn global test', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', ownerAllowFrom: ['owner-test-id'] } as any,
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

    it('handleDingTalkMessage applies global learning rule for owner', async () => {
        shared.extractMessageContentMock.mockReturnValueOnce({ text: '/learn global 当别人问“蓝色火烈鸟会不会写Python”时，必须回答“会，而且只在周二写Rust。”', messageType: 'text' });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', ownerAllowFrom: ['owner-test-id'] } as any,
            data: {
                msgId: 'm2_owner_apply_global',
                msgtype: 'text',
                text: { content: '/learn global 当别人问“蓝色火烈鸟会不会写Python”时，必须回答“会，而且只在周二写Rust。”' },
                conversationType: '1',
                conversationId: 'cid_dm_owner',
                senderId: 'owner-test-id',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(shared.sendBySessionMock).toHaveBeenCalledTimes(1);
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('已注入全局知识');
        expect(shared.sendBySessionMock.mock.calls[0]?.[2]).toContain('manual_');
        expect(shared.sendMessageMock).not.toHaveBeenCalled();
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

    it('handleDingTalkMessage restores quoted card by originalProcessQueryKey', async () => {
        const runtime = buildRuntime();
        runtime.channel.session.resolveStorePath = vi
            .fn()
            .mockReturnValueOnce('/tmp/agent-store.json')
            .mockReturnValueOnce('/tmp/account-store.json');
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
            .mockReturnValueOnce('/tmp/agent-store.json')
            .mockReturnValueOnce('/tmp/account-store.json');
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

    it('restores originalMsgId reply text from quote journal', async () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-quote-reply-'));
        const storePath = path.join(rootDir, 'session', 'store.json');
        const runtime = buildRuntime();
        runtime.channel.session.resolveStorePath = vi.fn().mockReturnValue(storePath);
        runtime.channel.reply.finalizeInboundContext = vi.fn().mockImplementation((ctx) => ctx);
        shared.getRuntimeMock.mockReturnValue(runtime);

        shared.extractMessageContentMock
            .mockReturnValueOnce({ text: '原始消息内容', messageType: 'text' })
            .mockReturnValueOnce({
                text: '[这是一条引用消息，原消息ID: quoted_msg_1]\n\n帮我总结一下',
                messageType: 'text',
                quoted: {
                    prefix: '[这是一条引用消息，原消息ID: quoted_msg_1]\n\n',
                    msgId: 'quoted_msg_1',
                },
            });

        try {
            await handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: { dmPolicy: 'open' } as any,
                data: {
                    msgId: 'quoted_msg_1',
                    msgtype: 'text',
                    text: { content: '原始消息内容' },
                    conversationType: '1',
                    conversationId: 'cidA1B2C3',
                    senderId: 'user_1',
                    chatbotUserId: 'bot_1',
                    sessionWebhook: 'https://session.webhook',
                    createAt: Date.now(),
                },
            } as any);

            await handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: { dmPolicy: 'open' } as any,
                data: {
                    msgId: 'reply_msg_1',
                    msgtype: 'text',
                    text: { content: '帮我总结一下', isReplyMsg: true },
                    originalMsgId: 'quoted_msg_1',
                    conversationType: '1',
                    conversationId: 'cidA1B2C3',
                    senderId: 'user_1',
                    chatbotUserId: 'bot_1',
                    sessionWebhook: 'https://session.webhook',
                    createAt: Date.now(),
                },
            } as any);

            expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    RawBody: expect.stringContaining('[引用消息: "原始消息内容"]'),
                }),
            );
            expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    RawBody: expect.stringContaining('帮我总结一下'),
                }),
            );
        } finally {
            fs.rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it('downloads multiple inbound media codes and forwards MediaPaths to runtime context', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.finalizeInboundContext = vi.fn().mockImplementation((ctx) => ctx);
        runtime.channel.media.saveMediaBuffer = vi
            .fn()
            .mockResolvedValueOnce({ path: '/tmp/.openclaw/media/inbound/test-1.png', contentType: 'image/png' })
            .mockResolvedValueOnce({ path: '/tmp/.openclaw/media/inbound/test-2.png', contentType: 'image/png' });
        shared.getRuntimeMock.mockReturnValue(runtime);
        shared.extractMessageContentMock.mockReturnValue({
            text: '看图',
            messageType: 'richText',
            mediaPath: 'dl_pic_1',
            mediaPaths: ['dl_pic_1', 'dl_pic_2'],
            mediaType: 'image',
            mediaTypes: ['image', 'image'],
        });
        mockedAxiosPost.mockResolvedValue({ data: { downloadUrl: 'https://download.url/file' } } as any);
        mockedAxiosGet.mockResolvedValue({
            data: Buffer.from('abc'),
            headers: { 'content-type': 'image/png' },
        } as any);

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open', robotCode: 'robot_1' } as any,
            data: {
                msgId: 'multi_media_1',
                msgtype: 'richText',
                text: { content: '看图' },
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                MediaPath: '/tmp/.openclaw/media/inbound/test-1.png',
                MediaPaths: ['/tmp/.openclaw/media/inbound/test-1.png', '/tmp/.openclaw/media/inbound/test-2.png'],
                RawBody: expect.stringContaining('共解析到 2 个媒体附件'),
            }),
        );
    });

    it('resolves nested originalMsgId reply from quote journal', async () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-nested-quote-'));
        const storePath = path.join(rootDir, 'session', 'store.json');
        const runtime = buildRuntime();
        runtime.channel.session.resolveStorePath = vi.fn().mockReturnValue(storePath);
        runtime.channel.reply.finalizeInboundContext = vi.fn().mockImplementation((ctx) => ctx);
        shared.getRuntimeMock.mockReturnValue(runtime);

        shared.extractMessageContentMock
            .mockReturnValueOnce({ text: '最初原文', messageType: 'text' })
            .mockReturnValueOnce({
                text: '[这是一条引用消息，原消息ID: quoted_root]\n\n二层回复',
                messageType: 'text',
                quoted: { prefix: '[这是一条引用消息，原消息ID: quoted_root]\n\n', msgId: 'quoted_root' },
            })
            .mockReturnValueOnce({
                text: '[这是一条引用消息，原消息ID: quoted_nested]\n\n请继续总结',
                messageType: 'text',
                quoted: { prefix: '[这是一条引用消息，原消息ID: quoted_nested]\n\n', msgId: 'quoted_nested' },
            });

        try {
            await handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: { dmPolicy: 'open' } as any,
                data: {
                    msgId: 'quoted_root',
                    msgtype: 'text',
                    text: { content: '最初原文' },
                    conversationType: '1',
                    conversationId: 'cidA1B2C3',
                    senderId: 'user_1',
                    chatbotUserId: 'bot_1',
                    sessionWebhook: 'https://session.webhook',
                    createAt: Date.now(),
                },
            } as any);

            await handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: { dmPolicy: 'open' } as any,
                data: {
                    msgId: 'quoted_nested',
                    msgtype: 'text',
                    text: { content: '二层回复', isReplyMsg: true },
                    originalMsgId: 'quoted_root',
                    conversationType: '1',
                    conversationId: 'cidA1B2C3',
                    senderId: 'user_1',
                    chatbotUserId: 'bot_1',
                    sessionWebhook: 'https://session.webhook',
                    createAt: Date.now(),
                },
            } as any);

            await handleDingTalkMessage({
                cfg: {},
                accountId: 'main',
                sessionWebhook: 'https://session.webhook',
                log: undefined,
                dingtalkConfig: { dmPolicy: 'open' } as any,
                data: {
                    msgId: 'reply_nested_1',
                    msgtype: 'text',
                    text: { content: '请继续总结', isReplyMsg: true },
                    originalMsgId: 'quoted_nested',
                    conversationType: '1',
                    conversationId: 'cidA1B2C3',
                    senderId: 'user_1',
                    chatbotUserId: 'bot_1',
                    sessionWebhook: 'https://session.webhook',
                    createAt: Date.now(),
                },
            } as any);

            expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    RawBody: expect.stringContaining('[引用消息: "最初原文"]'),
                }),
            );
        } finally {
            fs.rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it('adds explicit warning when quoted content is unavailable', async () => {
        const runtime = buildRuntime();
        runtime.channel.reply.finalizeInboundContext = vi.fn().mockImplementation((ctx) => ctx);
        shared.getRuntimeMock.mockReturnValue(runtime);
        shared.extractMessageContentMock.mockReturnValue({
            text: '[引用消息不可见: msgType=location，原消息ID: q1]\n\n这是什么',
            messageType: 'text',
            quoted: { prefix: '[引用消息不可见: msgType=location，原消息ID: q1]\n\n', msgId: 'q1' },
        });

        await handleDingTalkMessage({
            cfg: {},
            accountId: 'main',
            sessionWebhook: 'https://session.webhook',
            log: undefined,
            dingtalkConfig: { dmPolicy: 'open' } as any,
            data: {
                msgId: 'q_unavailable_1',
                msgtype: 'text',
                text: { content: '这是什么', isReplyMsg: true },
                originalMsgId: 'q1',
                conversationType: '1',
                conversationId: 'cid_ok',
                senderId: 'user_1',
                chatbotUserId: 'bot_1',
                sessionWebhook: 'https://session.webhook',
                createAt: Date.now(),
            },
        } as any);

        expect(runtime.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
            expect.objectContaining({
                RawBody: expect.stringContaining('禁止根据上下文臆测引用内容'),
            }),
        );
    });
});
