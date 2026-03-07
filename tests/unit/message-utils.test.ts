import { describe, expect, it } from 'vitest';
import { detectMarkdownAndExtractTitle, extractMessageContent } from '../../src/message-utils';

describe('message-utils', () => {
    it('detects markdown and extracts first-line title', () => {
        const result = detectMarkdownAndExtractTitle('# 标题\n内容', {}, '默认标题');

        expect(result.useMarkdown).toBe(true);
        expect(result.title).toBe('标题');
    });

    it('extracts richText text and first picture downloadCode', () => {
        const message = {
            msgtype: 'richText',
            content: {
                richText: [
                    { type: 'text', text: '你好' },
                    { type: 'at', atName: 'Tom' },
                    { type: 'picture', downloadCode: 'dl_pic_1' },
                ],
            },
        } as any;

        const content = extractMessageContent(message);

        expect(content.text).toContain('你好');
        expect(content.text).toContain('@Tom');
        expect(content.mediaPath).toBe('dl_pic_1');
        expect(content.mediaType).toBe('image');
    });

    it('includes quoted message prefix for reply text', () => {
        const message = {
            msgtype: 'text',
            text: {
                content: '当前消息',
                isReplyMsg: true,
                repliedMsg: {
                    content: {
                        text: '被引用内容',
                    },
                },
            },
        } as any;

        const content = extractMessageContent(message);

        expect(content.text).toContain('引用消息');
        expect(content.text).toContain('被引用内容');
        expect(content.text).toContain('当前消息');
    });

    it('引用文字（text msgType）— quoted prefix and current text', () => {
        const message = {
            msgId: 'test',
            createAt: 0,
            conversationType: '1',
            conversationId: 'cid',
            senderId: 'sid',
            chatbotUserId: 'bot',
            sessionWebhook: 'https://example.com',
            msgtype: 'text',
            text: {
                content: '当前消息',
                isReplyMsg: true,
                repliedMsg: {
                    msgType: 'text',
                    content: { text: '被引用文字' },
                },
            },
        } as any;

        const content = extractMessageContent(message);

        expect(content.quoted?.prefix).toContain('被引用文字');
        expect(content.text).toContain('当前消息');
    });

    it('引用图片（picture + downloadCode）— mediaDownloadCode and mediaType', () => {
        const message = {
            msgId: 'test',
            createAt: 0,
            conversationType: '1',
            conversationId: 'cid',
            senderId: 'sid',
            chatbotUserId: 'bot',
            sessionWebhook: 'https://example.com',
            msgtype: 'text',
            text: {
                content: '看这张图',
                isReplyMsg: true,
                repliedMsg: {
                    msgType: 'picture',
                    content: { downloadCode: 'dl_pic_123' },
                },
            },
        } as any;

        const content = extractMessageContent(message);

        expect(content.quoted?.mediaDownloadCode).toBe('dl_pic_123');
        expect(content.quoted?.mediaType).toBe('image');
        expect(content.quoted?.prefix).toContain('引用图片');
    });

    it('引用文件/视频/语音（unknownMsgType）— isQuotedFile, fileCreatedAt, msgId', () => {
        const message = {
            msgId: 'test',
            createAt: 0,
            conversationType: '1',
            conversationId: 'cid',
            senderId: 'sid',
            chatbotUserId: 'bot',
            sessionWebhook: 'https://example.com',
            msgtype: 'text',
            text: {
                content: '看这个文件',
                isReplyMsg: true,
                repliedMsg: {
                    msgType: 'unknownMsgType',
                    msgId: 'msg123',
                    createdAt: 1772817989679,
                },
            },
        } as any;

        const content = extractMessageContent(message);

        expect(content.quoted?.isQuotedFile).toBe(true);
        expect(content.quoted?.fileCreatedAt).toBe(1772817989679);
        expect(content.quoted?.msgId).toBe('msg123');
    });

    it('引用 AI 卡片（interactiveCard）— isQuotedCard, processQueryKey', () => {
        const message = {
            msgId: 'test',
            createAt: 0,
            conversationType: '1',
            conversationId: 'cid',
            senderId: 'sid',
            chatbotUserId: 'bot',
            sessionWebhook: 'https://example.com',
            originalProcessQueryKey: 'carrier_123',
            msgtype: 'text',
            text: {
                content: '关于你的回复',
                isReplyMsg: true,
                repliedMsg: {
                    msgType: 'interactiveCard',
                },
            },
        } as any;

        const content = extractMessageContent(message);

        expect(content.quoted?.isQuotedCard).toBe(true);
        expect(content.quoted?.processQueryKey).toBe('carrier_123');
    });

    it('引用富文本（richText msgType）— extracts summary and picture downloadCode', () => {
        const message = {
            msgId: 'test',
            createAt: 0,
            conversationType: '2',
            conversationId: 'cid',
            senderId: 'sid',
            chatbotUserId: 'bot',
            sessionWebhook: 'https://example.com',
            msgtype: 'text',
            text: {
                content: '当前消息',
                isReplyMsg: true,
                repliedMsg: {
                    msgType: 'richText',
                    content: {
                        richText: [
                            { msgType: 'text', content: '@傲小天' },
                            { msgType: 'picture', downloadCode: 'dl_pic_rich_1' },
                            { msgType: 'text', content: '测试11111' },
                        ],
                    },
                },
            },
        } as any;

        const content = extractMessageContent(message);

        expect(content.quoted?.prefix).toContain('@傲小天');
        expect(content.quoted?.prefix).toContain('测试11111');
        expect(content.quoted?.mediaDownloadCode).toBe('dl_pic_rich_1');
        expect(content.quoted?.mediaType).toBe('image');
    });

    it('其他未知 msgType — generic fallback prefix', () => {
        const message = {
            msgId: 'test',
            createAt: 0,
            conversationType: '1',
            conversationId: 'cid',
            senderId: 'sid',
            chatbotUserId: 'bot',
            sessionWebhook: 'https://example.com',
            msgtype: 'text',
            text: {
                content: '看看',
                isReplyMsg: true,
                repliedMsg: { msgType: 'location' },
            },
        } as any;

        const content = extractMessageContent(message);

        expect(content.quoted?.prefix).toContain('引用了一条消息');
    });

    it('引用富文本（richText，无 msgType 向后兼容）— prefix contains text/emoji/at', () => {
        const message = {
            msgId: 'test',
            createAt: 0,
            conversationType: '1',
            conversationId: 'cid',
            senderId: 'sid',
            chatbotUserId: 'bot',
            sessionWebhook: 'https://example.com',
            msgtype: 'text',
            text: {
                content: '当前消息',
                isReplyMsg: true,
                repliedMsg: {
                    content: {
                        richText: [
                            { msgType: 'text', content: '你好' },
                            { msgType: 'emoji', content: '😀' },
                            { type: 'picture' },
                            { msgType: 'at', atName: 'Tom' },
                        ],
                    },
                },
            },
        } as any;

        const content = extractMessageContent(message);

        expect(content.quoted?.prefix).toContain('你好');
        expect(content.quoted?.prefix).toContain('😀');
        expect(content.quoted?.prefix).toContain('@Tom');
    });

    it('仅 originalMsgId（无 repliedMsg）— prefix contains originalMsgId', () => {
        const message = {
            msgId: 'test',
            createAt: 0,
            conversationType: '1',
            conversationId: 'cid',
            senderId: 'sid',
            chatbotUserId: 'bot',
            sessionWebhook: 'https://example.com',
            msgtype: 'text',
            text: { content: '当前消息', isReplyMsg: true },
            originalMsgId: 'orig_msg_001',
        } as any;

        const content = extractMessageContent(message);

        expect(content.quoted?.prefix).toContain('orig_msg_001');
    });

    it('无 msgType 但有 content.text（向后兼容）— prefix contains old format text', () => {
        const message = {
            msgId: 'test',
            createAt: 0,
            conversationType: '1',
            conversationId: 'cid',
            senderId: 'sid',
            chatbotUserId: 'bot',
            sessionWebhook: 'https://example.com',
            msgtype: 'text',
            text: {
                content: '当前消息',
                isReplyMsg: true,
                repliedMsg: { content: { text: '旧格式引用' } },
            },
        } as any;

        const content = extractMessageContent(message);

        expect(content.quoted?.prefix).toContain('旧格式引用');
    });

    it('quoteMessage 旧格式 — prefix from quoteMessage.text.content', () => {
        const message = {
            msgId: 'test',
            createAt: 0,
            conversationType: '1',
            conversationId: 'cid',
            senderId: 'sid',
            chatbotUserId: 'bot',
            sessionWebhook: 'https://example.com',
            msgtype: 'text',
            text: { content: '当前消息' },
            quoteMessage: { text: { content: '旧引用' } },
        } as any;

        const content = extractMessageContent(message);

        expect(content.quoted?.prefix).toContain('旧引用');
    });

    it('content.quoteContent 旧格式 — prefix from quoteContent', () => {
        const message = {
            msgId: 'test',
            createAt: 0,
            conversationType: '1',
            conversationId: 'cid',
            senderId: 'sid',
            chatbotUserId: 'bot',
            sessionWebhook: 'https://example.com',
            msgtype: 'text',
            text: { content: '当前消息' },
            content: { quoteContent: '新引用' },
        } as any;

        const content = extractMessageContent(message);

        expect(content.quoted?.prefix).toContain('新引用');
    });
});
