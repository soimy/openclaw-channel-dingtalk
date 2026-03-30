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

    it('skips card branch when card is alive but no cardUpdateMode is provided', async () => {
        const card = { cardInstanceId: 'card_1', state: AICardStatus.PROCESSING, lastUpdated: Date.now() } as any;
        cardMocks.isCardInTerminalStateMock.mockReturnValue(false);
        mockedAxios.mockResolvedValue({ data: { processQueryKey: 'q_skip' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'cidA1B2C3',
            'stream content',
            { card, sessionWebhook: 'https://session.webhook' }
        );

        expect(cardMocks.streamAICardMock).not.toHaveBeenCalled();
        expect(result.ok).toBe(true);
    });

    it('ignores legacy cardUpdateMode append requests and falls back to normal outbound send', async () => {
        const card = {
            cardInstanceId: 'card_append',
            state: AICardStatus.INPUTING,
            lastUpdated: Date.now(),
            lastStreamedContent: 'hello',
        } as any;
        cardMocks.isCardInTerminalStateMock.mockReturnValue(false);
        mockedAxios.mockResolvedValue({ data: { processQueryKey: 'q_append_ignored' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'cidA1B2C3',
            ' world',
            { card, cardUpdateMode: 'append', sessionWebhook: 'https://session.webhook' } as any,
        );

        expect(cardMocks.streamAICardMock).not.toHaveBeenCalled();
        expect(result.ok).toBe(true);
    });

    it('skips card streaming when provided card is in terminal state', async () => {
        const card = { cardInstanceId: 'card_done', state: AICardStatus.FINISHED, lastUpdated: Date.now() } as any;
        cardMocks.isCardInTerminalStateMock.mockReturnValue(true);
        mockedAxios.mockResolvedValue({ data: { processQueryKey: 'q_456' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
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
                cardTemplateId: 'tmpl.schema',
            } as any,
            'cidA1B2C3',
            'new terminal content',
            { card }
        );

        expect(cardMocks.streamAICardMock).not.toHaveBeenCalled();
        expect(cardMocks.sendProactiveCardTextMock).toHaveBeenCalledWith(
            expect.objectContaining({ messageType: 'card' }),
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
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'cidA1B2C3',
            'no card text',
            { sessionWebhook: 'https://session.webhook' }
        );

        expect(cardMocks.streamAICardMock).not.toHaveBeenCalled();
        expect(cardMocks.isCardInTerminalStateMock).not.toHaveBeenCalled();
        expect(result.ok).toBe(true);
    });

    it('does not use the removed append stream path even if streamAICard would fail', async () => {
        const card = { cardInstanceId: 'card_1', state: AICardStatus.PROCESSING, lastUpdated: Date.now(), lastStreamedContent: 'prev' } as any;
        cardMocks.isCardInTerminalStateMock.mockReturnValue(false);
        cardMocks.streamAICardMock.mockRejectedValue(new Error('stream failed'));
        mockedAxios.mockResolvedValue({ data: { processQueryKey: 'q_append_ignored_fail' } } as any);

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', messageType: 'card' } as any,
            'cidA1B2C3',
            'appended',
            { card, cardUpdateMode: 'append', sessionWebhook: 'https://session.webhook' } as any
        );

        expect(card.state).toBe(AICardStatus.PROCESSING);
        expect(cardMocks.streamAICardMock).not.toHaveBeenCalled();
        expect(result.ok).toBe(true);
    });
});
