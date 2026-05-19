import { updateCardVariables } from "../card-callback-service";
import {
  buildApprovalClearedCardParams,
  buildApprovalPendingCardParams,
} from "./approval-card-state";
import {
  clearCardRunDeferredFinalize,
  clearCardRunPendingApproval,
  markCardRunPendingApproval,
  resolveCardRun,
} from "../card/card-run-registry";
import { AICardStatus, type DingTalkConfig } from "../types";

export async function applyPendingPatch(
  outTrackId: string,
  approvalId: string,
  token: string,
  config?: Pick<DingTalkConfig, "bypassProxyForSend">,
): Promise<void> {
  await updateCardVariables(outTrackId, buildApprovalPendingCardParams(approvalId), token, config);
  markCardRunPendingApproval(outTrackId, approvalId);
}

/**
 * Resolve or expire an approval that lives on a DingTalk AI card. If the card
 * was deferred-finalized (commitAICardBlocks skipped flowStatus=3 while the
 * approval was pending), include flowStatus=3 in the PUT so the card finishes
 * now that the buttons no longer need to render.
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

function completeDeferredFinalize(outTrackId: string): void {
  const record = resolveCardRun(outTrackId);
  if (record?.deferredFinalize && record.card) {
    record.card.state = AICardStatus.FINISHED;
    record.card.lastUpdated = Date.now();
  }
  clearCardRunDeferredFinalize(outTrackId);
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
  completeDeferredFinalize(outTrackId);
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
  completeDeferredFinalize(outTrackId);
}
