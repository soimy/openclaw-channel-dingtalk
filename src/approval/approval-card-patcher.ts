import { updateCardVariables } from "../card-callback-service";
import { completeDeferredAICardFinalize } from "../card-service";
import { DINGTALK_CARD_TEMPLATE } from "../card/card-template";
import {
  buildApprovalClearedCardParams,
  buildApprovalPendingCardParams,
} from "./approval-card-state";
import {
  clearCardRunPendingApproval,
  markCardRunPendingApproval,
  resolveCardRun,
} from "../card/card-run-registry";
import type { CardBlock, DingTalkConfig } from "../types";

/**
 * Build the cardParamMap diff used by applyPendingPatch. The required keys
 * come from buildApprovalPendingCardParams (show_approve_btns / approveId /
 * hasAction). When the caller provides a cardBodyMarkdown we additionally
 * overwrite the card body so the user sees a friendly approval prompt rather
 * than the upstream tool-result text (e.g. "Approval required. Run: /approve
 * <id> allow-once …") that the agent reply pipeline streamed in.
 */
function buildPendingCardPutVariables(
  approvalId: string,
  cardBodyMarkdown?: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    ...buildApprovalPendingCardParams(approvalId),
  };
  if (cardBodyMarkdown) {
    const block: CardBlock = { type: 0, markdown: cardBodyMarkdown };
    params[DINGTALK_CARD_TEMPLATE.blockListKey] = JSON.stringify([block]);
    params[DINGTALK_CARD_TEMPLATE.streamingKey] = cardBodyMarkdown;
    params[DINGTALK_CARD_TEMPLATE.copyContentKey] = cardBodyMarkdown;
  }
  return params;
}

export async function applyPendingPatch(
  outTrackId: string,
  approvalId: string,
  token: string,
  config?: Pick<DingTalkConfig, "bypassProxyForSend">,
  cardBodyMarkdown?: string,
): Promise<void> {
  // Pre-mark the run so a concurrent commitAICardBlocks that fires while the
  // pending PUT is in flight defers the finalize (it keys the decision on
  // pendingApprovalId). On PUT failure we roll back the mark and, if commit
  // already deferred, rescue the card by terminalizing via applyExpiredPatch.
  markCardRunPendingApproval(outTrackId, approvalId);
  try {
    await updateCardVariables(
      outTrackId,
      buildPendingCardPutVariables(approvalId, cardBodyMarkdown),
      token,
      config,
    );
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
