import { createChannelNativeOriginTargetResolver } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

export type DingTalkApprovalTarget = {
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

export function normalizeApprovalTargetTo(raw: string): string {
  const trimmed = raw.trim();
  if (/^(user|group):/i.test(trimmed)) {
    return trimmed;
  }
  if (/^cid/i.test(trimmed)) {
    return `group:${trimmed}`;
  }
  return `user:${trimmed}`;
}

function resolveTurnSourceTarget(request: ApprovalRequest): DingTalkApprovalTarget | null {
  const payload = request.request;
  if (String(payload.turnSourceChannel || "").toLowerCase() !== "dingtalk") {
    return null;
  }
  if (!payload.turnSourceTo) {
    return null;
  }
  return {
    to: normalizeApprovalTargetTo(payload.turnSourceTo),
    accountId: payload.turnSourceAccountId ?? null,
    threadId: payload.turnSourceThreadId ?? null,
  };
}

function resolveSessionTarget(
  sessionTarget: { to: string; accountId?: string | null; threadId?: string | number | null },
): DingTalkApprovalTarget | null {
  if (!sessionTarget.to) {
    return null;
  }
  return {
    to: normalizeApprovalTargetTo(sessionTarget.to),
    accountId: sessionTarget.accountId ?? null,
    threadId: sessionTarget.threadId ?? null,
  };
}

export const resolveDingTalkOriginTarget =
  createChannelNativeOriginTargetResolver<DingTalkApprovalTarget>({
    channel: "dingtalk",
    resolveTurnSourceTarget,
    resolveSessionTarget,
    normalizeTarget: (target) => ({
      ...target,
      to: normalizeApprovalTargetTo(target.to),
    }),
  });
