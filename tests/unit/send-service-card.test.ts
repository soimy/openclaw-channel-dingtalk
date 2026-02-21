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

vi.mock('axios', () => ({
    default: vi.fn(),
    isAxiosError: vi.fn(),
}));

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

describe('sendMessage card mode', () => {
    beforeEach(() => {
        mockedAxios.mockReset();
        cardMocks.getActiveCardIdByTargetMock.mockReset();
        cardMocks.getCardByIdMock.mockReset();
        cardMocks.isCardInTerminalStateMock.mockReset();
        cardMocks.streamAICardMock.mockReset();
        cardMocks.deleteActiveCardByTargetMock.mockReset();
    });

    it('streams into active card when card is alive', async () => {
        const card = { cardInstanceId: 'card_1', state: AICardStatus.PROCESSING, lastUpdated: Date.now() } as any;
        cardMocks.getActiveCardIdByTargetMock.mockReturnValue('card_1');
        cardMocks.getCardByIdMock.mockReturnValue(card);
        cardMocks.isCardInTerminalStateMock.mockReturnValue(false);
        cardMocks.streamAICardMock.mockResolvedValue(undefined);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card', robotCode: 'id' } as any,
            'cidA1B2C3',
            'stream content',
            { accountId: 'main' }
        );

        expect(cardMocks.streamAICardMock).toHaveBeenCalledTimes(1);
        expect(mockedAxios).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true });
    });

    it('falls back to proactive markdown when stream fails', async () => {
        const card = { cardInstanceId: 'card_1', state: AICardStatus.PROCESSING, lastUpdated: Date.now() } as any;
        cardMocks.getActiveCardIdByTargetMock.mockReturnValue('card_1');
        cardMocks.getCardByIdMock.mockReturnValue(card);
        cardMocks.isCardInTerminalStateMock.mockReturnValue(false);
        cardMocks.streamAICardMock.mockRejectedValue(new Error('stream failed'));
        mockedAxios.mockResolvedValue({ data: { processQueryKey: 'q_123' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card', robotCode: 'id' } as any,
            'cidA1B2C3',
            'fallback content',
            { accountId: 'main' }
        );

        expect(card.state).toBe(AICardStatus.FAILED);
        expect(mockedAxios).toHaveBeenCalledTimes(1);
        expect(result.ok).toBe(true);
    });
});
