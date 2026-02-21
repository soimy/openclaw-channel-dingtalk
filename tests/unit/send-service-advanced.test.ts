import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cardMocks = vi.hoisted(() => ({
    getActiveCardIdByTargetMock: vi.fn(),
    getCardByIdMock: vi.fn(),
    isCardInTerminalStateMock: vi.fn(),
    streamAICardMock: vi.fn(),
    deleteActiveCardByTargetMock: vi.fn(),
}));

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
    getActiveCardIdByTarget: cardMocks.getActiveCardIdByTargetMock,
    getCardById: cardMocks.getCardByIdMock,
    isCardInTerminalState: cardMocks.isCardInTerminalStateMock,
    streamAICard: cardMocks.streamAICardMock,
    deleteActiveCardByTarget: cardMocks.deleteActiveCardByTargetMock,
}));

import { sendMessage } from '../../src/send-service';
import { AICardStatus } from '../../src/types';

const mockedAxios = vi.mocked(axios);

describe('send-service advanced branches', () => {
    beforeEach(() => {
        mockedAxios.mockReset();
        cardMocks.getActiveCardIdByTargetMock.mockReset();
        cardMocks.getCardByIdMock.mockReset();
        cardMocks.isCardInTerminalStateMock.mockReset();
        cardMocks.streamAICardMock.mockReset();
        cardMocks.deleteActiveCardByTargetMock.mockReset();
    });

    it('deletes active card mapping when card is terminal', async () => {
        cardMocks.getActiveCardIdByTargetMock.mockReturnValue('card_terminal');
        cardMocks.getCardByIdMock.mockReturnValue({ state: AICardStatus.FINISHED });
        cardMocks.isCardInTerminalStateMock.mockReturnValue(true);
        mockedAxios.mockResolvedValue({ data: { processQueryKey: 'q1' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id', messageType: 'card' } as any,
            'cidA1B2C3',
            'text',
            { accountId: 'main' }
        );

        expect(cardMocks.deleteActiveCardByTargetMock).toHaveBeenCalledWith('main:cidA1B2C3');
        expect(result.ok).toBe(true);
    });

    it('returns {ok:false} when proactive send throws', async () => {
        mockedAxios.mockRejectedValueOnce(new Error('network failed'));

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'cidA1B2C3',
            'text',
            {}
        );

        expect(result).toEqual({ ok: false, error: 'network failed' });
    });
});
