import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGatewayRequest = vi.fn();
const mockGatewayClient = { request: mockGatewayRequest, start: vi.fn() };

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
vi.mock("../../src/utils", () => ({
  getProxyBypassOption: vi.fn().mockReturnValue({}),
}));
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  createOperatorApprovalsGatewayClient: vi.fn().mockResolvedValue(mockGatewayClient),
}));

describe("handleApprovalCardCallback", () => {
  const mockCfg = { channels: {} } as any;
  const mockConfig = { clientId: "test", clientSecret: "test" } as any;

  beforeEach(async () => {
    mockGatewayRequest.mockReset();
    const { getAccessToken } = await import("../../src/auth");
    vi.mocked(getAccessToken).mockResolvedValue("test-token");
    const { getProxyBypassOption } = await import("../../src/utils");
    vi.mocked(getProxyBypassOption).mockReturnValue({});
  });

  it("resolves on first attempt and updates card", async () => {
    mockGatewayRequest.mockResolvedValue({ ok: true });
    const axios = (await import("axios")).default;
    vi.mocked(axios.put).mockResolvedValue({ data: {} });
    const { handleApprovalCardCallback, approvalCardStore } = await import("../../src/approval-card-service");

    approvalCardStore.set("exec:abc", {
      outTrackId: "track-123",
      conversationId: "cidTest",
      accountId: "default",
      expiresAt: Date.now() + 60_000,
    });

    await handleApprovalCardCallback(
      { t: "approval", d: "allow-once", id: "exec:abc" },
      mockCfg,
      mockConfig,
    );

    expect(mockGatewayRequest).toHaveBeenCalledTimes(1);
    expect(approvalCardStore.get("exec:abc")).toBeUndefined();
    expect(axios.put).toHaveBeenCalledWith(
      expect.stringContaining("/v1.0/card/instances"),
      expect.objectContaining({
        outTrackId: "track-123",
        cardData: expect.objectContaining({
          cardParamMap: expect.objectContaining({ hasAction: "false" }),
        }),
      }),
      expect.anything(),
    );
  });

  it("retries on failure and succeeds on 3rd attempt", async () => {
    mockGatewayRequest
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({ ok: true });
    const { handleApprovalCardCallback } = await import("../../src/approval-card-service");

    await handleApprovalCardCallback(
      { t: "approval", d: "deny", id: "exec:retry-test" },
      mockCfg,
      mockConfig,
    );

    expect(mockGatewayRequest).toHaveBeenCalledTimes(3);
  });

  it("gives up after 5 failed attempts without updating card", async () => {
    mockGatewayRequest.mockRejectedValue(new Error("persistent failure"));
    const axios = (await import("axios")).default;
    vi.mocked(axios.put).mockReset();
    const { handleApprovalCardCallback } = await import("../../src/approval-card-service");

    await handleApprovalCardCallback(
      { t: "approval", d: "allow-once", id: "exec:fail-test" },
      mockCfg,
      mockConfig,
    );

    expect(mockGatewayRequest).toHaveBeenCalledTimes(5);
    expect(axios.put).not.toHaveBeenCalled();
  });
});

describe("handleApprovalCardCallback (no gateway client)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("warns and returns when gateway client unavailable", async () => {
    vi.doMock("openclaw/plugin-sdk/gateway-runtime", () => ({
      createOperatorApprovalsGatewayClient: vi.fn().mockRejectedValue(new Error("unavailable")),
    }));
    vi.doMock("../../src/auth", () => ({
      getAccessToken: vi.fn().mockResolvedValue("test-token"),
    }));
    vi.doMock("../../src/logger-context", () => ({
      getLogger: vi.fn().mockReturnValue({
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      }),
    }));
    vi.doMock("../../src/utils", () => ({ getProxyBypassOption: vi.fn().mockReturnValue({}) }));
    vi.doMock("axios");

    const { handleApprovalCardCallback } = await import("../../src/approval-card-service");
    const { prewarmGatewayClient } = await import("../../src/approval-card-service");

    // Trigger gateway init (will fail and cache null)
    prewarmGatewayClient({ channels: {} } as any);
    // Wait for async init to settle
    await new Promise((r) => setTimeout(r, 50));

    await handleApprovalCardCallback(
      { t: "approval", d: "deny", id: "exec:no-client" },
      { channels: {} } as any,
      { clientId: "test", clientSecret: "test" } as any,
    );
    // Should complete without throwing
  });
});
