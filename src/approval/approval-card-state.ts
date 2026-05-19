export const APPROVAL_CARD_KEYS = {
  showApproveBtns: "show_approve_btns",
  approveId: "approveId",
  hasAction: "hasAction",
} as const;

export type ApprovalCardParams = {
  [APPROVAL_CARD_KEYS.showApproveBtns]: "true" | "false";
  [APPROVAL_CARD_KEYS.approveId]: string;
  [APPROVAL_CARD_KEYS.hasAction]: "true" | "false";
};

export const APPROVAL_CARD_INITIAL: {
  show_approve_btns: "false";
  approveId: "";
} = {
  show_approve_btns: "false",
  approveId: "",
};

export function buildApprovalPendingCardParams(approvalId: string): ApprovalCardParams {
  return {
    show_approve_btns: "true",
    approveId: approvalId,
    hasAction: "false",
  };
}

export function buildApprovalClearedCardParams(cardStillActive: boolean): ApprovalCardParams {
  return {
    show_approve_btns: "false",
    approveId: "",
    hasAction: cardStillActive ? "true" : "false",
  };
}
