import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cardMocks = vi.hoisted(() => ({
    isCardInTerminalStateMock: vi.fn(),
    streamAICardMock: vi.fn(),
    sendProactiveCardTextMock: vi.fn(),
}));

vi.mock('../../src/auth', () => ({
    getAccessToken: vi.fn().mockResolvedValue('token_abc'),
}));

vi.mock('axios', () => ({
    default: vi.fn(),
    isAxiosError: vi.fn(),
}));

vi.mock('../../src/card-service', () => ({
    isCardInTerminalState: cardMocks.isCardInTerminalStateMock,
    streamAICard: cardMocks.streamAICardMock,
    sendProactiveCardText: cardMocks.sendProactiveCardTextMock,
}));

import { sendMessage } from '../../src/send-service';
import { AICardStatus } from '../../src/types';

const mockedAxios = vi.mocked(axios);

describe('sendMessage card mode', () => {
    beforeEach(() => {
        mockedAxios.mockReset();
        cardMocks.isCardInTerminalStateMock.mockReset();
        cardMocks.streamAICardMock.mockReset();
        cardMocks.sendProactiveCardTextMock.mockReset();
    });

    it('streams into provided card when card is alive', async () => {
        const card = { cardInstanceId: 'card_1', state: AICardStatus.PROCESSING, lastUpdated: Date.now() } as any;
        cardMocks.isCardInTerminalStateMock.mockReturnValue(false);
        cardMocks.streamAICardMock.mockResolvedValue(undefined);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card', robotCode: 'id' } as any,
            'cidA1B2C3',
            'stream content',
            { card }
        );

        expect(cardMocks.streamAICardMock).toHaveBeenCalledTimes(1);
        expect(mockedAxios).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true });
    });

    it('composes append updates locally and streams full content', async () => {
        const card = {
            cardInstanceId: 'card_append',
            state: AICardStatus.INPUTING,
            lastUpdated: Date.now(),
            lastStreamedContent: 'hello',
        } as any;
        cardMocks.isCardInTerminalStateMock.mockReturnValue(false);
        cardMocks.streamAICardMock.mockResolvedValue(undefined);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card', robotCode: 'id' } as any,
            'cidA1B2C3',
            ' world',
            { card, cardUpdateMode: 'append' } as any,
        );

        expect(cardMocks.streamAICardMock).toHaveBeenCalledWith(card, 'hello world', false, undefined);
        expect(result).toEqual({ ok: true });
    });

    it('skips card streaming when provided card is in terminal state', async () => {
        const card = { cardInstanceId: 'card_done', state: AICardStatus.FINISHED, lastUpdated: Date.now() } as any;
        cardMocks.isCardInTerminalStateMock.mockReturnValue(true);
        mockedAxios.mockResolvedValue({ data: { processQueryKey: 'q_456' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card', robotCode: 'id' } as any,
            'cidA1B2C3',
            'fallback text',
            { card, sessionWebhook: 'https://session.webhook' }
        );

        expect(cardMocks.streamAICardMock).not.toHaveBeenCalled();
        expect(result.ok).toBe(true);
    });

    it('creates and finalizes a new proactive card when provided card is terminal', async () => {
        const card = { cardInstanceId: 'card_done', state: AICardStatus.FINISHED, lastUpdated: Date.now() } as any;
        cardMocks.isCardInTerminalStateMock.mockReturnValue(true);
        cardMocks.sendProactiveCardTextMock.mockResolvedValue({
            ok: true,
            outTrackId: 'track_card_1',
            processQueryKey: 'card_process_1',
            cardInstanceId: 'card_instance_1',
        });

        const result = await sendMessage(
            {
                clientId: 'id',
                clientSecret: 'sec',
                messageType: 'card',
                robotCode: 'id',
                cardTemplateId: 'tmpl.schema',
            } as any,
            'cidA1B2C3',
            'new terminal content',
            { card }
        );

        expect(cardMocks.streamAICardMock).not.toHaveBeenCalled();
        expect(cardMocks.sendProactiveCardTextMock).toHaveBeenCalledWith(
            expect.objectContaining({ cardTemplateId: 'tmpl.schema' }),
            'cidA1B2C3',
            'new terminal content',
            undefined,
        );
        expect(result).toEqual({
            ok: true,
            tracking: {
                outTrackId: 'track_card_1',
                processQueryKey: 'card_process_1',
                cardInstanceId: 'card_instance_1',
            },
        });
    });

    it('skips card branch entirely when no card is provided', async () => {
        cardMocks.isCardInTerminalStateMock.mockReturnValue(false);
        mockedAxios.mockResolvedValue({ data: { processQueryKey: 'q_789' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card', robotCode: 'id' } as any,
            'cidA1B2C3',
            'no card text',
            { sessionWebhook: 'https://session.webhook' }
        );

        expect(cardMocks.streamAICardMock).not.toHaveBeenCalled();
        expect(cardMocks.isCardInTerminalStateMock).not.toHaveBeenCalled();
        expect(result.ok).toBe(true);
    });

    it('returns failure when card stream fails to avoid duplicate fallback sends', async () => {
        const card = { cardInstanceId: 'card_1', state: AICardStatus.PROCESSING, lastUpdated: Date.now() } as any;
        cardMocks.isCardInTerminalStateMock.mockReturnValue(false);
        cardMocks.streamAICardMock.mockRejectedValue(new Error('stream failed'));

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card', robotCode: 'id' } as any,
            'cidA1B2C3',
            'fallback content',
            { card }
        );

        expect(card.state).toBe(AICardStatus.FAILED);
        expect(mockedAxios).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: false, error: 'stream failed' });
    });
});
