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

const quoteJournalMocks = vi.hoisted(() => ({
    appendOutboundToQuoteJournalMock: vi.fn(),
    appendProactiveOutboundJournalMock: vi.fn(),
}));

vi.mock('../../src/card-service', () => ({
    isCardInTerminalState: cardServiceMocks.isCardInTerminalStateMock,
    streamAICard: cardServiceMocks.streamAICardMock,
    sendProactiveCardText: cardServiceMocks.sendProactiveCardTextMock,
}));

vi.mock('../../src/quote-journal', () => ({
    appendOutboundToQuoteJournal: quoteJournalMocks.appendOutboundToQuoteJournalMock,
    appendProactiveOutboundJournal: quoteJournalMocks.appendProactiveOutboundJournalMock,
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
        quoteJournalMocks.appendOutboundToQuoteJournalMock.mockReset();
        quoteJournalMocks.appendProactiveOutboundJournalMock.mockReset();
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

    it('preserves tracking metadata when card mode proactive send succeeds without a live card instance', async () => {
        cardServiceMocks.sendProactiveCardTextMock.mockResolvedValueOnce({
            ok: true,
            outTrackId: 'track_card_real_1',
            processQueryKey: 'card_process_real_1',
            cardInstanceId: 'card_instance_real_1',
        });

        const result = await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id', messageType: 'card', cardTemplateId: 'tmpl' } as any,
            'manager123',
            'text',
            { accountId: 'main' } as any,
        );

        expect(cardServiceMocks.sendProactiveCardTextMock).toHaveBeenCalledTimes(1);
        expect(mockedAxios).not.toHaveBeenCalled();
        expect(result).toEqual({
            ok: true,
            tracking: {
                outTrackId: 'track_card_real_1',
                processQueryKey: 'card_process_real_1',
                cardInstanceId: 'card_instance_real_1',
            },
        });
    });

    it('journals proactive card sends using tracking metadata when storePath is provided', async () => {
        cardServiceMocks.sendProactiveCardTextMock.mockResolvedValueOnce({
            ok: true,
            outTrackId: 'track_card_real_2',
            processQueryKey: 'card_process_real_2',
            cardInstanceId: 'card_instance_real_2',
        });

        await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id', messageType: 'card', cardTemplateId: 'tmpl' } as any,
            'manager123',
            'card proactive text',
            {
                accountId: 'main',
                storePath: '/tmp/sessions.json',
                conversationId: 'cid_dm_stable',
            } as any,
        );

        expect(quoteJournalMocks.appendProactiveOutboundJournalMock).toHaveBeenCalledWith(
            expect.objectContaining({
                storePath: '/tmp/sessions.json',
                accountId: 'main',
                conversationId: 'cid_dm_stable',
                messageId: 'card_process_real_2',
                messageType: 'outbound-proactive',
                text: 'card proactive text',
            }),
        );
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

    it('delegates session outbound journaling when storePath is provided', async () => {
        mockedAxios.mockResolvedValueOnce({ data: { errcode: 0, errmsg: 'ok', msgid: 'legacy_msg_2' } } as any);

        await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'cidA1B2C3',
            'hello session',
            {
                sessionWebhook: 'https://session.webhook',
                accountId: 'main',
                storePath: '/tmp/sessions.json',
            } as any,
        );

        expect(quoteJournalMocks.appendOutboundToQuoteJournalMock).toHaveBeenCalledWith(
            expect.objectContaining({
                storePath: '/tmp/sessions.json',
                accountId: 'main',
                conversationId: 'cidA1B2C3',
                messageId: 'legacy_msg_2',
                messageType: 'outbound',
                text: 'hello session',
            }),
        );
    });

    it('delegates proactive outbound journaling when storePath is provided', async () => {
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'proactive_q_1' } } as any);

        await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'cidA1B2C3',
            'hello proactive',
            {
                accountId: 'main',
                storePath: '/tmp/sessions.json',
            } as any,
        );

        expect(quoteJournalMocks.appendProactiveOutboundJournalMock).toHaveBeenCalledWith(
            expect.objectContaining({
                storePath: '/tmp/sessions.json',
                accountId: 'main',
                conversationId: 'cidA1B2C3',
                messageId: 'proactive_q_1',
                messageType: 'outbound-proactive',
                text: 'hello proactive',
            }),
        );
    });

    it('uses provided DingTalk conversationId for DM journaling scope instead of user target id', async () => {
        mockedAxios.mockResolvedValueOnce({ data: { processQueryKey: 'proactive_q_dm_1' } } as any);

        await sendMessage(
            { clientId: 'id', clientSecret: 'sec', robotCode: 'id' } as any,
            'user_target_123',
            'hello proactive dm',
            {
                accountId: 'main',
                storePath: '/tmp/sessions.json',
                conversationId: 'cid_dm_stable',
            } as any,
        );

        expect(quoteJournalMocks.appendProactiveOutboundJournalMock).toHaveBeenCalledWith(
            expect.objectContaining({
                conversationId: 'cid_dm_stable',
            }),
        );
        expect(quoteJournalMocks.appendProactiveOutboundJournalMock).not.toHaveBeenCalledWith(
            expect.objectContaining({
                conversationId: 'user_target_123',
            }),
        );
    });
});
