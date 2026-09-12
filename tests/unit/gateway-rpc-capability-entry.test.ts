import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const INDEX_IMPORT_TIMEOUT_MS = 15_000;

vi.mock("../../src/channel", () => ({
  dingtalkPlugin: {},
}));

vi.mock("../../src/runtime", () => ({
  setDingTalkRuntime: vi.fn(),
}));

vi.mock("../../src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config")>();
  return {
    ...actual,
    getConfig: vi.fn(() => ({ clientId: "id", clientSecret: "secret" })),
    listDingTalkAccountIds: vi.fn(() => []),
    resolveDingTalkAccount: vi.fn(() => ({ configured: true, clientId: "id" })),
  };
});

vi.mock("../../src/docs-service", () => ({
  createDoc: vi.fn(async () => ({ docId: "doc1", title: "t", docType: "alidoc" })),
  appendToDoc: vi.fn(async () => ({ success: true })),
  searchDocs: vi.fn(async () => []),
  listDocs: vi.fn(async () => []),
  DocCreateAppendError: class extends Error {},
}));

vi.mock("../../src/send-service", () => ({
  sendMessage: vi.fn(async () => ({ ok: true, messageId: "m1" })),
}));

vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn(async () => "token"),
}));

vi.mock("../../src/card/ask-user-question", () => ({
  registerDingTalkAskUserQuestionTool: vi.fn(),
}));

vi.mock("../../src/run-usage-store", () => ({
  accumulateUsage: vi.fn(),
}));

type Handler = (args: {
  context?: { cronStorePath?: string };
  params: Record<string, unknown>;
  respond: (ok: boolean, payload: unknown) => void;
}) => Promise<void> | void;

async function loadEntry() {
  const mod = await import("../../index");
  return mod.default;
}

function makeApi(cfg: Record<string, unknown>) {
  const methods = new Map<string, Handler>();
  const mockApi = {
    config: cfg,
    pluginConfig: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn((name: string, handler: Handler) => {
      methods.set(name, handler);
    }),
    registrationMode: "full",
    runtime: {},
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;
  return { mockApi, methods };
}

function callHandler(
  handler: Handler,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload: unknown }> {
  return new Promise((resolve) => {
    handler({
      params,
      respond: (ok, payload) => resolve({ ok, payload }),
    });
  });
}

function dingtalkCfg(gatewayRpc: unknown): Record<string, unknown> {
  return { channels: { dingtalk: { gatewayRpc } } };
}

describe("gateway RPC capability gates (Issue #608 问题 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("docs RPC works by default (no gatewayRpc config)", async () => {
    const entry = await loadEntry();
    const { mockApi, methods } = makeApi({ channels: { dingtalk: {} } });
    entry.register(mockApi);
    const res = await callHandler(methods.get("dingtalk.docs.create")!, {
      spaceId: "spaceA",
      title: "T",
    });
    expect(res.ok).toBe(true);
  }, INDEX_IMPORT_TIMEOUT_MS);

  it("docs RPC denied when gatewayRpc.tools.docs = false (canonical namespace)", async () => {
    const entry = await loadEntry();
    const { mockApi, methods } = makeApi(dingtalkCfg({ tools: { docs: false } }));
    entry.register(mockApi);
    const res = await callHandler(methods.get("dingtalk.docs.create")!, {
      spaceId: "spaceA",
      title: "T",
    });
    expect(res.ok).toBe(false);
    expect((res.payload as { error: string }).error).toContain("disabled by config");
  }, INDEX_IMPORT_TIMEOUT_MS);

  it("docs RPC denial applies to dingtalk-connector aliases too", async () => {
    const entry = await loadEntry();
    const { mockApi, methods } = makeApi(dingtalkCfg({ tools: { docs: false } }));
    entry.register(mockApi);
    const res = await callHandler(methods.get("dingtalk-connector.docs.search")!, {
      keyword: "k",
    });
    expect(res.ok).toBe(false);
    expect((res.payload as { error: string }).error).toContain("disabled by config");
  }, INDEX_IMPORT_TIMEOUT_MS);

  it("docs RPC denied when spaceId outside allowedSpaceIds", async () => {
    const entry = await loadEntry();
    const { mockApi, methods } = makeApi(
      dingtalkCfg({ docs: { allowedSpaceIds: ["spaceOk"] } }),
    );
    entry.register(mockApi);
    const denied = await callHandler(methods.get("dingtalk.docs.list")!, { spaceId: "other" });
    expect(denied.ok).toBe(false);
    expect((denied.payload as { error: string }).error).toContain("allowedSpaceIds");
    const allowed = await callHandler(methods.get("dingtalk.docs.list")!, { spaceId: "spaceOk" });
    expect(allowed.ok).toBe(true);
  }, INDEX_IMPORT_TIMEOUT_MS);

  it("proactive send denied when gatewayRpc.tools.proactiveSend = false", async () => {
    const entry = await loadEntry();
    const { mockApi, methods } = makeApi(dingtalkCfg({ tools: { proactiveSend: false } }));
    entry.register(mockApi);
    for (const [method, params] of [
      ["dingtalk-connector.sendToUser", { userId: "u1", content: "hi" }],
      ["dingtalk-connector.sendToGroup", { openConversationId: "g1", content: "hi" }],
      ["dingtalk-connector.send", { target: "user:u1", content: "hi" }],
    ] as const) {
      const res = await callHandler(methods.get(method)!, params);
      expect(res.ok).toBe(false);
      expect((res.payload as { error: string }).error).toContain("disabled by config");
    }
  }, INDEX_IMPORT_TIMEOUT_MS);

  it("proactive send denied when target outside allowedTargets", async () => {
    const entry = await loadEntry();
    const { mockApi, methods } = makeApi(
      dingtalkCfg({ send: { allowedTargets: ["group:ok"] } }),
    );
    entry.register(mockApi);
    const denied = await callHandler(methods.get("dingtalk-connector.send")!, {
      target: "user:u1",
      content: "hi",
    });
    expect(denied.ok).toBe(false);
    expect((denied.payload as { error: string }).error).toContain("allowedTargets");
    const allowed = await callHandler(methods.get("dingtalk-connector.sendToGroup")!, {
      openConversationId: "ok",
      content: "hi",
    });
    expect(allowed.ok).toBe(true);
  }, INDEX_IMPORT_TIMEOUT_MS);

  it("proactive send works by default (backward compatible)", async () => {
    const entry = await loadEntry();
    const { mockApi, methods } = makeApi({ channels: { dingtalk: {} } });
    entry.register(mockApi);
    const res = await callHandler(methods.get("dingtalk-connector.send")!, {
      target: "user:u1",
      content: "hi",
    });
    expect(res.ok).toBe(true);
  }, INDEX_IMPORT_TIMEOUT_MS);

  it("denials log under [DingTalk][GatewayRPC][Denied]", async () => {
    const entry = await loadEntry();
    const { mockApi, methods } = makeApi(dingtalkCfg({ tools: { docs: false } }));
    entry.register(mockApi);
    await callHandler(methods.get("dingtalk.docs.create")!, { spaceId: "s", title: "t" });
    const warn = (mockApi.logger as { warn: ReturnType<typeof vi.fn> }).warn;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[DingTalk][GatewayRPC][Denied]"));
  }, INDEX_IMPORT_TIMEOUT_MS);
});
