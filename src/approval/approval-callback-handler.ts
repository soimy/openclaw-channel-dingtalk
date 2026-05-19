import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getAccessToken } from "../auth";
import type { CardCallbackAnalysis } from "../card-callback-service";
import {
  isActiveCardRun,
  resolveCardRun,
} from "../card/card-run-registry";
import { getConfig } from "../config";
import { sendProactiveTextOrMarkdown } from "../send-service";
import type { ApprovalDecision, Logger } from "../types";
import { applyExpiredPatch, applyResolvedPatch } from "./approval-card-patcher";
import { resolveApproval } from "./approval-resolver";

const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ["allow-once", "allow-always", "deny"];

export interface HandleApprovalCallbackInput {
  cfg: OpenClawConfig;
  accountId: string;
  analysis: CardCallbackAnalysis;
  log?: Logger;
}

export interface HandleApprovalCallbackResult {
  handled: boolean;
  reason?: string;
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return typeof value === "string" && (APPROVAL_DECISIONS as readonly string[]).includes(value);
}

function parseDecision(analysis: CardCallbackAnalysis): ApprovalDecision | null {
  const fromParams = analysis.cardPrivateData?.params?.action;
  if (isApprovalDecision(fromParams)) {
    return fromParams;
  }
  const [firstActionId] = analysis.cardPrivateData?.actionIds ?? [];
  if (isApprovalDecision(firstActionId)) {
    return firstActionId;
  }
  if (isApprovalDecision(analysis.actionId)) {
    return analysis.actionId;
  }
  return null;
}

function resolveApprovalId(analysis: CardCallbackAnalysis): string | null {
  const fromParams = analysis.cardPrivateData?.params?.approveId;
  if (typeof fromParams === "string" && fromParams.trim()) {
    return fromParams.trim();
  }
  if (!analysis.outTrackId) {
    return null;
  }
  return resolveCardRun(analysis.outTrackId)?.pendingApprovalId ?? null;
}

async function sendPrivateHint(params: {
  cfg: OpenClawConfig;
  accountId: string;
  userId?: string;
  text: string;
  log?: Logger;
}): Promise<void> {
  const userId = params.userId?.trim();
  if (!userId) {
    params.log?.warn?.("[DingTalk][Approval] Skip private hint because callback userId is missing");
    return;
  }
  await sendProactiveTextOrMarkdown(
    getConfig(params.cfg, params.accountId),
    `user:${userId}`,
    params.text,
    { forceMarkdown: true, accountId: params.accountId, log: params.log },
  ).catch((error) => {
    params.log?.warn?.(
      `[DingTalk][Approval] Failed to send private hint user=${userId}: ${String(error)}`,
    );
  });
}

export async function tryHandleApprovalCallback(
  input: HandleApprovalCallbackInput,
): Promise<HandleApprovalCallbackResult> {
  const decision = parseDecision(input.analysis);
  if (!decision || !input.analysis.outTrackId) {
    return { handled: false };
  }

  const dtConfig = getConfig(input.cfg, input.accountId);
  const token = await getAccessToken(dtConfig, input.log);
  const run = resolveCardRun(input.analysis.outTrackId);
  const cardStillActive = run ? isActiveCardRun(run) : false;
  const approvalId = resolveApprovalId(input.analysis);

  if (!approvalId) {
    await applyExpiredPatch(input.analysis.outTrackId, token, cardStillActive, dtConfig).catch((error) => {
      input.log?.warn?.(`[DingTalk][Approval] Failed to expire callback without approvalId: ${String(error)}`);
    });
    return { handled: true, reason: "missing-approval-id" };
  }

  const result = await resolveApproval({
    cfg: input.cfg,
    accountId: input.accountId,
    approvalId,
    decision,
    senderId: input.analysis.userId ?? "",
    log: input.log,
  });

  if (result.ok) {
    await applyResolvedPatch(
      input.analysis.outTrackId,
      decision,
      token,
      cardStillActive,
      dtConfig,
    ).catch((error) => {
      input.log?.warn?.(`[DingTalk][Approval] Failed to patch resolved card: ${String(error)}`);
    });
    return { handled: true, reason: "resolved" };
  }

  if (result.reason === "unauthorized") {
    await sendPrivateHint({
      cfg: input.cfg,
      accountId: input.accountId,
      userId: input.analysis.userId,
      text: `⛔ 你不在 approver 名单，无权批准此请求（${approvalId}）。`,
      log: input.log,
    });
    return { handled: true, reason: result.reason };
  }

  if (result.reason === "invalid-decision") {
    const hint = result.allowedDecisions?.length
      ? `请选择：${result.allowedDecisions.join(" / ")}`
      : "请选择允许一次或拒绝";
    await sendPrivateHint({
      cfg: input.cfg,
      accountId: input.accountId,
      userId: input.analysis.userId,
      text: `ℹ️ 该审批不支持 ${decision}。${hint}（${approvalId}）。`,
      log: input.log,
    });
    return { handled: true, reason: result.reason };
  }

  await applyExpiredPatch(input.analysis.outTrackId, token, cardStillActive, dtConfig).catch((error) => {
    input.log?.warn?.(`[DingTalk][Approval] Failed to patch expired card: ${String(error)}`);
  });
  return { handled: true, reason: result.reason };
}
