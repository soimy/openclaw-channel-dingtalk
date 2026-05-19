import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ApprovalDecision, Logger } from "../types";
import { isExecAuthorizedSender, isPluginAuthorizedSender } from "./approval-config";

export type ResolverReason =
  | "unauthorized"
  | "already-resolved"
  | "not-found"
  | "invalid-decision"
  | "gateway-error";

export type ResolverResult =
  | { ok: true }
  | {
      ok: false;
      reason: ResolverReason;
      error?: unknown;
      allowedDecisions?: string[];
    };

export interface ResolveApprovalInput {
  cfg: OpenClawConfig;
  accountId: string;
  approvalId: string;
  decision: ApprovalDecision;
  senderId: string;
  log?: Logger;
}

type GatewayErrorLike = {
  gatewayCode?: unknown;
  details?: {
    reason?: unknown;
    allowedDecisions?: unknown;
  };
};

export function isInvalidApprovalDecisionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as GatewayErrorLike;
  if (candidate.gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  const details = candidate.details;
  if (!details || typeof details !== "object") {
    return false;
  }
  return (
    details.reason === "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE" ||
    Array.isArray(details.allowedDecisions)
  );
}

function extractAllowedDecisions(error: unknown): string[] | undefined {
  const details = (error as GatewayErrorLike | null)?.details;
  if (!Array.isArray(details?.allowedDecisions)) {
    return undefined;
  }
  return details.allowedDecisions.filter((entry): entry is string => typeof entry === "string");
}

function deriveGatewayParams(params: {
  approvalId: string;
  execAuthorized: boolean;
  pluginAuthorized: boolean;
}):
  | { resolveMethod?: "plugin"; allowPluginFallback?: boolean }
  | null {
  if (!params.execAuthorized && !params.pluginAuthorized) {
    return null;
  }
  if (params.approvalId.startsWith("plugin:")) {
    return { resolveMethod: "plugin" };
  }
  if (params.execAuthorized && params.pluginAuthorized) {
    return { allowPluginFallback: true };
  }
  // Reserved for v2 if plugin approvers diverge from exec approvers.
  // In v1, isPluginAuthorizedSender intentionally aliases isExecAuthorizedSender.
  if (params.pluginAuthorized) {
    return { resolveMethod: "plugin" };
  }
  return { allowPluginFallback: false };
}

export async function resolveApproval(input: ResolveApprovalInput): Promise<ResolverResult> {
  const execAuthorized = isExecAuthorizedSender(input);
  const pluginAuthorized = isPluginAuthorizedSender(input);
  const gatewayParams = deriveGatewayParams({
    approvalId: input.approvalId,
    execAuthorized,
    pluginAuthorized,
  });

  if (!gatewayParams) {
    input.log?.info?.(
      `[DingTalk][Approval] unauthorized sender=${input.senderId} approvalId=${input.approvalId}`,
    );
    return { ok: false, reason: "unauthorized" };
  }

  try {
    await resolveApprovalOverGateway({
      cfg: input.cfg,
      approvalId: input.approvalId,
      decision: input.decision,
      senderId: input.senderId,
      clientDisplayName: "DingTalk",
      ...gatewayParams,
    });
    return { ok: true };
  } catch (error) {
    const gatewayCode = (error as GatewayErrorLike | null)?.gatewayCode;
    if (gatewayCode === "APPROVAL_NOT_FOUND") {
      return { ok: false, reason: "not-found", error };
    }
    if (gatewayCode === "APPROVAL_ALREADY_RESOLVED") {
      return { ok: false, reason: "already-resolved", error };
    }
    if (isInvalidApprovalDecisionError(error)) {
      return {
        ok: false,
        reason: "invalid-decision",
        error,
        allowedDecisions: extractAllowedDecisions(error),
      };
    }

    input.log?.warn?.(
      `[DingTalk][Approval] gateway-error approvalId=${input.approvalId} err=${String(
        (error as Error | null)?.message ?? error,
      )}`,
    );
    return { ok: false, reason: "gateway-error", error };
  }
}
