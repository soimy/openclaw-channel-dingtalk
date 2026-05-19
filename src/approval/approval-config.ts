import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getConfig } from "../config";

const DINGTALK_PREFIX_RE = /^(dingtalk|dd|ding):/i;

export interface ApprovalConfigQuery {
  cfg: OpenClawConfig;
  accountId: string;
}

export interface ResolvedExecApprovalsConfig {
  enabled: boolean | "auto" | undefined;
  approvers: string[];
  isNativeDeliveryEnabled: boolean;
}

function normalizeStaffId(raw: string): string {
  return raw.replace(DINGTALK_PREFIX_RE, "").trim();
}

export function listExecApprovers({ cfg, accountId }: ApprovalConfigQuery): string[] {
  const account = getConfig(cfg, accountId);
  const configuredApprovers = account.execApprovals?.approvers ?? [];
  const source =
    configuredApprovers.length > 0 ? configuredApprovers : (cfg.commands?.ownerAllowFrom ?? []);
  const seen = new Set<string>();
  const approvers: string[] = [];

  for (const item of source) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = normalizeStaffId(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    approvers.push(normalized);
  }

  return approvers;
}

export function getExecApprovalsConfig(
  query: ApprovalConfigQuery,
): ResolvedExecApprovalsConfig {
  const account = getConfig(query.cfg, query.accountId);
  const enabled = account.execApprovals?.enabled;
  const approvers = listExecApprovers(query);
  return {
    enabled,
    approvers,
    isNativeDeliveryEnabled: enabled === false ? false : approvers.length > 0,
  };
}

export function isExecAuthorizedSender({
  cfg,
  accountId,
  senderId,
}: ApprovalConfigQuery & { senderId: string }): boolean {
  const normalizedSender = normalizeStaffId(senderId);
  return listExecApprovers({ cfg, accountId }).includes(normalizedSender);
}

export function isPluginAuthorizedSender(
  query: ApprovalConfigQuery & { senderId: string },
): boolean {
  return isExecAuthorizedSender(query);
}

export function resolveNativeDeliveryMode(_query: ApprovalConfigQuery): "channel" {
  return "channel";
}
