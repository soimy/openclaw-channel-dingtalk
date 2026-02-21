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
});
