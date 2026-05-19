import { beforeEach, describe, expect, it, vi } from "vitest";
import { isInvalidApprovalDecisionError, resolveApproval } from "../../src/approval/approval-resolver";

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: vi.fn(),
}));

vi.mock("../../src/approval/approval-config", () => ({
  isExecAuthorizedSender: vi.fn(() => true),
  isPluginAuthorizedSender: vi.fn(() => true),
}));

const { resolveApprovalOverGateway } = await import(
  "openclaw/plugin-sdk/approval-gateway-runtime"
);
const { isExecAuthorizedSender, isPluginAuthorizedSender } = await import(
  "../../src/approval/approval-config"
);

const mockGateway = vi.mocked(resolveApprovalOverGateway);
const mockExecAuth = vi.mocked(isExecAuthorizedSender);
const mockPluginAuth = vi.mocked(isPluginAuthorizedSender);

const base = {
  cfg: {} as never,
  accountId: "default",
  senderId: "staffA",
  log: undefined,
};

describe("approval-resolver · method derivation", () => {
  beforeEach(() => {
    mockGateway.mockReset();
    mockExecAuth.mockReset().mockReturnValue(true);
    mockPluginAuth.mockReset().mockReturnValue(true);
  });

  it("uses plugin resolveMethod for plugin-prefixed approval IDs", async () => {
    mockGateway.mockResolvedValue(undefined);

    await resolveApproval({ ...base, approvalId: "plugin:xyz", decision: "allow-once" });

    expect(mockGateway).toHaveBeenCalledWith(expect.objectContaining({ resolveMethod: "plugin" }));
  });

  it("omits resolveMethod for exec and enables plugin fallback when both auth checks pass", async () => {
    mockGateway.mockResolvedValue(undefined);

    await resolveApproval({ ...base, approvalId: "abc", decision: "allow-once" });

    expect(mockGateway).toHaveBeenCalledWith(
      expect.objectContaining({ allowPluginFallback: true }),
    );
    expect(mockGateway.mock.calls[0][0]).not.toHaveProperty("resolveMethod");
  });

  it("uses plugin when only plugin authorization passes", async () => {
    mockGateway.mockResolvedValue(undefined);
    mockExecAuth.mockReturnValue(false);
    mockPluginAuth.mockReturnValue(true);

    await resolveApproval({ ...base, approvalId: "abc", decision: "allow-once" });

    expect(mockGateway).toHaveBeenCalledWith(expect.objectContaining({ resolveMethod: "plugin" }));
  });

  it("uses exec without plugin fallback when only exec authorization passes", async () => {
    mockGateway.mockResolvedValue(undefined);
    mockExecAuth.mockReturnValue(true);
    mockPluginAuth.mockReturnValue(false);

    await resolveApproval({ ...base, approvalId: "abc", decision: "allow-once" });

    expect(mockGateway).toHaveBeenCalledWith(
      expect.objectContaining({ allowPluginFallback: false }),
    );
    expect(mockGateway.mock.calls[0][0]).not.toHaveProperty("resolveMethod");
  });

  it("returns unauthorized and skips the gateway when neither auth check passes", async () => {
    mockExecAuth.mockReturnValue(false);
    mockPluginAuth.mockReturnValue(false);

    const result = await resolveApproval({ ...base, approvalId: "abc", decision: "allow-once" });

    expect(result).toEqual({ ok: false, reason: "unauthorized" });
    expect(mockGateway).not.toHaveBeenCalled();
  });
});

describe("approval-resolver · error classification", () => {
  beforeEach(() => {
    mockGateway.mockReset();
    mockExecAuth.mockReset().mockReturnValue(true);
    mockPluginAuth.mockReset().mockReturnValue(true);
  });

  it("maps APPROVAL_NOT_FOUND to not-found", async () => {
    mockGateway.mockRejectedValue(
      Object.assign(new Error("not found"), { gatewayCode: "APPROVAL_NOT_FOUND" }),
    );

    const result = await resolveApproval({ ...base, approvalId: "abc", decision: "deny" });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "not-found" }));
  });

  it("maps APPROVAL_ALREADY_RESOLVED to already-resolved", async () => {
    mockGateway.mockRejectedValue(
      Object.assign(new Error("already"), { gatewayCode: "APPROVAL_ALREADY_RESOLVED" }),
    );

    const result = await resolveApproval({ ...base, approvalId: "abc", decision: "deny" });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "already-resolved" }));
  });

  it("maps exec allow-always unavailability to invalid-decision", async () => {
    mockGateway.mockRejectedValue(
      Object.assign(new Error("invalid"), {
        gatewayCode: "INVALID_REQUEST",
        details: { reason: "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE" },
      }),
    );

    const result = await resolveApproval({
      ...base,
      approvalId: "abc",
      decision: "allow-always",
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "invalid-decision" }));
  });

  it("maps plugin allowedDecisions errors to invalid-decision and preserves decisions", async () => {
    mockGateway.mockRejectedValue(
      Object.assign(new Error("invalid"), {
        gatewayCode: "INVALID_REQUEST",
        details: { allowedDecisions: ["allow-once", "deny"] },
      }),
    );

    const result = await resolveApproval({
      ...base,
      approvalId: "plugin:p",
      decision: "allow-always",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "invalid-decision",
        allowedDecisions: ["allow-once", "deny"],
      }),
    );
  });

  it("maps other INVALID_REQUEST errors to gateway-error", async () => {
    mockGateway.mockRejectedValue(
      Object.assign(new Error("misc"), {
        gatewayCode: "INVALID_REQUEST",
        details: { other: true },
      }),
    );

    const result = await resolveApproval({ ...base, approvalId: "abc", decision: "deny" });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "gateway-error" }));
  });

  it("maps arbitrary errors to gateway-error", async () => {
    mockGateway.mockRejectedValue(new Error("network down"));

    const result = await resolveApproval({ ...base, approvalId: "abc", decision: "deny" });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "gateway-error" }));
  });

  it("returns ok=true when the gateway resolves", async () => {
    mockGateway.mockResolvedValue(undefined);

    const result = await resolveApproval({ ...base, approvalId: "abc", decision: "allow-once" });

    expect(result).toEqual({ ok: true });
  });
});

describe("isInvalidApprovalDecisionError", () => {
  it("recognizes exec invalid-decision shape", () => {
    expect(
      isInvalidApprovalDecisionError({
        gatewayCode: "INVALID_REQUEST",
        details: { reason: "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE" },
      }),
    ).toBe(true);
  });

  it("recognizes plugin invalid-decision shape", () => {
    expect(
      isInvalidApprovalDecisionError({
        gatewayCode: "INVALID_REQUEST",
        details: { allowedDecisions: ["allow-once"] },
      }),
    ).toBe(true);
  });

  it("does not recognize INVALID_REQUEST without relevant details", () => {
    expect(isInvalidApprovalDecisionError({ gatewayCode: "INVALID_REQUEST" })).toBe(false);
  });

  it("does not recognize non-INVALID_REQUEST errors", () => {
    expect(isInvalidApprovalDecisionError({ gatewayCode: "NETWORK_ERROR" })).toBe(false);
  });
});
