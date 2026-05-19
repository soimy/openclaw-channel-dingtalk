import { describe, expect, it } from "vitest";
import {
  APPROVAL_CARD_INITIAL,
  APPROVAL_CARD_KEYS,
  buildApprovalClearedCardParams,
  buildApprovalPendingCardParams,
} from "../../src/approval/approval-card-state";

describe("approval-card-state", () => {
  it("centralizes the DingTalk cardParamMap key names", () => {
    expect(APPROVAL_CARD_KEYS).toEqual({
      showApproveBtns: "show_approve_btns",
      approveId: "approveId",
      hasAction: "hasAction",
    });
  });

  it("builds pending approval card variables", () => {
    expect(buildApprovalPendingCardParams("abc123")).toEqual({
      show_approve_btns: "true",
      approveId: "abc123",
      hasAction: "false",
    });
  });

  it("builds cleared variables and restores stop action for active cards", () => {
    expect(buildApprovalClearedCardParams(true)).toEqual({
      show_approve_btns: "false",
      approveId: "",
      hasAction: "true",
    });
  });

  it("builds cleared variables without restoring stop action for inactive cards", () => {
    expect(buildApprovalClearedCardParams(false)).toEqual({
      show_approve_btns: "false",
      approveId: "",
      hasAction: "false",
    });
  });

  it("does not include final-state presentation fields in v1", () => {
    const params = buildApprovalClearedCardParams(true);
    expect(params).not.toHaveProperty("status");
    expect(params).not.toHaveProperty("statusFooter");
    expect(params).not.toHaveProperty("approval_status");
  });

  it("exports initial approval defaults for regular AI cards", () => {
    expect(APPROVAL_CARD_INITIAL).toEqual({
      show_approve_btns: "false",
      approveId: "",
    });
  });
});
