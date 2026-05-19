import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/card-callback-service", () => ({
  updateCardVariables: vi.fn().mockResolvedValue(200),
}));

vi.mock("../../src/card-service", () => ({
  completeDeferredAICardFinalize: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/card/card-run-registry", () => ({
  markCardRunPendingApproval: vi.fn(),
  clearCardRunPendingApproval: vi.fn(),
  resolveCardRun: vi.fn(),
}));

const { applyExpiredPatch, applyPendingPatch, applyResolvedPatch } = await import(
  "../../src/approval/approval-card-patcher"
);
const { updateCardVariables } = await import("../../src/card-callback-service");
const { completeDeferredAICardFinalize } = await import("../../src/card-service");
const {
  clearCardRunPendingApproval,
  markCardRunPendingApproval,
  resolveCardRun,
} = await import("../../src/card/card-run-registry");

const mockUpdate = vi.mocked(updateCardVariables);
const mockComplete = vi.mocked(completeDeferredAICardFinalize);
const mockMark = vi.mocked(markCardRunPendingApproval);
const mockClear = vi.mocked(clearCardRunPendingApproval);
const mockResolveRun = vi.mocked(resolveCardRun);

describe("approval-card-patcher", () => {
  beforeEach(() => {
    mockUpdate.mockReset().mockResolvedValue(200);
    mockComplete.mockReset().mockResolvedValue(undefined);
    mockMark.mockReset();
    mockClear.mockReset();
    mockResolveRun.mockReset().mockReturnValue(null);
  });

  it("pre-marks the run pending before issuing the PUT (CR-2 race fix)", async () => {
    const callOrder: string[] = [];
    mockMark.mockImplementation(() => {
      callOrder.push("mark");
    });
    mockUpdate.mockImplementation(async () => {
      callOrder.push("put");
      return 200;
    });

    await applyPendingPatch("ot1", "abc123", "tok", { bypassProxyForSend: true });

    expect(callOrder).toEqual(["mark", "put"]);
    expect(mockMark).toHaveBeenCalledWith("ot1", "abc123");
    expect(mockUpdate).toHaveBeenCalledWith(
      "ot1",
      { show_approve_btns: "true", approveId: "abc123", hasAction: "false" },
      "tok",
      { bypassProxyForSend: true },
    );
  });

  it("rolls back pending mark when the PUT fails", async () => {
    mockUpdate.mockRejectedValueOnce(new Error("network down"));

    await expect(applyPendingPatch("ot1", "abc123", "tok", {})).rejects.toThrow("network down");

    expect(mockMark).toHaveBeenCalledWith("ot1", "abc123");
    expect(mockClear).toHaveBeenCalledWith("ot1");
  });

  it("rescues a deferred-finalize card when the pending PUT fails after commit deferred", async () => {
    // Simulate the race: commit deferred while our PUT was in flight.
    mockResolveRun.mockReturnValue({
      outTrackId: "ot1",
      accountId: "default",
      sessionKey: "session:abc",
      agentId: "main",
      registeredAt: Date.now(),
      deferredFinalize: true,
    });
    mockUpdate.mockRejectedValueOnce(new Error("network down"));

    await expect(applyPendingPatch("ot1", "abc123", "tok", {})).rejects.toThrow("network down");

    // Rollback ran, and the rescue terminal PUT fired (the second updateCardVariables call).
    expect(mockClear).toHaveBeenCalledWith("ot1");
    expect(mockUpdate).toHaveBeenCalledWith(
      "ot1",
      { show_approve_btns: "false", approveId: "", hasAction: "false", flowStatus: 3 },
      "tok",
      {},
    );
    expect(mockComplete).toHaveBeenCalledWith("ot1");
  });

  it("applies resolved variables and delegates terminal completion", async () => {
    await applyResolvedPatch("ot1", "allow-once", "tok", true, {});

    expect(mockUpdate).toHaveBeenCalledWith(
      "ot1",
      { show_approve_btns: "false", approveId: "", hasAction: "true" },
      "tok",
      {},
    );
    expect(mockClear).toHaveBeenCalledWith("ot1");
    expect(mockComplete).toHaveBeenCalledWith("ot1");
  });

  it("does not restore stop action for inactive resolved cards", async () => {
    await applyResolvedPatch("ot1", "deny", "tok", false, {});

    expect(mockUpdate).toHaveBeenCalledWith(
      "ot1",
      { show_approve_btns: "false", approveId: "", hasAction: "false" },
      "tok",
      {},
    );
  });

  it("includes flowStatus=3 on resolve when the card was deferred-finalize", async () => {
    mockResolveRun.mockReturnValue({
      outTrackId: "ot1",
      accountId: "default",
      sessionKey: "session:abc",
      agentId: "main",
      registeredAt: Date.now(),
      deferredFinalize: true,
    });

    await applyResolvedPatch("ot1", "allow-once", "tok", true, {});

    expect(mockUpdate).toHaveBeenCalledWith(
      "ot1",
      { show_approve_btns: "false", approveId: "", hasAction: "true", flowStatus: 3 },
      "tok",
      {},
    );
    expect(mockComplete).toHaveBeenCalledWith("ot1");
  });

  it("applies expired variables and delegates terminal completion", async () => {
    await applyExpiredPatch("ot1", "tok", false, {});

    expect(mockUpdate).toHaveBeenCalledWith(
      "ot1",
      { show_approve_btns: "false", approveId: "", hasAction: "false" },
      "tok",
      {},
    );
    expect(mockClear).toHaveBeenCalledWith("ot1");
    expect(mockComplete).toHaveBeenCalledWith("ot1");
  });
});
