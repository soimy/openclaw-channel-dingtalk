import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMessageMock } = vi.hoisted(() => ({
    sendMessageMock: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('dingtalk-stream', () => ({
    DWClient: vi.fn(),
    TOPIC_ROBOT: 'TOPIC_ROBOT',
}));

vi.mock('../../src/send-service', async () => ({
    detectMediaTypeFromExtension: vi.fn().mockReturnValue('file'),
    sendMessage: sendMessageMock,
    sendProactiveMedia: vi.fn(),
    sendBySession: vi.fn(),
    uploadMedia: vi.fn(),
}));

import { dingtalkPlugin } from '../../src/channel';

describe('plugin outbound lifecycle', () => {
    beforeEach(() => {
        sendMessageMock.mockReset();
    });

    it('should trigger sendMessage when outbound.sendText is called', async () => {
        sendMessageMock.mockResolvedValue({ ok: true, data: { messageId: 'm_123' } });

        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'ding-client-id',
                    clientSecret: 'secret',
                },
            },
        };

        const result = await dingtalkPlugin.outbound.sendText({
            cfg,
            to: 'user_123',
            text: 'hello',
            accountId: 'default',
            log: undefined,
        });

        expect(sendMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ clientId: 'ding-client-id' }),
            'user_123',
            'hello',
            expect.objectContaining({ accountId: 'default' })
        );
        expect(result.channel).toBe('dingtalk');
        expect(result.messageId).toBe('m_123');
    });

    it('should capture DingTalk API error code and throw from sendText', async () => {
        sendMessageMock.mockResolvedValue({ ok: false, error: 'DingTalk API error 300001: invalid robot code' });

        const cfg = {
            channels: {
                dingtalk: {
                    clientId: 'ding-client-id',
                    clientSecret: 'secret',
                },
            },
        };

        await expect(
            dingtalkPlugin.outbound.sendText({
                cfg,
                to: 'cidA1B2C3',
                text: 'hello',
                accountId: 'default',
                log: undefined,
            })
        ).rejects.toThrow(/300001/);
    });
});
