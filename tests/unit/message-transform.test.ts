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

import { sendBySession, sendProactiveTextOrMarkdown } from '../../src/send-service';
import type { DingTalkConfig } from '../../src/types';

const mockedAxios = vi.mocked(axios);

const config: DingTalkConfig = {
    clientId: 'ding-client-id',
    clientSecret: 'client-secret',
    robotCode: 'ding-client-id',
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
});
