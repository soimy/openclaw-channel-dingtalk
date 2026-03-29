import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth', () => ({
    getAccessToken: vi.fn().mockResolvedValue('token_abc'),
}));

vi.mock('axios', () => {
    const mockAxios = vi.fn();
    return {
        default: mockAxios,
        isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
    };
});

vi.mock('../../src/card-service', () => ({
    getActiveCardIdByTarget: vi.fn().mockReturnValue(undefined),
    getCardById: vi.fn().mockReturnValue(undefined),
    isCardInTerminalState: vi.fn().mockReturnValue(false),
    streamAICard: vi.fn(),
    deleteActiveCardByTarget: vi.fn(),
}));

import { sendMessage } from '../../src/send-service';

const mockedAxios = vi.mocked(axios);

describe('error payload logging integration', () => {
    beforeEach(() => {
        mockedAxios.mockReset();
    });

    it('logs standardized error payload with code/message for proactive send 400', async () => {
        mockedAxios.mockRejectedValueOnce({
            isAxiosError: true,
            message: 'Request failed with status code 400',
            response: {
                status: 400,
                statusText: 'Bad Request',
                data: { code: 'invalidParameter', message: 'robotCode missing' },
            },
        });

        const log = { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', messageType: 'markdown' },
            'user_123',
            'hello',
            { log }
        );

        expect(result.ok).toBe(false);
        const errorLogs = log.error.mock.calls.map((args: unknown[]) => String(args[0]));
        expect(
            errorLogs.some(
                (entry) =>
                    entry.includes('[DingTalk][ErrorPayload][send.proactiveMessage]') &&
                    entry.includes('code=invalidParameter') &&
                    entry.includes('message=robotCode missing')
            )
        ).toBe(true);
        expect(
            errorLogs.some(
                (entry) =>
                    entry.includes('[DingTalk][ErrorPayload][send.message]') &&
                    entry.includes('code=invalidParameter') &&
                    entry.includes('message=robotCode missing')
            )
        ).toBe(true);
    });
});
