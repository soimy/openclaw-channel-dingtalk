import type { ApprovalDecision } from "../types";

export const APPROVE_COMMAND_RE = /^\/?approve(?:\s|$)/i;

const DECISION_ALIASES: Record<string, ApprovalDecision> = {
  allow: "allow-once",
  once: "allow-once",
  "allow-once": "allow-once",
  allowonce: "allow-once",
  always: "allow-always",
  "allow-always": "allow-always",
  allowalways: "allow-always",
  deny: "deny",
  reject: "deny",
  block: "deny",
};

export interface ParsedApproveCommand {
  approvalId: string;
  decision: ApprovalDecision;
}

export function parseApproveCommand(text: string): ParsedApproveCommand | null {
  const trimmed = text.trim();
  if (!APPROVE_COMMAND_RE.test(trimmed)) {
    return null;
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 3) {
    return null;
  }

  const [, first, second] = tokens;
  const firstDecision = DECISION_ALIASES[first.toLowerCase()];
  const secondDecision = DECISION_ALIASES[second.toLowerCase()];

  if (firstDecision && !secondDecision) {
    return { approvalId: second, decision: firstDecision };
  }
  if (secondDecision && !firstDecision) {
    return { approvalId: first, decision: secondDecision };
  }
  return null;
}
