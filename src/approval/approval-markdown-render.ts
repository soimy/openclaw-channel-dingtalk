import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequest,
  type PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ApprovalDecision } from "../types";

const ALL_DECISIONS: readonly ApprovalDecision[] = ["allow-once", "allow-always", "deny"];

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  "allow-once": "允许一次",
  "allow-always": "总是允许",
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
  allowedDecisions?: readonly string[] | null,
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

/**
 * Friendly approval card body used when the v3 template renders the
 * approve_btns ButtonGroup natively. Skips the /approve command listing
 * (the buttons render those decisions inline) so the card body stays
 * compact and human-readable.
 */
export function buildExecApprovalCardBody(request: ExecApprovalRequest, nowMs: number): string {
  const payload = request.request;
  const command = payload.commandPreview || payload.command || "(no command)";
  const cwdLine = payload.cwd ? `\n**工作目录**：\`${payload.cwd}\`` : "";
  const expireLine = formatExpireHint(request.expiresAtMs, nowMs);
  return [
    "🔒 **该命令需要您的审批**",
    "",
    "```",
    command,
    "```",
    cwdLine ? cwdLine.replace(/^\n/, "") : "",
    expireLine ? expireLine.replace(/^\n/, "") : "",
    "",
    "_请通过下方按钮批准或拒绝_",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function buildPluginApprovalCardBody(request: PluginApprovalRequest, nowMs: number): string {
  const payload = request.request;
  const tool = payload.toolName || "(unknown tool)";
  const expireLine = formatExpireHint(request.expiresAtMs, nowMs);
  return [
    "🔒 **插件操作需要您的审批**",
    "",
    `**工具**：\`${tool}\``,
    payload.description ? payload.description : "",
    expireLine ? expireLine.replace(/^\n/, "") : "",
    "",
    "_请通过下方按钮批准或拒绝_",
  ]
    .filter((line) => line !== "")
    .join("\n");
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
