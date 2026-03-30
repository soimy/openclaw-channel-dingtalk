import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth', () => ({
    getAccessToken: vi.fn().mockResolvedValue('mock-access-token'),
}));

vi.mock('axios', () => {
    const mockAxios = vi.fn();
    return {
        default: mockAxios,
        isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
    };
});

import { convertMarkdownTablesToPlainText } from '../../src/message-utils';
import { sendBySession, sendProactiveTextOrMarkdown } from '../../src/send-service';
import type { DingTalkConfig } from '../../src/types';

const mockedAxios = vi.mocked(axios);

const config: DingTalkConfig = {
    clientId: 'ding-client-id',
    clientSecret: 'client-secret',
} as DingTalkConfig;

describe('message payload transform', () => {
    beforeEach(() => {
        mockedAxios.mockReset();
    });

    it('should convert markdown reply to DingTalk session webhook payload', async () => {
        mockedAxios.mockResolvedValue({ data: { success: true } });

        await sendBySession(config, 'https://example-session-webhook', '# 标题\n正文', {
            useMarkdown: true,
            atUserId: 'user_1',
        });

        expect(mockedAxios).toHaveBeenCalledTimes(1);
        const request = mockedAxios.mock.calls[0]?.[0] as {
            url: string;
            method: string;
            data: {
                msgtype: string;
                markdown?: { title: string; text: string };
                at?: { atUserIds: string[]; isAtAll: boolean };
            };
            headers: Record<string, string>;
        };

        expect(request.url).toBe('https://example-session-webhook');
        expect(request.method).toBe('POST');
        expect(request.data.msgtype).toBe('markdown');
        expect(request.data.markdown).toEqual({
            title: '标题',
            text: '# 标题\n正文 @user_1',
        });
        expect(request.data.at).toEqual({ atUserIds: ['user_1'], isAtAll: false });
        expect(request.headers['Content-Type']).toBe('application/json');
    });

    it('should convert group proactive text to sampleText payload', async () => {
        mockedAxios.mockResolvedValue({ data: { processQueryKey: 'q_1' } });

        await sendProactiveTextOrMarkdown(config, 'cidA1B2C3', 'plain text');

        expect(mockedAxios).toHaveBeenCalledTimes(1);
        const request = mockedAxios.mock.calls[0]?.[0] as {
            url: string;
            data: {
                msgKey: string;
                msgParam: string;
                openConversationId?: string;
                userIds?: string[];
            };
        };

        expect(request.url).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send');
        expect(request.data.msgKey).toBe('sampleText');
        expect(JSON.parse(request.data.msgParam)).toEqual({ content: 'plain text' });
        expect(request.data.openConversationId).toBe('cidA1B2C3');
        expect(request.data.userIds).toBeUndefined();
    });

    it('converts markdown tables to plain text before session send', async () => {
        mockedAxios.mockResolvedValue({ data: { success: true } });

        await sendBySession(config, 'https://example-session-webhook', '# 报表\n| 姓名 | 分数 |\n| --- | --- |\n| 张三 | 90 |', {
            useMarkdown: true,
        });

        const request = mockedAxios.mock.calls[0]?.[0] as {
            data: {
                markdown?: { title: string; text: string };
            };
        };

        expect(request.data.markdown).toEqual({
            title: '报表',
            text: '# 报表\n姓名 | 分数  \n张三 | 90',
        });
    });

    it('converts markdown tables to plain text before proactive markdown send', async () => {
        mockedAxios.mockResolvedValue({ data: { processQueryKey: 'q_table' } });

        await sendProactiveTextOrMarkdown(config, 'cidA1B2C3', '# 周报\n| 项目 | 状态 |\n| --- | --- |\n| PR-295 | 处理中 |');

        const request = mockedAxios.mock.calls[0]?.[0] as {
            data: {
                msgKey: string;
                msgParam: string;
            };
        };

        expect(request.data.msgKey).toBe('sampleMarkdown');
        expect(JSON.parse(request.data.msgParam)).toEqual({
            title: '周报',
            text: '# 周报\n项目 | 状态  \nPR-295 | 处理中',
        });
    });

    it('preserves markdown tables when convertMarkdownTables is false', async () => {
        mockedAxios.mockResolvedValue({ data: { success: true } });
        const noConvertConfig = { ...config, convertMarkdownTables: false } as DingTalkConfig;
        const tableText = '# 报表\n| 姓名 | 分数 |\n| --- | --- |\n| 张三 | 90 |';

        await sendBySession(noConvertConfig, 'https://example-session-webhook', tableText, {
            useMarkdown: true,
        });

        const request = mockedAxios.mock.calls[0]?.[0] as {
            data: { markdown?: { title: string; text: string } };
        };

        expect(request.data.markdown).toEqual({
            title: '报表',
            text: '# 报表\n| 姓名 | 分数 |\n| --- | --- |\n| 张三 | 90 |',
        });
    });

    it('keeps markdown tables inside code fences untouched', () => {
        const input = '```md\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```';

        expect(convertMarkdownTablesToPlainText(input)).toBe(input);
    });
});
