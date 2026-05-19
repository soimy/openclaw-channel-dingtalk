import { beforeEach, describe, expect, it, vi } from "vitest";
import { tryInterceptApproveCommand } from "../../src/approval/approval-command-intercept";

vi.mock("../../src/approval/approval-resolver", () => ({
  resolveApproval: vi.fn(),
}));

vi.mock("../../src/send-service", () => ({
  sendProactiveTextOrMarkdown: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../src/config", () => ({
  getConfig: vi.fn(() => ({ clientId: "x", clientSecret: "y" })),
}));

const { resolveApproval } = await import("../../src/approval/approval-resolver");
const { sendProactiveTextOrMarkdown } = await import("../../src/send-service");
const mockResolveApproval = vi.mocked(resolveApproval);
const mockSend = vi.mocked(sendProactiveTextOrMarkdown);

const base = {
  cfg: {} as never,
  accountId: "default",
  senderId: "staffA",
  log: undefined,
};

describe("tryInterceptApproveCommand", () => {
  beforeEach(() => {
    mockResolveApproval.mockReset();
    mockSend.mockReset().mockResolvedValue({ ok: true });
  });

  it("returns false for non-approve commands", async () => {
    await expect(tryInterceptApproveCommand({ ...base, text: "hello" })).resolves.toBe(false);
    expect(mockResolveApproval).not.toHaveBeenCalled();
  });

  it("returns true and sends a DM for malformed approve commands", async () => {
    await expect(tryInterceptApproveCommand({ ...base, text: "/approve abc xyz" })).resolves.toBe(
      true,
    );

    expect(mockResolveApproval).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "user:staffA",
      expect.stringContaining("格式错误"),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });

  it("calls the resolver and does not DM on success", async () => {
    mockResolveApproval.mockResolvedValue({ ok: true });

    await expect(
      tryInterceptApproveCommand({ ...base, text: "/approve abc allow-once" }),
    ).resolves.toBe(true);

    expect(mockResolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "abc",
        decision: "allow-once",
        senderId: "staffA",
      }),
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends an unauthorized DM with the approval id", async () => {
    mockResolveApproval.mockResolvedValue({ ok: false, reason: "unauthorized" });

    await tryInterceptApproveCommand({ ...base, text: "/approve abc deny" });

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "user:staffA",
      expect.stringMatching(/无权.*abc/),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });

  it("sends invalid-decision DM with allowed decisions when available", async () => {
    mockResolveApproval.mockResolvedValue({
      ok: false,
      reason: "invalid-decision",
      allowedDecisions: ["allow-once", "deny"],
    });

    await tryInterceptApproveCommand({ ...base, text: "/approve abc allow-always" });

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "user:staffA",
      expect.stringMatching(/不支持.*allow-once.*deny/),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });

  it("sends default invalid-decision DM without allowed decisions", async () => {
    mockResolveApproval.mockResolvedValue({ ok: false, reason: "invalid-decision" });

    await tryInterceptApproveCommand({ ...base, text: "/approve abc allow-always" });

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "user:staffA",
      expect.stringContaining("允许一次或拒绝"),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });

  it("sends a light DM for not-found and already-resolved", async () => {
    mockResolveApproval.mockResolvedValueOnce({ ok: false, reason: "not-found" });
    await tryInterceptApproveCommand({ ...base, text: "/approve abc deny" });
    mockResolveApproval.mockResolvedValueOnce({ ok: false, reason: "already-resolved" });
    await tryInterceptApproveCommand({ ...base, text: "/approve def deny" });

    expect(mockSend).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "user:staffA",
      expect.stringContaining("已处理或已过期"),
      expect.objectContaining({ forceMarkdown: true }),
    );
    expect(mockSend).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "user:staffA",
      expect.stringContaining("已处理或已过期"),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });

  it("does not DM for gateway errors", async () => {
    mockResolveApproval.mockResolvedValue({ ok: false, reason: "gateway-error" });

    await tryInterceptApproveCommand({ ...base, text: "/approve abc deny" });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not throw when sending a DM fails", async () => {
    mockResolveApproval.mockResolvedValue({ ok: false, reason: "unauthorized" });
    mockSend.mockRejectedValueOnce(new Error("network"));

    await expect(tryInterceptApproveCommand({ ...base, text: "/approve abc deny" })).resolves.toBe(
      true,
    );
  });
});
