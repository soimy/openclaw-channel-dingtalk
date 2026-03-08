import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMessageMock, sendProactiveMediaMock } = vi.hoisted(() => ({
    sendMessageMock: vi.fn(),
    sendProactiveMediaMock: vi.fn(),
}));

const { prepareMediaInputMock } = vi.hoisted(() => ({
    prepareMediaInputMock: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
    extractToolSend: vi.fn((args: Record<string, unknown>) => {
        const target = args.to;
        if (typeof target !== 'string' || !target.trim()) {
            return null;
        }
        return { to: target.trim() };
    }),
    jsonResult: vi.fn((payload: unknown) => payload),
    readStringParam: vi.fn((params: Record<string, unknown>, key: string, opts?: { required?: boolean; allowEmpty?: boolean; trim?: boolean }) => {
        const raw = params[key];
        if (raw == null) {
            if (opts?.required) {
                throw new Error(`${key} is required`);
            }
            return undefined;
        }
        if (typeof raw !== 'string') {
            if (opts?.required) {
                throw new Error(`${key} must be a string`);
            }
            return undefined;
        }
        const normalized = opts?.trim === false ? raw : raw.trim();
        if (!opts?.allowEmpty && normalized.length === 0) {
            if (opts?.required) {
                throw new Error(`${key} is required`);
            }
            return undefined;
        }
        return normalized;
    }),
}));

vi.mock('dingtalk-stream', () => ({
    DWClient: vi.fn(),
    TOPIC_ROBOT: 'TOPIC_ROBOT',
}));

vi.mock('../../src/send-service', async () => ({
    sendMessage: sendMessageMock,
    sendProactiveMedia: sendProactiveMediaMock,
    sendBySession: vi.fn(),
    uploadMedia: vi.fn(),
}));

vi.mock('../../src/media-utils', async () => {
    const actual = await vi.importActual<typeof import('../../src/media-utils')>('../../src/media-utils');
    return {
        ...actual,
        prepareMediaInput: prepareMediaInputMock,
    };
});

import { dingtalkPlugin } from '../../src/channel';

describe('dingtalkPlugin.actions.send', () => {
    const cfg = { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } };

    beforeEach(() => {
        sendMessageMock.mockReset();
        sendProactiveMediaMock.mockReset();
        prepareMediaInputMock.mockReset();
        prepareMediaInputMock.mockImplementation(async (input: string) => ({ path: input }));
    });

    it('forces voice mediaType when asVoice=true with media input', async () => {
        sendProactiveMediaMock.mockResolvedValueOnce({ ok: true, messageId: 'voice_1', data: { messageId: 'voice_1' } });

        await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: cfg as any,
            params: {
                to: 'cidA1B2C3',
                media: '/tmp/audio.mp3',
                asVoice: true,
            },
            accountId: 'default',
            dryRun: false,
        } as any);

        expect(sendProactiveMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'cidA1B2C3',
            '/tmp/audio.mp3',
            'voice',
            expect.objectContaining({ accountId: 'default' })
        );
        expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('rejects asVoice when media input is not an audio file', async () => {
        await expect(
            dingtalkPlugin.actions?.handleAction?.({
                channel: 'dingtalk',
                action: 'send',
                cfg: cfg as any,
                params: {
                    to: 'cidA1B2C3',
                    media: '/tmp/not-audio.pdf',
                    asVoice: true,
                },
                accountId: 'default',
                dryRun: false,
            } as any),
        ).rejects.toThrow(/requires an audio file/i);

        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
        expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('sends text proactively when no media is provided', async () => {
        sendMessageMock.mockResolvedValueOnce({ ok: true, data: { processQueryKey: 'text_1' } });

        await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: cfg as any,
            params: {
                to: 'user_abc',
                message: 'hello',
            },
            accountId: 'default',
            dryRun: false,
        } as any);

        expect(sendMessageMock).toHaveBeenCalledWith(
            expect.any(Object),
            'user_abc',
            'hello',
            expect.objectContaining({ accountId: 'default' })
        );
        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
    });

    it('rejects asVoice without media path', async () => {
        await expect(
            dingtalkPlugin.actions?.handleAction?.({
                channel: 'dingtalk',
                action: 'send',
                cfg: cfg as any,
                params: {
                    to: 'user_abc',
                    message: 'hello',
                    asVoice: true,
                },
                accountId: 'default',
                dryRun: false,
            } as any),
        ).rejects.toThrow(/requires media\/path\/filePath\/mediaUrl/);

        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
    });

    it('uses downloaded temp path for mediaUrl instead of resolving as local relative path', async () => {
        prepareMediaInputMock.mockResolvedValueOnce({
            path: '/tmp/dingtalk_remote.png',
            cleanup: vi.fn(),
        });
        sendProactiveMediaMock.mockResolvedValueOnce({
            ok: true,
            messageId: 'media_1',
            data: { messageId: 'media_1' },
        });

        await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: cfg as any,
            params: {
                to: 'cidA1B2C3',
                mediaUrl: 'https://example.com/photo.png',
            },
            accountId: 'default',
            dryRun: false,
        } as any);

        expect(prepareMediaInputMock).toHaveBeenCalledWith(
            'https://example.com/photo.png',
            undefined,
            undefined
        );
        expect(sendProactiveMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'cidA1B2C3',
            '/tmp/dingtalk_remote.png',
            'image',
            expect.objectContaining({ accountId: 'default' })
        );
    });
});
