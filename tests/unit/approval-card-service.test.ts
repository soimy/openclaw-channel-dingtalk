import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("test-token"),
}));
vi.mock("axios");
vi.mock("../../src/logger-context", () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock("../../src/config", () => ({
  stripTargetPrefix: vi.fn().mockReturnValue({ targetId: "cidTestConv123" }),
  getConfig: vi.fn(),
  mergeAccountWithDefaults: vi.fn(),
}));
vi.mock("../../src/peer-id-registry", () => ({
  resolveOriginalPeerId: vi.fn().mockReturnValue("cidTestConv123"),
}));
vi.mock("../../src/utils", () => ({
  getProxyBypassOption: vi.fn().mockReturnValue({}),
}));

const NOW_MS = 1000000000000;

function makeExecRequest() {
  return {
    id: "exec:test-id-1",
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 120_000,
    request: {
      command: "trash ~/Downloads/file.csv",
      cwd: "/Users/test/workspace",
      host: "gateway" as const,
      security: "allowlist" as const,
      ask: "on-miss" as const,
      agentId: "main",
      sessionKey: "agent:main:dingtalk:user:123",
    },
  };
}

function makePluginRequest() {
  return {
    id: "plugin:test-uuid-1",
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 120_000,
    request: {
      title: "Test: exec",
      description: "Tool: exec\nCommand: trash ~/Downloads/file.csv",
      severity: "warning" as const,
      toolName: "exec",
      pluginId: "test-approval",
      agentId: "main",
      sessionKey: "agent:main:dingtalk:user:123",
    },
  };
}

describe("buildApprovalCardParamMap", () => {
  it("exec approval: builds CardBtn[] in btns field with sendCardRequest format", async () => {
    const { buildExecApprovalCardParamMap } = await import("../../src/approval-card-service");
    const req = makeExecRequest();
    const params = buildExecApprovalCardParamMap(req, NOW_MS);

    // btns is JSON-serialized CardBtn[]
    const btns = JSON.parse(params.btns) as Array<{
      text: string; color: string; status: string;
      event: { type: string; params: { actionId: string; params: Record<string, string> } };
    }>;
    expect(btns).toHaveLength(3);

    // Verify button structure (text, color, status, event type)
    expect(btns[0]).toMatchObject({ text: "✅ 允许一次", color: "green", status: "normal", event: { type: "sendCardRequest" } });
    expect(btns[1]).toMatchObject({ text: "🔒 永久允许", color: "blue", status: "normal", event: { type: "sendCardRequest" } });
    expect(btns[2]).toMatchObject({ text: "❌ 拒绝", color: "red", status: "normal", event: { type: "sendCardRequest" } });

    // All buttons use same actionId (DingTalk appends index: approval0, approval1, approval2)
    expect(btns[0].event.params.actionId).toBe("approval");
    expect(btns[1].event.params.actionId).toBe("approval");
    expect(btns[2].event.params.actionId).toBe("approval");

    // params carry the approval action data (delivered as-is in cardPrivateData.params)
    expect(btns[0].event.params.params).toEqual({ t: "approval", d: "allow-once", id: "exec:test-id-1" });
    expect(btns[1].event.params.params).toEqual({ t: "approval", d: "allow-always", id: "exec:test-id-1" });
    expect(btns[2].event.params.params).toEqual({ t: "approval", d: "deny", id: "exec:test-id-1" });

    expect(params.hasAction).toBe("true");
    expect(params.status).toBe("");
    expect(params.content).toContain("trash ~/Downloads/file.csv");
  });

  it("plugin approval: builds CardBtn[] with sendCardRequest format", async () => {
    const { buildPluginApprovalCardParamMap } = await import("../../src/approval-card-service");
    const req = makePluginRequest();
    const params = buildPluginApprovalCardParamMap(req, NOW_MS);

    const btns = JSON.parse(params.btns) as Array<{ event: { params: { params: Record<string, string> } } }>;
    expect(btns).toHaveLength(3);
    // Verify first button structure
    expect(btns[0]).toMatchObject({ text: "✅ 允许一次", color: "green", status: "normal", event: { type: "sendCardRequest" } });
    expect(btns[0].event.params.params).toEqual({ t: "approval", d: "allow-once", id: "plugin:test-uuid-1" });
    expect(btns[1].event.params.params).toEqual({ t: "approval", d: "allow-always", id: "plugin:test-uuid-1" });
    expect(btns[2].event.params.params).toEqual({ t: "approval", d: "deny", id: "plugin:test-uuid-1" });
    expect(params.hasAction).toBe("true");
    expect(params.content).toContain("Test: exec");
  });
});

describe("parseApprovalActionValue", () => {
  it("parses valid approval JSON", async () => {
    const { parseApprovalActionValue } = await import("../../src/approval-card-service");
    const result = parseApprovalActionValue('{"t":"approval","d":"allow-once","id":"plugin:abc"}');
    expect(result).toEqual({ t: "approval", d: "allow-once", id: "plugin:abc" });
  });

  it("returns null for non-approval JSON", async () => {
    const { parseApprovalActionValue } = await import("../../src/approval-card-service");
    expect(parseApprovalActionValue('{"t":"feedback","d":"up"}')).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const { parseApprovalActionValue } = await import("../../src/approval-card-service");
    expect(parseApprovalActionValue("feedback_up")).toBeNull();
  });
});

describe("parseApprovalFromCardPrivateData", () => {
  it("parses valid sendCardRequest callback", async () => {
    const { parseApprovalFromCardPrivateData } = await import("../../src/approval-card-service");
    const result = parseApprovalFromCardPrivateData({
      actionIds: ["approval0"],
      params: { t: "approval", d: "allow-once", id: "exec:test-123" },
    });
    expect(result).toEqual({ t: "approval", d: "allow-once", id: "exec:test-123" });
  });

  it("returns null for non-approval actionId", async () => {
    const { parseApprovalFromCardPrivateData } = await import("../../src/approval-card-service");
    expect(parseApprovalFromCardPrivateData({
      actionIds: ["feedback_up"],
      params: { rating: "good" },
    })).toBeNull();
  });

  it("returns null for missing params", async () => {
    const { parseApprovalFromCardPrivateData } = await import("../../src/approval-card-service");
    expect(parseApprovalFromCardPrivateData({ actionIds: ["approval0"] })).toBeNull();
  });

  it("returns null for invalid decision value", async () => {
    const { parseApprovalFromCardPrivateData } = await import("../../src/approval-card-service");
    expect(parseApprovalFromCardPrivateData({
      actionIds: ["approval0"],
      params: { t: "approval", d: "invalid-value", id: "exec:123" },
    })).toBeNull();
  });

  it("returns null for undefined input", async () => {
    const { parseApprovalFromCardPrivateData } = await import("../../src/approval-card-service");
    expect(parseApprovalFromCardPrivateData(undefined)).toBeNull();
  });
});

// Card delivery (createAndDeliver), updateApprovalCardResolved, and store
// have all moved to src/approval/approval-native-adapter.ts.
// Coverage for those lives in tests/unit/approval-native-adapter.test.ts.
