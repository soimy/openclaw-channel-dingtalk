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

const cardServiceMocks = vi.hoisted(() => ({
    isCardInTerminalStateMock: vi.fn(),
    streamAICardMock: vi.fn(),
    sendProactiveCardTextMock: vi.fn(),
}));

vi.mock('../../src/card-service', () => ({
    isCardInTerminalState: cardServiceMocks.isCardInTerminalStateMock,
    streamAICard: cardServiceMocks.streamAICardMock,
    sendProactiveCardText: cardServiceMocks.sendProactiveCardTextMock,
}));

import { sendMessage } from '../../src/send-service';
import {
    clearProactiveRiskObservationsForTest,
    getProactiveRiskObservation,
    recordProactiveRiskObservation,
} from '../../src/proactive-risk-registry';

const mockedAxios = vi.mocked(axios);

describe('send-service advanced branches', () => {
    beforeEach(() => {
        mockedAxios.mockReset();
        cardServiceMocks.sendProactiveCardTextMock.mockReset();
        clearProactiveRiskObservationsForTest();
    });

    it('falls back to proactive template API when proactive card send fails', async () => {
        cardServiceMocks.sendProactiveCardTextMock.mockResolvedValueOnce({
            ok: false,
            error: 'card send failed',
        });
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'q_123' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id', messageType: 'card', cardTemplateId: 'tmpl' } as any,
            'manager123',
            'text',
            { accountId: 'main' } as any,
        );

        expect(cardServiceMocks.sendProactiveCardTextMock).toHaveBeenCalledTimes(1);
        expect(mockedAxios).toHaveBeenCalledTimes(1);
        expect(result.ok).toBe(true);
    });

    it('returns {ok:false} when proactive send throws', async () => {
        mockedAxios.mockRejectedValueOnce({
            message: 'network failed',
            response: { data: { code: 'invalidParameter', message: 'robotCode missing' } },
        });
        const log = { error: vi.fn() };

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'cidA1B2C3',
            'text',
            { log: log as any }
        );

        expect(result).toEqual({ ok: false, error: 'network failed' });
        const logs = log.error.mock.calls.map((args: unknown[]) => String(args[0]));
        expect(
            logs.some(
                (entry) =>
                    entry.includes('[DingTalk][ErrorPayload][send.message]') &&
                    entry.includes('code=invalidParameter') &&
                    entry.includes('message=robotCode missing')
            )
        ).toBe(true);
    });

    it('includes proactive risk context in logs when proactive send fails', async () => {
        recordProactiveRiskObservation({
            accountId: 'main',
            targetId: '0341234567',
            level: 'high',
            reason: 'numeric-user-id',
            source: 'webhook-hint',
        });

        mockedAxios.mockRejectedValueOnce({
            message: 'forbidden',
            response: { status: 403, data: { code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied' } },
        });
        const log = { error: vi.fn(), debug: vi.fn() };

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            '0341234567',
            'text',
            { log: log as any, accountId: 'main' } as any,
        );

        expect(result).toEqual({ ok: false, error: 'forbidden' });
        const logs = log.error.mock.calls.map((args: unknown[]) => String(args[0]));
        expect(logs.some((entry) => entry.includes('proactiveRisk=high:numeric-user-id'))).toBe(true);
    });

    it('records proactive API risk observation when permission denied is returned', async () => {
        mockedAxios.mockRejectedValueOnce({
            message: 'forbidden',
            response: {
                status: 403,
                data: { code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied' },
            },
        });

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'manager123',
            'text',
            { accountId: 'main' } as any,
        );

        expect(result).toEqual({ ok: false, error: 'forbidden' });
        expect(getProactiveRiskObservation('main', 'manager123')).toMatchObject({
            source: 'proactive-api',
            level: 'high',
            reason: 'Forbidden.AccessDenied.AccessTokenPermissionDenied',
        });
    });
});
