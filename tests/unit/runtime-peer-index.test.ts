import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk', () => ({
    emptyPluginConfigSchema: vi.fn(() => ({})),
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

describe('runtime + peer registry + index plugin', () => {
    beforeEach(async () => {
        vi.resetModules();
        const peer = await import('../../src/peer-id-registry');
        peer.clearPeerIdRegistry();
    });

    it('runtime getter throws before initialization and returns assigned runtime later', async () => {
        const runtime = await import('../../src/runtime');

        expect(() => runtime.getDingTalkRuntime()).toThrow('DingTalk runtime not initialized');

        const rt = { channel: {} } as any;
        runtime.setDingTalkRuntime(rt);

        expect(runtime.getDingTalkRuntime()).toBe(rt);
    });

    it('peer id registry preserves original case by lowercased key', async () => {
        const peer = await import('../../src/peer-id-registry');

        peer.registerPeerId('CidAbC+123');

        expect(peer.resolveOriginalPeerId('cidabc+123')).toBe('CidAbC+123');
        expect(peer.resolveOriginalPeerId('unknown')).toBe('unknown');

        peer.clearPeerIdRegistry();
        expect(peer.resolveOriginalPeerId('cidabc+123')).toBe('cidabc+123');
    });

    it('index plugin register wires runtime and channel registration', async () => {
        const runtimeModule = await import('../../src/runtime');
        const runtimeSpy = vi.spyOn(runtimeModule, 'setDingTalkRuntime');

        const plugin = (await import('../../index')).default;

        const registerChannel = vi.fn();
        const runtime = { id: 'runtime1' } as any;

        plugin.register({ runtime, registerChannel } as any);

        expect(runtimeSpy).toHaveBeenCalledWith(runtime);
        expect(registerChannel).toHaveBeenCalledTimes(1);
    });
});
