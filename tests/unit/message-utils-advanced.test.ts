import { describe, expect, it } from 'vitest';
import { extractMessageContent } from '../../src/message-utils';

describe('message-utils advanced extraction', () => {
    it('extracts picture/audio/video/file payloads', () => {
        expect(extractMessageContent({ msgtype: 'picture', content: { downloadCode: 'd1' } } as any)).toEqual(
            expect.objectContaining({ text: '<media:image>', mediaPath: 'd1', mediaType: 'image' })
        );

        expect(extractMessageContent({ msgtype: 'audio', content: { recognition: '语音识别', downloadCode: 'd2' } } as any)).toEqual(
            expect.objectContaining({ text: '语音识别', mediaPath: 'd2', mediaType: 'audio' })
        );

        expect(extractMessageContent({ msgtype: 'video', content: { downloadCode: 'd3' } } as any)).toEqual(
            expect.objectContaining({ text: '<media:video>', mediaPath: 'd3', mediaType: 'video' })
        );

        expect(extractMessageContent({ msgtype: 'file', content: { downloadCode: 'd4', fileName: 'a.pdf' } } as any)).toEqual(
            expect.objectContaining({ text: '<media:file> (a.pdf)', mediaPath: 'd4', mediaType: 'file' })
        );
    });

    it('extracts legacy quoteMessage and quoteContent prefixes', () => {
        const legacy = extractMessageContent({
            msgtype: 'text',
            text: { content: '当前消息' },
            quoteMessage: { text: { content: '旧引用' } },
        } as any);

        const modern = extractMessageContent({
            msgtype: 'text',
            text: { content: '当前消息' },
            content: { quoteContent: '新引用' },
        } as any);

        expect(legacy.text).toContain('旧引用');
        expect(modern.text).toContain('新引用');
    });

    it('falls back for unknown msgtype', () => {
        const result = extractMessageContent({ msgtype: 'unknownType', text: { content: '' } } as any);
        expect(result.text).toBe('[unknownType消息]');
    });
});
