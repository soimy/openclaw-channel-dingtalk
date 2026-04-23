import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
    createDocMock: vi.fn(),
    appendToDocMock: vi.fn(),
    searchDocsMock: vi.fn(),
    listDocsMock: vi.fn(),
    defineChannelPluginEntryMock: vi.fn(
        (entry: {
            id: string;
            name: string;
            description: string;
            plugin: unknown;
            setRuntime?: (runtime: unknown) => void;
            registerFull?: (api: unknown) => void;
        }) => ({
            id: entry.id,
            name: entry.name,
            description: entry.description,
            register(api: {
                runtime: unknown;
                registerChannel: (registration: { plugin: unknown }) => void;
                registrationMode?: string;
                on?: (...args: unknown[]) => void;
            }) {
                entry.setRuntime?.(api.runtime);
                api.registerChannel({ plugin: entry.plugin });
                if (api.registrationMode === "full") {
                    entry.registerFull?.(api);
                }
            },
        }),
    ),
    readStringParamMock: vi.fn(
        (
            params: Record<string, unknown>,
            key: string,
            opts?: { required?: boolean; allowEmpty?: boolean; trim?: boolean },
        ) => {
            const value = params?.[key];
            if (typeof value !== "string") {
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
        },
    ),
    DocCreateAppendErrorMock: class extends Error {
        doc: unknown;

        constructor(doc: unknown) {
            super("initial content append failed after document creation");
            this.name = "DocCreateAppendError";
            this.doc = doc;
        }
    },
}));

vi.mock("openclaw/plugin-sdk/core", () => ({
    defineChannelPluginEntry: shared.defineChannelPluginEntryMock,
    emptyPluginConfigSchema: vi.fn(() => ({ schema: {} })),
}));

vi.mock("openclaw/plugin-sdk/param-readers", () => ({
    readStringParam: shared.readStringParamMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-store", () => ({
    createPluginRuntimeStore: vi.fn((errorMessage: string) => {
        let runtime: unknown;
        return {
            setRuntime(next: unknown) {
                runtime = next;
            },
            getRuntime() {
                if (!runtime) {
                    throw new Error(errorMessage);
                }
                return runtime;
            },
        };
    }),
}));

vi.mock("openclaw/plugin-sdk/tool-send", () => ({
    extractToolSend: vi.fn((args: Record<string, unknown>) => {
        const to = typeof args.to === "string" ? args.to.trim() : "";
        return to ? { to } : null;
    }),
}));

vi.mock("../../src/channel", () => ({
    dingtalkPlugin: { id: "dingtalk", meta: { label: "DingTalk" } },
}));

vi.mock("../../src/docs-service", () => ({
    createDoc: shared.createDocMock,
    appendToDoc: shared.appendToDocMock,
    searchDocs: shared.searchDocsMock,
    listDocs: shared.listDocsMock,
    DocCreateAppendError: shared.DocCreateAppendErrorMock,
}));

describe("runtime + peer registry + index plugin", () => {
    beforeEach(async () => {
        vi.resetModules();
        shared.createDocMock.mockReset();
        shared.appendToDocMock.mockReset();
        shared.searchDocsMock.mockReset();
        shared.listDocsMock.mockReset();
        shared.defineChannelPluginEntryMock.mockClear();
        shared.readStringParamMock.mockClear();
        shared.createDocMock.mockResolvedValue({ docId: "doc_1", title: "测试文档", docType: "alidoc" });
        shared.appendToDocMock.mockResolvedValue({ success: true });
        shared.searchDocsMock.mockResolvedValue([{ docId: "doc_2", title: "周报", docType: "alidoc" }]);
        shared.listDocsMock.mockResolvedValue([{ docId: "doc_3", title: "知识库", docType: "folder" }]);
        const peer = await import("../../src/peer-id-registry");
        peer.clearPeerIdRegistry();
    });

    it("runtime getter throws before initialization and returns assigned runtime later", async () => {
        const runtime = await import("../../src/runtime");

        expect(() => runtime.getDingTalkRuntime()).toThrow("DingTalk runtime not initialized");

        const rt = { channel: {} } as any;
        runtime.setDingTalkRuntime(rt);

        expect(runtime.getDingTalkRuntime()).toBe(rt);
    });

    it("peer id registry preserves original case by lowercased key", async () => {
        const peer = await import("../../src/peer-id-registry");

        peer.registerPeerId("CidAbC+123");

        expect(peer.resolveOriginalPeerId("cidabc+123")).toBe("CidAbC+123");
        expect(peer.resolveOriginalPeerId("unknown")).toBe("unknown");

        peer.clearPeerIdRegistry();
        expect(peer.resolveOriginalPeerId("cidabc+123")).toBe("cidabc+123");
    });

    it("index plugin defines a channel entry and only registers docs methods in full mode", async () => {
        const runtimeModule = await import("../../src/runtime");
        const runtimeSpy = vi.spyOn(runtimeModule, "setDingTalkRuntime");

        const plugin = (await import("../../index")).default;

        const registerChannel = vi.fn();
        const registerGatewayMethod = vi.fn();
        const runtime = { id: "runtime1" } as any;

        await plugin.register({
            runtime,
            registrationMode: "full",
            registerChannel,
            registerGatewayMethod,
            on: vi.fn(),
            config: { channels: { dingtalk: { clientId: "id", clientSecret: "sec" } } },
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as any);

        expect(shared.defineChannelPluginEntryMock).toHaveBeenCalledTimes(1);
        expect(runtimeSpy).toHaveBeenCalledWith(runtime);
        expect(registerChannel).toHaveBeenCalledTimes(1);
        expect(registerGatewayMethod).toHaveBeenCalledTimes(4);
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk.docs.create", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk.docs.append", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk.docs.search", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk.docs.list", expect.any(Function));
    });

    it("skips docs gateway registration outside full registration mode", async () => {
        const plugin = (await import("../../index")).default;
        const registerGatewayMethod = vi.fn();

        await plugin.register({
            runtime: {},
            registrationMode: "setup",
            registerChannel: vi.fn(),
            registerGatewayMethod,
            config: { channels: { dingtalk: { clientId: "id", clientSecret: "sec" } } },
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as any);

        expect(registerGatewayMethod).not.toHaveBeenCalled();
    });

    it("registered docs gateway methods validate params and respond with docs payload", async () => {
        const plugin = (await import("../../index")).default;
        const registerGatewayMethod = vi.fn();

        await plugin.register({
            runtime: {},
            registrationMode: "full",
            registerChannel: vi.fn(),
            registerGatewayMethod,
            on: vi.fn(),
            config: { channels: { dingtalk: { clientId: "id", clientSecret: "sec" } } },
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as any);

        const createHandler = registerGatewayMethod.mock.calls.find((call: any[]) => call[0] === "dingtalk.docs.create")?.[1];
        const searchHandler = registerGatewayMethod.mock.calls.find((call: any[]) => call[0] === "dingtalk.docs.search")?.[1];

        const respondCreate = vi.fn();
        await createHandler?.({
            respond: respondCreate,
            params: { spaceId: "space_1", title: "测试文档", content: "第一段" },
        });
        expect(shared.readStringParamMock).toHaveBeenCalled();
        expect(respondCreate).toHaveBeenCalledWith(true, { docId: "doc_1", title: "测试文档", docType: "alidoc" });

        const respondSearch = vi.fn();
        await searchHandler?.({
            respond: respondSearch,
            params: { keyword: "周报" },
        });
        expect(respondSearch).toHaveBeenCalledWith(true, {
            docs: [{ docId: "doc_2", title: "周报", docType: "alidoc" }],
        });
    });

    it("returns partial-success metadata when initial doc append fails after creation", async () => {
        const plugin = (await import("../../index")).default;
        const registerGatewayMethod = vi.fn();

        await plugin.register({
            runtime: {},
            registrationMode: "full",
            registerChannel: vi.fn(),
            registerGatewayMethod,
            on: vi.fn(),
            config: { channels: { dingtalk: { clientId: "id", clientSecret: "sec" } } },
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as any);

        const createHandler = registerGatewayMethod.mock.calls.find((call: any[]) => call[0] === "dingtalk.docs.create")?.[1];
        const respondCreate = vi.fn();
        shared.createDocMock.mockRejectedValueOnce(
            new shared.DocCreateAppendErrorMock({ docId: "doc_partial", title: "测试文档", docType: "alidoc" }),
        );

        await createHandler?.({
            respond: respondCreate,
            params: { spaceId: "space_1", title: "测试文档", content: "第一段" },
        });

        expect(respondCreate).toHaveBeenCalledWith(true, {
            partialSuccess: true,
            initContentAppended: false,
            docId: "doc_partial",
            doc: { docId: "doc_partial", title: "测试文档", docType: "alidoc" },
            appendError: "initial content append failed after document creation",
        });
    });
});
