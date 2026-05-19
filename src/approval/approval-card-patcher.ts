import type { DingTalkConfig } from "../types";
import { updateCardVariables } from "../card-callback-service";
import {
  buildApprovalClearedCardParams,
  buildApprovalPendingCardParams,
} from "./approval-card-state";
import {
  clearCardRunPendingApproval,
  markCardRunPendingApproval,
} from "../card/card-run-registry";

export async function applyPendingPatch(
  outTrackId: string,
  approvalId: string,
  token: string,
  config?: Pick<DingTalkConfig, "bypassProxyForSend">,
): Promise<void> {
  await updateCardVariables(outTrackId, buildApprovalPendingCardParams(approvalId), token, config);
  markCardRunPendingApproval(outTrackId, approvalId);
}

export async function applyResolvedPatch(
  outTrackId: string,
  _decision: string,
  token: string,
  cardStillActive: boolean,
  config?: Pick<DingTalkConfig, "bypassProxyForSend">,
): Promise<void> {
  await updateCardVariables(outTrackId, buildApprovalClearedCardParams(cardStillActive), token, config);
  clearCardRunPendingApproval(outTrackId);
}

export async function applyExpiredPatch(
  outTrackId: string,
  token: string,
  cardStillActive: boolean,
  config?: Pick<DingTalkConfig, "bypassProxyForSend">,
): Promise<void> {
  await updateCardVariables(outTrackId, buildApprovalClearedCardParams(cardStillActive), token, config);
  clearCardRunPendingApproval(outTrackId);
}
