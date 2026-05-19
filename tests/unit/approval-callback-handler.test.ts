import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/approval/approval-resolver", () => ({
  resolveApproval: vi.fn(),
}));
vi.mock("../../src/approval/approval-card-patcher", () => ({
  applyResolvedPatch: vi.fn().mockResolvedValue(undefined),
  applyExpiredPatch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/card/card-run-registry", () => ({
  resolveCardRun: vi.fn(),
  isActiveCardRun: vi.fn(() => true),
}));
vi.mock("../../src/send-service", () => ({
  sendProactiveTextOrMarkdown: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("tok-xxx"),
}));
vi.mock("../../src/config", () => ({
  getConfig: vi.fn(() => ({ clientId: "x", bypassProxyForSend: false })),
}));

const { tryHandleApprovalCallback } = await import("../../src/approval/approval-callback-handler");
const { resolveApproval } = await import("../../src/approval/approval-resolver");
const { applyExpiredPatch, applyResolvedPatch } = await import(
  "../../src/approval/approval-card-patcher"
);
const { resolveCardRun } = await import("../../src/card/card-run-registry");
const { sendProactiveTextOrMarkdown } = await import("../../src/send-service");
const { getAccessToken } = await import("../../src/auth");

const mockResolve = vi.mocked(resolveApproval);
const mockApplyResolved = vi.mocked(applyResolvedPatch);
const mockApplyExpired = vi.mocked(applyExpiredPatch);
const mockResolveCard = vi.mocked(resolveCardRun);
const mockSend = vi.mocked(sendProactiveTextOrMarkdown);
const mockGetAccessToken = vi.mocked(getAccessToken);

const base = { cfg: {} as never, accountId: "default", log: undefined };

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    summary: "allow-once",
    actionId: "allow-once",
    userId: "staffA",
    outTrackId: "ai_card_xxx",
    cardPrivateData: {
      actionIds: ["allow-once"],
      params: { action: "allow-once", approveId: "abc123" },
    },
    ...overrides,
  } as never;
}

describe("approval-callback-handler", () => {
  beforeEach(() => {
    mockResolve.mockReset().mockResolvedValue({ ok: true });
    mockApplyResolved.mockReset().mockResolvedValue(undefined);
    mockApplyExpired.mockReset().mockResolvedValue(undefined);
    mockResolveCard.mockReset().mockReturnValue({
      outTrackId: "ai_card_xxx",
      card: { state: "2" },
    } as never);
    mockSend.mockReset().mockResolvedValue({ ok: true } as never);
    mockGetAccessToken.mockReset().mockResolvedValue("tok-xxx");
  });

  it("ignores non approval callbacks", async () => {
    const result = await tryHandleApprovalCallback({
      ...base,
      analysis: analysis({ actionId: "feedback_up", cardPrivateData: undefined }),
    });

    expect(result.handled).toBe(false);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("resolves approval from params.action and params.approveId", async () => {
    await tryHandleApprovalCallback({ ...base, analysis: analysis() });

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "abc123",
        decision: "allow-once",
        senderId: "staffA",
      }),
    );
    expect(mockApplyResolved).toHaveBeenCalledWith(
      "ai_card_xxx",
      "allow-once",
      "tok-xxx",
      true,
      expect.objectContaining({ clientId: "x" }),
    );
  });

  it("falls back to registry pendingApprovalId when callback lacks approveId", async () => {
    mockResolveCard.mockReturnValue({ pendingApprovalId: "from-registry", card: { state: "2" } } as never);

    await tryHandleApprovalCallback({
      ...base,
      analysis: analysis({
        cardPrivateData: { actionIds: ["allow-once"], params: { action: "allow-once" } },
      }),
    });

    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "from-registry" }));
  });

  it("expires the card when approvalId cannot be resolved", async () => {
    mockResolveCard.mockReturnValue(null);

    const result = await tryHandleApprovalCallback({
      ...base,
      analysis: analysis({
        cardPrivateData: { actionIds: ["allow-once"], params: { action: "allow-once" } },
      }),
    });

    expect(result).toEqual({ handled: true, reason: "missing-approval-id" });
    expect(mockApplyExpired).toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("does not claim generic decision actionIds without an approval id", async () => {
    mockResolveCard.mockReturnValue(null);

    const result = await tryHandleApprovalCallback({
      ...base,
      analysis: analysis({
        cardPrivateData: { actionIds: ["deny"], params: {} },
      }),
    });

    expect(result).toEqual({ handled: false });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockApplyExpired).not.toHaveBeenCalled();
  });

  it("uses action id fallback for decision", async () => {
    await tryHandleApprovalCallback({
      ...base,
      analysis: analysis({ cardPrivateData: { actionIds: ["deny"], params: { approveId: "abc123" } } }),
    });

    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ decision: "deny" }));
  });

  it("keeps card pending and sends private hint for unauthorized users", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "unauthorized" });

    await tryHandleApprovalCallback({ ...base, analysis: analysis() });

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "user:staffA",
      expect.stringContaining("无权"),
      expect.objectContaining({ forceMarkdown: true }),
    );
    expect(mockApplyResolved).not.toHaveBeenCalled();
    expect(mockApplyExpired).not.toHaveBeenCalled();
  });

  it("keeps card pending and sends allowed decision hint for invalid decisions", async () => {
    mockResolve.mockResolvedValue({
      ok: false,
      reason: "invalid-decision",
      allowedDecisions: ["allow-once", "deny"],
    });

    await tryHandleApprovalCallback({ ...base, analysis: analysis() });

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "user:staffA",
      expect.stringMatching(/allow-once.*deny/),
      expect.objectContaining({ forceMarkdown: true }),
    );
    expect(mockApplyResolved).not.toHaveBeenCalled();
    expect(mockApplyExpired).not.toHaveBeenCalled();
  });

  it("does not send an invalid user target when callback userId is missing", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "unauthorized" });

    await tryHandleApprovalCallback({ ...base, analysis: analysis({ userId: undefined }) });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(["already-resolved", "not-found"] as const)(
    "expires the card for %s",
    async (reason) => {
      mockResolve.mockResolvedValue({ ok: false, reason });

      await tryHandleApprovalCallback({ ...base, analysis: analysis() });

      expect(mockApplyExpired).toHaveBeenCalled();
    },
  );

  it("keeps card pending and sends a private retry hint for gateway errors", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "gateway-error" });

    await tryHandleApprovalCallback({ ...base, analysis: analysis() });

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "user:staffA",
      expect.stringContaining("稍后重试"),
      expect.objectContaining({ forceMarkdown: true }),
    );
    expect(mockApplyResolved).not.toHaveBeenCalled();
    expect(mockApplyExpired).not.toHaveBeenCalled();
  });

  it("resolves upstream approval even when DingTalk token lookup fails", async () => {
    mockResolve.mockResolvedValue({ ok: true });
    mockGetAccessToken.mockRejectedValueOnce(new Error("token unavailable"));

    const result = await tryHandleApprovalCallback({ ...base, analysis: analysis() });

    expect(result).toEqual({ handled: true, reason: "resolved" });
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "abc123", decision: "allow-once" }),
    );
    expect(mockApplyResolved).not.toHaveBeenCalled();
  });
});
