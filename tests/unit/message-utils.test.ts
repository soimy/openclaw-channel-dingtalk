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

    it('marks quote as unavailable when repliedMsg has unknownMsgType and no body', () => {
        const message = {
            msgtype: 'text',
            originalMsgId: 'msg_xxx',
            text: {
                content: '聊天记录里面说了啥',
                isReplyMsg: true,
                repliedMsg: {
                    msgType: 'unknownMsgType',
                    msgId: 'msg_xxx',
                },
            },
        } as any;

        const content = extractMessageContent(message);

        expect(content.text).toContain('引用消息不可见');
        expect(content.text).toContain('unknownMsgType');
        expect(content.text).toContain('msg_xxx');
        expect(content.text).toContain('聊天记录里面说了啥');
    });

    it('parses chatRecord payload into readable lines', () => {
        const message = {
            msgtype: 'chatRecord',
            content: {
                summary: '["晴月:音乐现在是不是最少","溯煜:对"]',
                chatRecord: JSON.stringify([
                    { senderName: '晴月', content: '音乐现在是不是最少，我看才4个，可以招个10个左右吧' },
                    { senderName: '晴月', content: '音乐都是啊水在看是吧' },
                    { senderName: '溯煜', content: '对' },
                ]),
            },
        } as any;

        const content = extractMessageContent(message);

        expect(content.messageType).toBe('chatRecord');
        expect(content.text).toContain('聊天记录摘要');
        expect(content.text).toContain('聊天记录内容');
        expect(content.text).toContain('晴月: 音乐现在是不是最少');
        expect(content.text).toContain('溯煜: 对');
    });
});
