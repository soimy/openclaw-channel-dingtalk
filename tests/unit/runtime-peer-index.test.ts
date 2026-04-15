import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
    createDocMock: vi.fn(),
    appendToDocMock: vi.fn(),
    searchDocsMock: vi.fn(),
    listDocsMock: vi.fn(),
    sendMessageMock: vi.fn(),
    getAccessTokenMock: vi.fn(),
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

vi.mock("../../src/send-service", () => ({
    sendMessage: shared.sendMessageMock,
}));

vi.mock("../../src/auth", () => ({
    getAccessToken: shared.getAccessTokenMock,
}));

describe("runtime + peer registry + index plugin", () => {
    beforeEach(async () => {
        vi.resetModules();
        shared.createDocMock.mockReset();
        shared.appendToDocMock.mockReset();
        shared.searchDocsMock.mockReset();
        shared.listDocsMock.mockReset();
        shared.sendMessageMock.mockReset();
        shared.getAccessTokenMock.mockReset();
        shared.defineChannelPluginEntryMock.mockClear();
        shared.readStringParamMock.mockClear();
        shared.createDocMock.mockResolvedValue({ docId: "doc_1", title: "测试文档", docType: "alidoc" });
        shared.appendToDocMock.mockResolvedValue({ success: true });
        shared.searchDocsMock.mockResolvedValue([{ docId: "doc_2", title: "周报", docType: "alidoc" }]);
        shared.listDocsMock.mockResolvedValue([{ docId: "doc_3", title: "知识库", docType: "folder" }]);
        shared.sendMessageMock.mockResolvedValue({ ok: true, messageId: "msg_1" });
        shared.getAccessTokenMock.mockResolvedValue("token_abc");
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

    it("index plugin defines a channel entry and only registers gateway methods in full mode", async () => {
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
            config: { channels: { dingtalk: { clientId: "id", clientSecret: "sec" } } },
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as any);

        expect(shared.defineChannelPluginEntryMock).toHaveBeenCalledTimes(1);
        expect(runtimeSpy).toHaveBeenCalledWith(runtime);
        expect(registerChannel).toHaveBeenCalledTimes(1);
        expect(registerGatewayMethod).toHaveBeenCalledTimes(13);
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk.docs.create", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk.docs.append", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk.docs.search", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk.docs.list", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk-connector.docs.create", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk-connector.docs.append", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk-connector.docs.search", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk-connector.docs.list", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk-connector.sendToUser", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk-connector.sendToGroup", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk-connector.send", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk-connector.status", expect.any(Function));
        expect(registerGatewayMethod).toHaveBeenCalledWith("dingtalk-connector.probe", expect.any(Function));
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

    it("registered connector compatibility gateway methods send to explicit user and group targets", async () => {
        const plugin = (await import("../../index")).default;
        const registerGatewayMethod = vi.fn();
        const context = { cronStorePath: "/tmp/openclaw-cron-store.json" };

        await plugin.register({
            runtime: {},
            registrationMode: "full",
            registerChannel: vi.fn(),
            registerGatewayMethod,
            config: { channels: { dingtalk: { clientId: "id", clientSecret: "sec" } } },
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as any);

        const sendToUserHandler = registerGatewayMethod.mock.calls.find((call: any[]) => call[0] === "dingtalk-connector.sendToUser")?.[1];
        const sendToGroupHandler = registerGatewayMethod.mock.calls.find((call: any[]) => call[0] === "dingtalk-connector.sendToGroup")?.[1];

        const respondUser = vi.fn();
        await sendToUserHandler?.({
            context,
            respond: respondUser,
            params: { userId: "staff_1", content: "hello" },
        });
        expect(shared.sendMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ clientId: "id", clientSecret: "sec" }),
            "user:staff_1",
            "hello",
            expect.objectContaining({
                accountId: "default",
                conversationId: "user:staff_1",
                storePath: "/tmp/openclaw-cron-store.json",
            }),
        );
        expect(respondUser).toHaveBeenCalledWith(true, expect.objectContaining({ messageId: "msg_1" }));

        const respondGroup = vi.fn();
        await sendToGroupHandler?.({
            context,
            respond: respondGroup,
            params: { openConversationId: "cid_1", message: "hi group", useAICard: false },
        });
        expect(shared.sendMessageMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ clientId: "id", clientSecret: "sec" }),
            "group:cid_1",
            "hi group",
            expect.objectContaining({ forceMarkdown: true }),
        );
        expect(respondGroup).toHaveBeenCalledWith(true, expect.objectContaining({ target: "group:cid_1" }));
    });

    it("registered connector send/status/probe methods handle fallback content and account status", async () => {
        const plugin = (await import("../../index")).default;
        const registerGatewayMethod = vi.fn();

        await plugin.register({
            runtime: {},
            registrationMode: "full",
            registerChannel: vi.fn(),
            registerGatewayMethod,
            config: {
                channels: {
                    dingtalk: {
                        clientId: "default-id",
                        clientSecret: "default-sec",
                        accounts: {
                            team: { clientId: "team-id", clientSecret: "team-sec", name: "Team" },
                        },
                    },
                },
            },
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        } as any);

        const sendHandler = registerGatewayMethod.mock.calls.find((call: any[]) => call[0] === "dingtalk-connector.send")?.[1];
        const statusHandler = registerGatewayMethod.mock.calls.find((call: any[]) => call[0] === "dingtalk-connector.status")?.[1];
        const probeHandler = registerGatewayMethod.mock.calls.find((call: any[]) => call[0] === "dingtalk-connector.probe")?.[1];

        const respondSend = vi.fn();
        await sendHandler?.({
            context: { cronStorePath: "/tmp/rpc-store.json" },
            respond: respondSend,
            params: { accountId: "team", target: "user:staff_2", content: "", message: "fallback message" },
        });
        expect(shared.sendMessageMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ clientId: "team-id", clientSecret: "team-sec" }),
            "user:staff_2",
            "fallback message",
            expect.objectContaining({
                accountId: "team",
                conversationId: "user:staff_2",
                storePath: "/tmp/rpc-store.json",
            }),
        );
        expect(respondSend).toHaveBeenCalledWith(true, expect.objectContaining({ target: "user:staff_2" }));

        const respondStatus = vi.fn();
        await statusHandler?.({ respond: respondStatus, params: {} });
        expect(respondStatus).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
                channel: "dingtalk",
                accounts: expect.arrayContaining([
                    expect.objectContaining({ accountId: "default", configured: true, clientId: "default-id" }),
                    expect.objectContaining({ accountId: "team", configured: true, clientId: "team-id" }),
                ]),
            }),
        );

        const respondProbe = vi.fn();
        await probeHandler?.({ respond: respondProbe, params: { accountId: "team" } });
        expect(shared.getAccessTokenMock).toHaveBeenCalledWith(
            expect.objectContaining({ clientId: "team-id", clientSecret: "team-sec" }),
            expect.any(Object),
        );
        expect(respondProbe).toHaveBeenCalledWith(true, { ok: true, clientId: "team-id" });
    });

    it("returns partial-success metadata when initial doc append fails after creation", async () => {
        const plugin = (await import("../../index")).default;
        const registerGatewayMethod = vi.fn();

        await plugin.register({
            runtime: {},
            registrationMode: "full",
            registerChannel: vi.fn(),
            registerGatewayMethod,
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
