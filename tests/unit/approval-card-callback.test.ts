import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDispatchApprove = vi.fn().mockResolvedValue({ ok: true });
const mockLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("test-token"),
}));
vi.mock("axios");
vi.mock("../../src/logger-context", () => ({
  getLogger: vi.fn().mockReturnValue(mockLog),
}));
vi.mock("../../src/utils", () => ({
  getProxyBypassOption: vi.fn().mockReturnValue({}),
}));
vi.mock("../../src/command/card-approve-command", () => ({
  dispatchDingTalkCardApproveCommand: mockDispatchApprove,
}));

describe("handleApprovalCardCallback (command session dispatch)", () => {
  const mockCfg = { channels: {} } as any;
  const mockConfig = { clientId: "test", clientSecret: "test" } as any;

  beforeEach(async () => {
    mockDispatchApprove.mockReset().mockResolvedValue({ ok: true });
    mockLog.debug.mockClear();
    mockLog.info.mockClear();

    // Re-set getLogger mock since global mockReset clears it
    const { getLogger } = await import("../../src/logger-context");
    vi.mocked(getLogger).mockReturnValue(mockLog);
    const { approvalCardStore } = await import("../../src/approval-card-service");
    approvalCardStore.clear();
  });

  it("dispatches via command session and logs success", async () => {
    const { handleApprovalCardCallback, approvalCardStore } = await import("../../src/approval-card-service");
    approvalCardStore.set("exec:abc", {
      outTrackId: "track-123",
      conversationId: "cidTest",
      accountId: "default",
      agentId: "main",
      sessionKey: "agent:main:dingtalk:user:123",
      expiresAt: Date.now() + 60_000,
    });

    await handleApprovalCardCallback(
      { t: "approval", d: "allow-once", id: "exec:abc" },
      mockCfg,
      mockConfig,
      "clicker-user-id",
    );

    expect(mockDispatchApprove).toHaveBeenCalledTimes(1);
    expect(mockDispatchApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "exec:abc",
        decision: "allow-once",
        agentId: "main",
        targetSessionKey: "agent:main:dingtalk:user:123",
        clickerUserId: "clicker-user-id",
      }),
    );
  });

  it("warns when no store entry exists", async () => {
    const { handleApprovalCardCallback } = await import("../../src/approval-card-service");


    await handleApprovalCardCallback(
      { t: "approval", d: "allow-once", id: "exec:missing" },
      mockCfg,
      mockConfig,
    );

    expect(mockDispatchApprove).not.toHaveBeenCalled();
    expect(mockLog?.warn).toHaveBeenCalledWith(
      expect.stringContaining("No store entry for exec:missing"),
    );
  });

  it("warns when sessionKey is empty", async () => {
    const { handleApprovalCardCallback, approvalCardStore } = await import("../../src/approval-card-service");


    approvalCardStore.set("exec:no-session", {
      outTrackId: "track-1",
      conversationId: "cidTest",
      accountId: "default",
      agentId: "main",
      sessionKey: "",
      expiresAt: Date.now() + 60_000,
    });

    await handleApprovalCardCallback(
      { t: "approval", d: "deny", id: "exec:no-session" },
      mockCfg,
      mockConfig,
    );

    expect(mockDispatchApprove).not.toHaveBeenCalled();
    expect(mockLog?.warn).toHaveBeenCalledWith(
      expect.stringContaining("No sessionKey for exec:no-session"),
    );
  });

  it("logs error when dispatch fails", async () => {
    mockDispatchApprove.mockRejectedValue(new Error("dispatch failed"));
    const { handleApprovalCardCallback, approvalCardStore } = await import("../../src/approval-card-service");


    approvalCardStore.set("exec:fail", {
      outTrackId: "track-1",
      conversationId: "cidTest",
      accountId: "default",
      agentId: "main",
      sessionKey: "agent:main:dingtalk:user:123",
      expiresAt: Date.now() + 60_000,
    });

    await handleApprovalCardCallback(
      { t: "approval", d: "allow-once", id: "exec:fail" },
      mockCfg,
      mockConfig,
    );

    expect(mockLog?.error).toHaveBeenCalledWith(
      expect.stringContaining("Command session dispatch failed"),
    );
  });
});
