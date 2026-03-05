import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    createAICard,
    finalizeActiveCardsForAccount,
    finishAICard,
    formatContentForCard,
    recoverPendingCardsForAccount,
    sendProactiveCardText,
    streamAICard,
} from '../../src/card-service';
import { getAccessToken } from '../../src/auth';
import { AICardStatus } from '../../src/types';

const mockedAxios = axios as any;
const mockedGetAccessToken = vi.mocked(getAccessToken);

describe('card-service', () => {
    let storePath = '';
    let stateFilePath = '';
    let stateDirPath = '';

    beforeEach(() => {
        mockedAxios.mockReset();
        mockedAxios.post.mockReset();
        mockedAxios.put.mockReset();
        mockedGetAccessToken.mockReset();
        mockedGetAccessToken.mockResolvedValue('token_abc');
        stateDirPath = path.join(
            os.tmpdir(),
            `openclaw-dingtalk-card-state-${Date.now()}-${Math.random().toString(16).slice(2)}`
        );
        storePath = path.join(stateDirPath, 'session-store.json');
        stateFilePath = path.join(stateDirPath, 'dingtalk-active-cards.json');
        fs.rmSync(stateDirPath, { force: true, recursive: true });
    });

    afterEach(() => {
        fs.rmSync(stateDirPath, { force: true, recursive: true });
    });

    it('createAICard returns card instance', async () => {
        mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { ok: true } });

        const card = await createAICard(
            { clientId: 'id', clientSecret: 'sec', cardTemplateId: 'tmpl.schema', robotCode: 'id' } as any,
            'cidA1B2C3'
        );

        expect(card).toBeTruthy();
        expect(card?.state).toBe(AICardStatus.PROCESSING);
        expect(mockedAxios.post).toHaveBeenCalledTimes(1);
        const body = mockedAxios.post.mock.calls[0]?.[1];
        expect(body.cardData?.cardParamMap).toEqual({ content: '' });
        expect(body.imGroupOpenDeliverModel).toEqual({ robotCode: 'id' });
    });

    it('createAICard uses robot deliver payload for direct chat cards', async () => {
        mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { ok: true } });

        await createAICard(
            { clientId: 'id', clientSecret: 'sec', cardTemplateId: 'tmpl.schema', robotCode: 'robot_1' } as any,
            'manager123'
        );

        const body = mockedAxios.post.mock.calls[0]?.[1];
        expect(body.openSpaceId).toBe('dtv1.card//IM_ROBOT.manager123');
        expect(body.imRobotOpenDeliverModel).toEqual({ spaceType: 'IM_ROBOT', robotCode: 'robot_1' });
    });

    it('createAICard returns null when templateId is missing', async () => {
        const card = await createAICard(
            { clientId: 'id', clientSecret: 'sec' } as any,
            'cidA1B2C3'
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

    it('streamAICard ignores updates when card already FINISHED', async () => {
        const card = {
            cardInstanceId: 'card_8',
            accessToken: 'token_keep',
            conversationId: 'cidA1B2C3',
            createdAt: Date.now(),
            lastUpdated: Date.now(),
            state: AICardStatus.FINISHED,
            config: { cardTemplateKey: 'content' },
        } as any;

        await streamAICard(card, 'should be ignored', false);

        expect(mockedAxios.put).not.toHaveBeenCalled();
        expect(card.state).toBe(AICardStatus.FINISHED);
    });

    it('formatContentForCard truncates and annotates content', () => {
        const content = `${'x'.repeat(510)}`;
        const result = formatContentForCard(content, 'thinking');

        expect(result).toContain('思考中');
        expect(result).toContain('> ');
        expect(result.endsWith('…')).toBe(true);
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

    it('persists pending card and removes it after finish', async () => {
        mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { ok: true } });
        mockedAxios.put.mockResolvedValueOnce({ status: 200, data: { ok: true } });

        const card = await createAICard(
            { clientId: 'id', clientSecret: 'sec', cardTemplateId: 'tmpl.schema', robotCode: 'id' } as any,
            'cid_pending',
            undefined,
            { accountId: 'main', storePath }
        );

        expect(card).toBeTruthy();
        const persisted = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
        expect(persisted.pendingCards).toHaveLength(1);
        expect(persisted.pendingCards[0].accountId).toBe('main');
        expect(persisted.pendingCards[0].cardInstanceId).toBe(card?.cardInstanceId);

        if (!card) {
            return;
        }
        await finishAICard(card, 'done');
        const afterFinish = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
        expect(afterFinish.pendingCards).toHaveLength(0);
    });

    it('recovers pending cards for account and finalizes them', async () => {
        const pending = {
            version: 1,
            updatedAt: Date.now(),
            pendingCards: [
                {
                    accountId: 'main',
                    cardInstanceId: 'card_recover_1',
                    conversationId: 'cid_recover_1',
                    createdAt: Date.now() - 1000,
                    lastUpdated: Date.now() - 1000,
                    state: '1',
                },
            ],
        };
        fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
        fs.writeFileSync(stateFilePath, JSON.stringify(pending, null, 2));
        mockedAxios.put.mockResolvedValueOnce({ status: 200, data: { ok: true } });

        const recovered = await recoverPendingCardsForAccount(
            { clientId: 'id', clientSecret: 'sec', cardTemplateId: 'tmpl.schema', robotCode: 'id' } as any,
            'main',
            storePath
        );

        expect(recovered).toBe(1);
        expect(mockedAxios.put).toHaveBeenCalledTimes(1);
        const putBody = mockedAxios.put.mock.calls[0]?.[1];
        expect(putBody.outTrackId).toBe('card_recover_1');
        expect(putBody.isFinalize).toBe(true);
        const afterRecover = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
        expect(afterRecover.pendingCards).toHaveLength(0);
    });

    it('finalizeActiveCardsForAccount finalizes pending cards with provided reason', async () => {
        const pending = {
            version: 1,
            updatedAt: Date.now(),
            pendingCards: [
                {
                    accountId: 'main',
                    cardInstanceId: 'card_stop_1',
                    conversationId: 'cid_stop_1',
                    createdAt: Date.now() - 1000,
                    lastUpdated: Date.now() - 1000,
                    state: '2',
                },
            ],
        };
        fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
        fs.writeFileSync(stateFilePath, JSON.stringify(pending, null, 2));
        mockedAxios.put.mockResolvedValueOnce({ status: 200, data: { ok: true } });

        const finalized = await finalizeActiveCardsForAccount(
            { clientId: 'id', clientSecret: 'sec', cardTemplateId: 'tmpl.schema', robotCode: 'id' } as any,
            'main',
            'stop-reason',
            storePath
        );

        expect(finalized).toBe(1);
        expect(mockedAxios.put).toHaveBeenCalledTimes(1);
        const putBody = mockedAxios.put.mock.calls[0]?.[1];
        expect(putBody.content).toBe('stop-reason');
        expect(putBody.isFinalize).toBe(true);
        const afterFinalize = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
        expect(afterFinalize.pendingCards).toHaveLength(0);
    });

    it('sendProactiveCardText does not persist pending card state', async () => {
        mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { ok: true } });
        mockedAxios.put.mockResolvedValueOnce({ status: 200, data: { ok: true } });

        const result = await sendProactiveCardText(
            { clientId: 'id', clientSecret: 'sec', cardTemplateId: 'tmpl.schema', robotCode: 'id' } as any,
            'cid_proactive',
            'proactive done'
        );

        expect(result).toEqual({ ok: true });
        expect(mockedAxios.post).toHaveBeenCalledTimes(1);
        expect(mockedAxios.put).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(stateFilePath)).toBe(false);
    });
});
