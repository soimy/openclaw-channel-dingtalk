import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
    finishStoppedAICardMock: vi.fn().mockResolvedValue(undefined),
    hideCardStopButtonMock: vi.fn().mockResolvedValue(undefined),
    getAccessTokenMock: vi.fn().mockResolvedValue('mock-token'),
    updateCardVariablesMock: vi.fn().mockResolvedValue(200),
    dispatchDingTalkCardStopCommandMock: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../src/card-service', () => ({
    finishStoppedAICard: shared.finishStoppedAICardMock,
    hideCardStopButton: shared.hideCardStopButtonMock,
}));

vi.mock('../../src/auth', () => ({
    getAccessToken: shared.getAccessTokenMock,
}));

vi.mock('../../src/card-callback-service', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/card-callback-service')>();
    return {
        ...orig,
        updateCardVariables: shared.updateCardVariablesMock,
    };
});

vi.mock('../../src/command/card-stop-command', () => ({
    dispatchDingTalkCardStopCommand: shared.dispatchDingTalkCardStopCommandMock,
}));

import { handleCardAction } from '../../src/card/card-action-handler';
import {
    clearCardRunRegistryForTest,
    isCardRunStopRequested,
    registerCardRun,
    resolveCardRun,
    attachCardRunController,
} from '../../src/card/card-run-registry';
import { AICardStatus } from '../../src/types';

describe('card-action-handler', () => {
    beforeEach(() => {
        clearCardRunRegistryForTest();
        shared.finishStoppedAICardMock.mockResolvedValue(undefined);
        shared.hideCardStopButtonMock.mockResolvedValue(undefined);
        shared.getAccessTokenMock.mockResolvedValue('mock-token');
        shared.updateCardVariablesMock.mockResolvedValue(200);
        shared.dispatchDingTalkCardStopCommandMock.mockResolvedValue({ ok: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('stops the exact registered card run by outTrackId', async () => {
        const controller = { stop: vi.fn() } as any;
        const card = {
            cardInstanceId: 'card_1',
            outTrackId: 'track_1',
            processQueryKey: 'pq_1',
            state: AICardStatus.INPUTING,
            lastUpdated: Date.now(),
            lastStreamedContent: 'partial output...',
        } as any;

        registerCardRun('track_1', {
            accountId: 'main',
            sessionKey: 'session_1',
            agentId: 'agent_1',
            card,
        });
        attachCardRunController('track_1', controller);

        const result = await handleCardAction({
            analysis: {
                summary: 'btn_stop',
                actionId: 'btn_stop',
                outTrackId: 'track_1',
                processQueryKey: 'pq_1',
                cardInstanceId: 'card_1',
                userId: 'user_abc',
            },
            cfg: {} as any,
            accountId: 'main',
            config: {} as any,
            log: undefined,
        });

        expect(result.handled).toBe(true);
        expect(controller.stop).toHaveBeenCalledTimes(1);
        expect(shared.dispatchDingTalkCardStopCommandMock).toHaveBeenCalledTimes(1);
        expect(shared.dispatchDingTalkCardStopCommandMock).toHaveBeenCalledWith(
            expect.objectContaining({
                accountId: 'main',
                agentId: 'agent_1',
                targetSessionKey: 'session_1',
                clickerUserId: 'user_abc',
            }),
        );
        expect(shared.finishStoppedAICardMock).toHaveBeenCalledTimes(1);
        const stoppedContent = shared.finishStoppedAICardMock.mock.calls[0][1];
        expect(stoppedContent).toContain('partial output...');
        expect(stoppedContent).toContain('已停止');
        expect(shared.hideCardStopButtonMock).toHaveBeenCalledTimes(1);
        expect(shared.hideCardStopButtonMock.mock.calls[0][0]).toBe('track_1');
        expect(isCardRunStopRequested('track_1')).toBe(true);
        expect(resolveCardRun('track_1')).toBeTruthy();
    });

    it('does not dispatch native stop when queued card has no controller (prevents cross-card kill)', async () => {
        const card = {
            cardInstanceId: 'card_queued',
            outTrackId: 'track_queued',
            processQueryKey: 'pq_queued',
            state: AICardStatus.PROCESSING,
            lastUpdated: Date.now(),
        } as any;

        registerCardRun('track_queued', {
            accountId: 'main',
            sessionKey: 'session_shared',
            agentId: 'agent_1',
            card,
        });

        const result = await handleCardAction({
            analysis: {
                summary: 'btn_stop',
                actionId: 'btn_stop',
                outTrackId: 'track_queued',
                processQueryKey: 'pq_queued',
                cardInstanceId: 'card_queued',
            },
            cfg: {} as any,
            accountId: 'main',
            config: {} as any,
            log: undefined,
        });

        expect(result.handled).toBe(true);
        expect(shared.dispatchDingTalkCardStopCommandMock).not.toHaveBeenCalled();
        expect(shared.finishStoppedAICardMock).toHaveBeenCalledTimes(1);
        expect(isCardRunStopRequested('track_queued')).toBe(true);
    });

    it('treats repeated stop on an already stopped card as idempotent', async () => {
        const card = {
            cardInstanceId: 'card_stopped',
            outTrackId: 'track_stopped',
            processQueryKey: 'pq_stopped',
            state: AICardStatus.STOPPED,
            lastUpdated: Date.now(),
        } as any;

        registerCardRun('track_stopped', {
            accountId: 'main',
            sessionKey: 'session_1',
            agentId: 'agent_1',
            card,
        });

        const result = await handleCardAction({
            analysis: {
                summary: 'btn_stop',
                actionId: 'btn_stop',
                outTrackId: 'track_stopped',
                processQueryKey: 'pq_stopped',
                cardInstanceId: 'card_stopped',
            },
            cfg: {} as any,
            accountId: 'main',
            config: {} as any,
            log: undefined,
        });

        expect(result.handled).toBe(true);
        expect(shared.dispatchDingTalkCardStopCommandMock).not.toHaveBeenCalled();
        expect(shared.finishStoppedAICardMock).not.toHaveBeenCalled();
        expect(resolveCardRun('track_stopped')).toBeTruthy();
    });

    it('returns handled=false for non-stop action ids', async () => {
        const result = await handleCardAction({
            analysis: {
                summary: 'feedback_up',
                actionId: 'feedback_up',
            },
            cfg: {} as any,
            accountId: 'main',
            config: {} as any,
            log: undefined,
        });

        expect(result.handled).toBe(false);
    });

    it('rejects stop from non-owner in group chat', async () => {
        const card = {
            cardInstanceId: 'card_group',
            outTrackId: 'track_group',
            state: AICardStatus.INPUTING,
            lastUpdated: Date.now(),
        } as any;

        registerCardRun('track_group', {
            accountId: 'main',
            sessionKey: 'session_group',
            agentId: 'agent_1',
            ownerUserId: 'owner_user',
            card,
        });

        const result = await handleCardAction({
            analysis: {
                summary: 'btn_stop',
                actionId: 'btn_stop',
                outTrackId: 'track_group',
                userId: 'other_user',
            },
            cfg: {} as any,
            accountId: 'main',
            config: {} as any,
            log: undefined,
        });

        expect(result.handled).toBe(true);
        expect(shared.dispatchDingTalkCardStopCommandMock).not.toHaveBeenCalled();
        expect(shared.finishStoppedAICardMock).not.toHaveBeenCalled();
        expect(isCardRunStopRequested('track_group')).toBe(false);
    });

    it('rejects stop when clicker userId is missing in group chat (fail-closed)', async () => {
        const card = {
            cardInstanceId: 'card_nouser',
            outTrackId: 'track_nouser',
            state: AICardStatus.INPUTING,
            lastUpdated: Date.now(),
        } as any;

        registerCardRun('track_nouser', {
            accountId: 'main',
            sessionKey: 'session_nouser',
            agentId: 'agent_1',
            ownerUserId: 'owner_user',
            card,
        });

        const result = await handleCardAction({
            analysis: {
                summary: 'btn_stop',
                actionId: 'btn_stop',
                outTrackId: 'track_nouser',
                userId: undefined,
            } as any,
            cfg: {} as any,
            accountId: 'main',
            config: {} as any,
            log: undefined,
        });

        expect(result.handled).toBe(true);
        expect(shared.dispatchDingTalkCardStopCommandMock).not.toHaveBeenCalled();
        expect(shared.finishStoppedAICardMock).not.toHaveBeenCalled();
        expect(isCardRunStopRequested('track_nouser')).toBe(false);
    });

    it('continues card finalize even if native stop dispatch fails', async () => {
        shared.dispatchDingTalkCardStopCommandMock.mockRejectedValueOnce(
            new Error('dispatch failed'),
        );

        const controller = { stop: vi.fn() } as any;
        const card = {
            cardInstanceId: 'card_err',
            outTrackId: 'track_err',
            state: AICardStatus.INPUTING,
            lastUpdated: Date.now(),
            lastStreamedContent: 'some content',
        } as any;

        registerCardRun('track_err', {
            accountId: 'main',
            sessionKey: 'session_err',
            agentId: 'agent_1',
            card,
        });
        attachCardRunController('track_err', controller);

        const result = await handleCardAction({
            analysis: {
                summary: 'btn_stop',
                actionId: 'btn_stop',
                outTrackId: 'track_err',
                userId: 'user_x',
            },
            cfg: {} as any,
            accountId: 'main',
            config: {} as any,
            log: undefined,
        });

        expect(result.handled).toBe(true);
        expect(shared.finishStoppedAICardMock).toHaveBeenCalledTimes(1);
    });
});
