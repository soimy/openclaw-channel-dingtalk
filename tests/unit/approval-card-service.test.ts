import { describe, it, expect, vi, beforeEach } from "vitest";

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

  it("plugin approval: encodes actionId vars with plugin prefix", async () => {
    const { buildPluginApprovalCardParamMap } = await import("../../src/approval-card-service");
    const req = makePluginRequest();
    const params = buildPluginApprovalCardParamMap(req, NOW_MS);
    expect(JSON.parse(params.actionIdOnce)).toEqual({ t: "approval", d: "allow-once", id: "plugin:test-uuid-1" });
    expect(params.status).toBe("");
    expect(params.content).toContain("Test: exec");
  });
});

describe("ApprovalCardStore", () => {
  beforeEach(async () => {
    const { approvalCardStore } = await import("../../src/approval-card-service");
    approvalCardStore.clear();
  });

  it("stores and retrieves outTrackId by approvalId", async () => {
    const { approvalCardStore } = await import("../../src/approval-card-service");
    approvalCardStore.set("exec:abc", {
      outTrackId: "track-123",
      conversationId: "cid:test",
      accountId: "default",
      expiresAt: Date.now() + 60_000,
    });
    expect(approvalCardStore.get("exec:abc")).toMatchObject({ outTrackId: "track-123" });
    approvalCardStore.delete("exec:abc");
    expect(approvalCardStore.get("exec:abc")).toBeUndefined();
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

describe("resolveApprovalDecision", () => {
  it("calls gateway with correct method for exec approval", async () => {
    const mockRequest = vi.fn().mockResolvedValue({ ok: true });
    const { resolveApprovalDecision } = await import("../../src/approval-card-service");
    await resolveApprovalDecision(
      { t: "approval", d: "allow-once", id: "exec:abc" },
      { request: mockRequest } as any,
    );
    expect(mockRequest).toHaveBeenCalledWith(
      "exec.approval.resolve",
      expect.objectContaining({ id: "exec:abc", decision: "allow-once" }),
      expect.anything(),
    );
  });

  it("calls gateway with plugin.approval.resolve for plugin approval", async () => {
    const mockRequest = vi.fn().mockResolvedValue({ ok: true });
    const { resolveApprovalDecision } = await import("../../src/approval-card-service");
    await resolveApprovalDecision(
      { t: "approval", d: "deny", id: "plugin:abc" },
      { request: mockRequest } as any,
    );
    expect(mockRequest).toHaveBeenCalledWith(
      "plugin.approval.resolve",
      expect.objectContaining({ id: "plugin:abc", decision: "deny" }),
      expect.anything(),
    );
  });
});
