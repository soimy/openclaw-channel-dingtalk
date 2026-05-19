import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/card-callback-service", () => ({
  updateCardVariables: vi.fn().mockResolvedValue(200),
}));

vi.mock("../../src/card/card-run-registry", () => ({
  markCardRunPendingApproval: vi.fn(),
  clearCardRunPendingApproval: vi.fn(),
}));

const { applyExpiredPatch, applyPendingPatch, applyResolvedPatch } = await import(
  "../../src/approval/approval-card-patcher"
);
const { updateCardVariables } = await import("../../src/card-callback-service");
const { clearCardRunPendingApproval, markCardRunPendingApproval } = await import(
  "../../src/card/card-run-registry"
);

const mockUpdate = vi.mocked(updateCardVariables);
const mockMark = vi.mocked(markCardRunPendingApproval);
const mockClear = vi.mocked(clearCardRunPendingApproval);

describe("approval-card-patcher", () => {
  beforeEach(() => {
    mockUpdate.mockReset().mockResolvedValue(200);
    mockMark.mockReset();
    mockClear.mockReset();
  });

  it("applies pending card variables and records fallback approval id", async () => {
    await applyPendingPatch("ot1", "abc123", "tok", { bypassProxyForSend: true });

    expect(mockUpdate).toHaveBeenCalledWith(
      "ot1",
      { show_approve_btns: "true", approveId: "abc123", hasAction: "false" },
      "tok",
      { bypassProxyForSend: true },
    );
    expect(mockMark).toHaveBeenCalledWith("ot1", "abc123");
  });

  it("applies resolved variables and clears fallback approval id", async () => {
    await applyResolvedPatch("ot1", "allow-once", "tok", true, {});

    expect(mockUpdate).toHaveBeenCalledWith(
      "ot1",
      { show_approve_btns: "false", approveId: "", hasAction: "true" },
      "tok",
      {},
    );
    expect(mockClear).toHaveBeenCalledWith("ot1");
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

  it("applies expired variables using the same cleared field set", async () => {
    await applyExpiredPatch("ot1", "tok", false, {});

    expect(mockUpdate).toHaveBeenCalledWith(
      "ot1",
      { show_approve_btns: "false", approveId: "", hasAction: "false" },
      "tok",
      {},
    );
    expect(mockClear).toHaveBeenCalledWith("ot1");
  });
});
