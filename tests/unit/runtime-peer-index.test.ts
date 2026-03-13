import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
    createDocMock: vi.fn(),
    appendToDocMock: vi.fn(),
    searchDocsMock: vi.fn(),
    listDocsMock: vi.fn(),
    DocCreateAppendErrorMock: class extends Error {
        doc: unknown;
        constructor(doc: unknown) {
            super('initial content append failed after document creation');
            this.name = 'DocCreateAppendError';
            this.doc = doc;
        }
    },
}));

vi.mock('openclaw/plugin-sdk', () => ({
    emptyPluginConfigSchema: vi.fn(() => ({})),
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
    readStringParam: vi.fn((params: Record<string, unknown>, key: string, opts?: { required?: boolean; allowEmpty?: boolean; trim?: boolean }) => {
        const value = params?.[key];
        if (typeof value !== 'string') {
            if (opts?.required) {
                throw new Error(`${key} is required`);
            }
            return undefined;
        }
        const normalized = opts?.trim === false ? value : value.trim();
        if (!opts?.allowEmpty && opts?.required && normalized.length === 0) {
            throw new Error(`${key} is required`);
        }
        if (!opts?.allowEmpty && normalized.length === 0) {
            return undefined;
        }
        return normalized;
    }),
}));

vi.mock('../../src/docs-service', () => ({
    createDoc: shared.createDocMock,
    appendToDoc: shared.appendToDocMock,
    searchDocs: shared.searchDocsMock,
    listDocs: shared.listDocsMock,
    DocCreateAppendError: shared.DocCreateAppendErrorMock,
}));

describe('runtime + peer registry + index plugin', () => {
    beforeEach(async () => {
        vi.resetModules();
        shared.createDocMock.mockReset();
        shared.appendToDocMock.mockReset();
        shared.searchDocsMock.mockReset();
        shared.listDocsMock.mockReset();
        shared.createDocMock.mockResolvedValue({ docId: 'doc_1', title: '测试文档', docType: 'alidoc' });
        shared.appendToDocMock.mockResolvedValue({ success: true });
        shared.searchDocsMock.mockResolvedValue([{ docId: 'doc_2', title: '周报', docType: 'alidoc' }]);
        shared.listDocsMock.mockResolvedValue([{ docId: 'doc_3', title: '知识库', docType: 'folder' }]);
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
        const registerGatewayMethod = vi.fn();
        const runtime = { id: 'runtime1' } as any;

        plugin.register({
            runtime,
            registerChannel,
            registerGatewayMethod,
            config: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as any);

        expect(runtimeSpy).toHaveBeenCalledWith(runtime);
        expect(registerChannel).toHaveBeenCalledTimes(1);
        expect(registerGatewayMethod).toHaveBeenCalledTimes(4);
        expect(registerGatewayMethod).toHaveBeenCalledWith('dingtalk.docs.create', expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith('dingtalk.docs.append', expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith('dingtalk.docs.search', expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith('dingtalk.docs.list', expect.any(Function));
    });

    it('registered docs gateway method validates params and responds with docs payload', async () => {
        const plugin = (await import('../../index')).default;
        const registerGatewayMethod = vi.fn();

        plugin.register({
            runtime: {},
            registerChannel: vi.fn(),
            registerGatewayMethod,
            config: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as any);

        const createHandler = registerGatewayMethod.mock.calls.find((call: any[]) => call[0] === 'dingtalk.docs.create')?.[1];
        const searchHandler = registerGatewayMethod.mock.calls.find((call: any[]) => call[0] === 'dingtalk.docs.search')?.[1];

        const respondCreate = vi.fn();
        await createHandler?.({
            respond: respondCreate,
            params: { spaceId: 'space_1', title: '测试文档', content: '第一段' },
        });
        expect(respondCreate).toHaveBeenCalledWith(true, { docId: 'doc_1', title: '测试文档', docType: 'alidoc' });

        const respondSearch = vi.fn();
        await searchHandler?.({
            respond: respondSearch,
            params: { keyword: '周报' },
        });
        expect(respondSearch).toHaveBeenCalledWith(true, {
            docs: [{ docId: 'doc_2', title: '周报', docType: 'alidoc' }],
        });
    });

    it('returns success payload with partial-success metadata when initial doc append fails after creation', async () => {
        const plugin = (await import('../../index')).default;
        const registerGatewayMethod = vi.fn();

        plugin.register({
            runtime: {},
            registerChannel: vi.fn(),
            registerGatewayMethod,
            config: { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } },
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as any);

        const createHandler = registerGatewayMethod.mock.calls.find((call: any[]) => call[0] === 'dingtalk.docs.create')?.[1];
        const respondCreate = vi.fn();
        shared.createDocMock.mockRejectedValueOnce(
            new shared.DocCreateAppendErrorMock({ docId: 'doc_partial', title: '测试文档', docType: 'alidoc' }),
        );

        await createHandler?.({
            respond: respondCreate,
            params: { spaceId: 'space_1', title: '测试文档', content: '第一段' },
        });

        expect(respondCreate).toHaveBeenCalledWith(true, {
            partialSuccess: true,
            initContentAppended: false,
            docId: 'doc_partial',
            doc: { docId: 'doc_partial', title: '测试文档', docType: 'alidoc' },
            appendError: 'initial content append failed after document creation',
        });
    });
});
