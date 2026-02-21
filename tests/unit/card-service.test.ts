import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth', () => ({
    getAccessToken: vi.fn().mockResolvedValue('token_abc'),
}));

vi.mock('axios', () => {
    const mockAxios = vi.fn();
    (mockAxios as any).post = vi.fn();
    (mockAxios as any).put = vi.fn();
    return {
        default: mockAxios,
        isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
    };
});

import {
    cleanupCardCache,
    createAICard,
    finishAICard,
    formatContentForCard,
    getActiveCardIdByTarget,
    getCardById,
    streamAICard,
} from '../../src/card-service';
import { getAccessToken } from '../../src/auth';
import { AICardStatus } from '../../src/types';

const mockedAxios = axios as any;
const mockedGetAccessToken = vi.mocked(getAccessToken);

describe('card-service', () => {
    beforeEach(() => {
        mockedAxios.mockReset();
        mockedAxios.post.mockReset();
        mockedAxios.put.mockReset();
        mockedGetAccessToken.mockReset();
        mockedGetAccessToken.mockResolvedValue('token_abc');
    });

    it('createAICard returns card instance and caches mapping', async () => {
        mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { ok: true } });

        const card = await createAICard(
            { clientId: 'id', clientSecret: 'sec', cardTemplateId: 'tmpl.schema', robotCode: 'id' } as any,
            'cidA1B2C3',
            { conversationType: '2' } as any,
            'main'
        );

        expect(card).toBeTruthy();
        expect(card?.state).toBe(AICardStatus.PROCESSING);
        expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });

    it('createAICard returns null when templateId is missing', async () => {
        const card = await createAICard(
            { clientId: 'id', clientSecret: 'sec' } as any,
            'cidA1B2C3',
            { conversationType: '2' } as any,
            'main'
        );

        expect(card).toBeNull();
        expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('streamAICard updates state to INPUTING on success', async () => {
        mockedAxios.put.mockResolvedValueOnce({ status: 200, data: { ok: true } });

        const card = {
            cardInstanceId: 'card_1',
            accessToken: 'token_abc',
            conversationId: 'cidA1B2C3',
            createdAt: Date.now(),
            lastUpdated: Date.now(),
            state: AICardStatus.PROCESSING,
            config: { cardTemplateKey: 'content' },
        } as any;

        await streamAICard(card, 'stream text', false);

        expect(card.state).toBe(AICardStatus.INPUTING);
        expect(mockedAxios.put).toHaveBeenCalledTimes(1);
    });

    it('streamAICard retries once on 401 and succeeds', async () => {
        mockedAxios.put
            .mockRejectedValueOnce({ response: { status: 401 }, message: 'token expired' })
            .mockResolvedValueOnce({ status: 200, data: { ok: true } });

        const card = {
            cardInstanceId: 'card_2',
            accessToken: 'token_old',
            conversationId: 'cidA1B2C3',
            createdAt: Date.now(),
            lastUpdated: Date.now(),
            state: AICardStatus.PROCESSING,
            config: { clientId: 'id', clientSecret: 'sec', cardTemplateKey: 'content' },
        } as any;

        await streamAICard(card, 'stream text', false);

        expect(mockedAxios.put).toHaveBeenCalledTimes(2);
        expect(card.state).toBe(AICardStatus.INPUTING);
    });

    it('finishAICard finalizes with FINISHED status', async () => {
        mockedAxios.put.mockResolvedValueOnce({ status: 200, data: { ok: true } });

        const card = {
            cardInstanceId: 'card_3',
            accessToken: 'token_abc',
            conversationId: 'cidA1B2C3',
            createdAt: Date.now(),
            lastUpdated: Date.now(),
            state: AICardStatus.INPUTING,
            config: { cardTemplateKey: 'content' },
        } as any;

        await finishAICard(card, 'final text');

        expect(card.state).toBe(AICardStatus.FINISHED);
    });

    it('streamAICard marks FAILED and sends mismatch notification on 500 unknownError', async () => {
        mockedAxios.put.mockRejectedValueOnce({
            response: { status: 500, data: { code: 'unknownError' } },
            message: 'unknownError',
        });
        mockedAxios.mockResolvedValueOnce({ data: { ok: true } });

        const card = {
            cardInstanceId: 'card_4',
            accessToken: 'token_abc',
            conversationId: 'cidA1B2C3',
            createdAt: Date.now(),
            lastUpdated: Date.now(),
            state: AICardStatus.INPUTING,
            config: { clientId: 'id', clientSecret: 'sec', cardTemplateId: 'tmpl.schema', cardTemplateKey: 'content' },
        } as any;

        await expect(streamAICard(card, 'stream text', false)).rejects.toBeDefined();

        expect(card.state).toBe(AICardStatus.FAILED);
        expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it('streamAICard keeps FAILED when 401 retry also fails', async () => {
        mockedAxios.put
            .mockRejectedValueOnce({ response: { status: 401 }, message: 'token expired' })
            .mockRejectedValueOnce({ response: { status: 500 }, message: 'still failed' });

        const card = {
            cardInstanceId: 'card_5',
            accessToken: 'token_old',
            conversationId: 'cidA1B2C3',
            createdAt: Date.now(),
            lastUpdated: Date.now(),
            state: AICardStatus.PROCESSING,
            config: { clientId: 'id', clientSecret: 'sec', cardTemplateKey: 'content' },
        } as any;

        await expect(streamAICard(card, 'stream text', false)).rejects.toBeDefined();
        expect(card.state).toBe(AICardStatus.FAILED);
        expect(mockedAxios.put).toHaveBeenCalledTimes(2);
    });

    it('formatContentForCard truncates and annotates content', () => {
        const content = `${'x'.repeat(510)}`;
        const result = formatContentForCard(content, 'thinking');

        expect(result).toContain('思考中');
        expect(result).toContain('> ');
        expect(result.endsWith('…')).toBe(true);
    });

    it('cleanupCardCache removes expired terminal cards and active mapping', async () => {
        mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { ok: true } });

        const card = await createAICard(
            { clientId: 'id', clientSecret: 'sec', cardTemplateId: 'tmpl.schema', robotCode: 'id' } as any,
            'cid_old',
            { conversationType: '2' } as any,
            'main'
        );

        expect(card).toBeTruthy();
        if (!card) return;

        card.state = AICardStatus.FINISHED;
        card.lastUpdated = Date.now() - 2 * 60 * 60 * 1000;

        cleanupCardCache();

        expect(getCardById(card.cardInstanceId)).toBeUndefined();
        expect(getActiveCardIdByTarget('main:cid_old')).toBeUndefined();
    });

    it('refreshes aged token before streaming', async () => {
        mockedGetAccessToken.mockResolvedValueOnce('token_new');
        mockedAxios.put.mockResolvedValueOnce({ status: 200, data: { ok: true } });

        const card = {
            cardInstanceId: 'card_6',
            accessToken: 'token_old',
            conversationId: 'cidA1B2C3',
            createdAt: Date.now() - 100 * 60 * 1000,
            lastUpdated: Date.now(),
            state: AICardStatus.PROCESSING,
            config: { clientId: 'id', clientSecret: 'sec', cardTemplateKey: 'content' },
        } as any;

        await streamAICard(card, 'stream text', false);
        expect(card.accessToken).toBe('token_new');
    });

    it('continues streaming when aged token refresh fails', async () => {
        mockedGetAccessToken.mockRejectedValueOnce(new Error('refresh failed'));
        mockedAxios.put.mockResolvedValueOnce({ status: 200, data: { ok: true } });

        const card = {
            cardInstanceId: 'card_7',
            accessToken: 'token_keep',
            conversationId: 'cidA1B2C3',
            createdAt: Date.now() - 100 * 60 * 1000,
            lastUpdated: Date.now(),
            state: AICardStatus.PROCESSING,
            config: { clientId: 'id', clientSecret: 'sec', cardTemplateKey: 'content' },
        } as any;

        await streamAICard(card, 'stream text', false);
        expect(card.accessToken).toBe('token_keep');
    });
});
