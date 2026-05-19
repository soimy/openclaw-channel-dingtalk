import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequest,
  type PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ApprovalDecision } from "../types";

const ALL_DECISIONS: readonly ApprovalDecision[] = ["allow-once", "allow-always", "deny"];

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  "allow-once": "批准（仅一次）",
  "allow-always": "批准（总是）",
  deny: "拒绝",
};

function formatExpireHint(expiresAtMs: number | undefined, nowMs: number): string {
  if (!expiresAtMs || expiresAtMs <= nowMs) {
    return "";
  }
  const minutes = Math.round((expiresAtMs - nowMs) / 60_000);
  return minutes > 0 ? `\n**过期时间**: ${minutes} 分钟` : "";
}

function normalizePluginAllowedDecisions(
  allowedDecisions?: readonly (ApprovalDecision | string)[] | null,
): readonly ApprovalDecision[] {
  if (!Array.isArray(allowedDecisions)) {
    return ALL_DECISIONS;
  }
  const explicit = allowedDecisions.filter((decision): decision is ApprovalDecision =>
    (ALL_DECISIONS as readonly string[]).includes(decision),
  );
  return explicit.length > 0 ? explicit : ALL_DECISIONS;
}

function decisionBlock(id: string, allowed: readonly ApprovalDecision[]): string {
  return allowed.map((decision) => `${DECISION_LABEL[decision]}：\`/approve ${id} ${decision}\``).join("\n");
}

export function buildExecApprovalMarkdown(request: ExecApprovalRequest, nowMs: number): string {
  const payload = request.request;
  const allowed = resolveExecApprovalRequestAllowedDecisions({
    ask: payload.ask ?? null,
    allowedDecisions: payload.allowedDecisions,
  }) as readonly ApprovalDecision[];
  const cwdLine = payload.cwd ? `\n**cwd**: \`${payload.cwd}\`` : "";
  const command = payload.commandPreview || payload.command || "(no command)";

  return [
    "### 需要审批：命令执行",
    `**ID**: \`${request.id}\`${cwdLine}${formatExpireHint(request.expiresAtMs, nowMs)}`,
    "",
    "```",
    command,
    "```",
    "",
    decisionBlock(request.id, allowed),
  ].join("\n");
}

export function buildPluginApprovalMarkdown(request: PluginApprovalRequest, nowMs: number): string {
  const payload = request.request;
  const allowed = normalizePluginAllowedDecisions(payload.allowedDecisions);
  const tool = payload.toolName || "(unknown tool)";

  return [
    "### 需要审批：插件调用",
    `**ID**: \`${request.id}\`\n**Tool**: \`${tool}\`${formatExpireHint(request.expiresAtMs, nowMs)}`,
    payload.description ? `\n${payload.description}` : "",
    "",
    decisionBlock(request.id, allowed),
  ].join("\n");
}
