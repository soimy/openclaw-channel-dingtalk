import { updateCardVariables } from "../card-callback-service";
import { completeDeferredAICardFinalize } from "../card-service";
import {
  buildApprovalClearedCardParams,
  buildApprovalPendingCardParams,
} from "./approval-card-state";
import {
  clearCardRunPendingApproval,
  markCardRunPendingApproval,
  resolveCardRun,
} from "../card/card-run-registry";
import type { DingTalkConfig } from "../types";

export async function applyPendingPatch(
  outTrackId: string,
  approvalId: string,
  token: string,
  config?: Pick<DingTalkConfig, "bypassProxyForSend">,
): Promise<void> {
  // Pre-mark the run so a concurrent commitAICardBlocks that fires while the
  // pending PUT is in flight defers the finalize (it keys the decision on
  // pendingApprovalId). On PUT failure we roll back the mark and, if commit
  // already deferred, rescue the card by terminalizing via applyExpiredPatch.
  markCardRunPendingApproval(outTrackId, approvalId);
  try {
    await updateCardVariables(outTrackId, buildApprovalPendingCardParams(approvalId), token, config);
  } catch (err) {
    clearCardRunPendingApproval(outTrackId);
    if (resolveCardRun(outTrackId)?.deferredFinalize) {
      await applyExpiredPatch(outTrackId, token, false, config);
    }
    throw err;
  }
}

/**
 * Build terminal-state cardParamMap for an approval that has resolved or
 * expired. When the run was deferred-finalize while the approval pended,
 * include flowStatus=3 so DingTalk completes the card in the same PUT.
 */
function buildTerminalPatchParams(
  outTrackId: string,
  cardStillActive: boolean,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    ...buildApprovalClearedCardParams(cardStillActive),
  };
  if (resolveCardRun(outTrackId)?.deferredFinalize) {
    params.flowStatus = 3;
  }
  return params;
}

export async function applyResolvedPatch(
  outTrackId: string,
  _decision: string,
  token: string,
  cardStillActive: boolean,
  config?: Pick<DingTalkConfig, "bypassProxyForSend">,
): Promise<void> {
  await updateCardVariables(
    outTrackId,
    buildTerminalPatchParams(outTrackId, cardStillActive),
    token,
    config,
  );
  clearCardRunPendingApproval(outTrackId);
  await completeDeferredAICardFinalize(outTrackId);
}

export async function applyExpiredPatch(
  outTrackId: string,
  token: string,
  cardStillActive: boolean,
  config?: Pick<DingTalkConfig, "bypassProxyForSend">,
): Promise<void> {
  await updateCardVariables(
    outTrackId,
    buildTerminalPatchParams(outTrackId, cardStillActive),
    token,
    config,
  );
  clearCardRunPendingApproval(outTrackId);
  await completeDeferredAICardFinalize(outTrackId);
}
