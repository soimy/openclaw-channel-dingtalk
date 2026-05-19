import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveActiveCardRunBySession } from "../card/card-run-registry";
import { getLogger } from "../logger-context";

export interface FindActiveAgentCardInput {
  cfg: OpenClawConfig;
  accountId: string;
  sessionKey: string;
  approvalId?: string;
}

export interface ActiveAgentCardLocation {
  outTrackId: string;
  sessionKey: string;
}

export function findActiveAgentCard(input: FindActiveAgentCardInput): ActiveAgentCardLocation | null {
  if (!input.sessionKey) {
    return null;
  }
  const record = resolveActiveCardRunBySession(input.accountId, input.sessionKey);
  if (!record) {
    return null;
  }
  if (record.pendingApprovalId && record.pendingApprovalId !== input.approvalId) {
    getLogger(input.accountId)?.debug?.(
      `[DingTalk][Approval] active card outTrackId=${record.outTrackId} already pending approvalId=${record.pendingApprovalId}; falling back to markdown for approvalId=${input.approvalId ?? ""}`,
    );
    return null;
  }
  return { outTrackId: record.outTrackId, sessionKey: record.sessionKey };
}
