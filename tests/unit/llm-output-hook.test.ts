import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { clearAllForTest, getUsageByRunId, recordRunStart } from "../../src/run-usage-store";

vi.mock("../../src/channel", () => ({
  dingtalkPlugin: {},
}));

vi.mock("../../src/runtime", () => ({
  setDingTalkRuntime: vi.fn(),
}));

vi.mock("../../src/config", () => ({
  getConfig: vi.fn(() => ({})),
}));

vi.mock("../../src/docs-service", () => ({
  createDoc: vi.fn(),
  appendToDoc: vi.fn(),
  searchDocs: vi.fn(),
  listDocs: vi.fn(),
  DocCreateAppendError: class extends Error {},
}));

describe("llm_output hook registration", () => {
  let registeredHooks: Map<string, Function>;
  let mockApi: OpenClawPluginApi;

  beforeEach(() => {
    clearAllForTest();
    registeredHooks = new Map();
    mockApi = {
      config: {},
      pluginConfig: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerChannel: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registrationMode: "full",
      runtime: {},
      on: vi.fn((hookName: string, handler: Function) => {
        registeredHooks.set(hookName, handler);
      }),
    } as unknown as OpenClawPluginApi;
  });

  it("registers an llm_output hook via api.on", async () => {
    const mod = await import("../../index");
    const entry = mod.default;
    entry.register(mockApi);

    expect(mockApi.on).toHaveBeenCalledWith(
      "llm_output",
      expect.any(Function),
    );
  });

  it("accumulates usage from llm_output events", async () => {
    const mod = await import("../../index");
    const entry = mod.default;
    entry.register(mockApi);

    const handler = registeredHooks.get("llm_output")!;
    expect(handler).toBeDefined();

    recordRunStart("run-abc");

    await handler(
      {
        runId: "run-abc",
        sessionId: "session-xyz",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        assistantTexts: ["Hello"],
        usage: { input: 100, output: 50, total: 150 },
      },
      { channelId: "dingtalk", sessionId: "session-xyz" },
    );

    expect(getUsageByRunId("run-abc")).toEqual({
      input: 100,
      output: 50,
      total: 150,
    });
  });

  it("skips events without usage data", async () => {
    const mod = await import("../../index");
    const entry = mod.default;
    entry.register(mockApi);

    const handler = registeredHooks.get("llm_output")!;

    recordRunStart("run-skip");

    await handler(
      {
        runId: "run-skip",
        sessionId: "session-skip",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        assistantTexts: ["No usage"],
      },
      { channelId: "dingtalk", sessionId: "session-skip" },
    );

    expect(getUsageByRunId("run-skip")).toEqual({});
  });
});
