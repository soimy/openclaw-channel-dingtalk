import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";

const APPROVE_HINT =
  "回复 `/approve allow-once` 或 `/approve allow-always` 允许，`/approve deny` 拒绝";

export function buildExecApprovalText(
  request: ExecApprovalRequest,
  nowMs: number,
): string {
  const expiresInSec = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  const lines: string[] = ["🔒 需要审批", ""];
  lines.push(`命令: ${request.request.command}`);
  if (request.request.cwd) lines.push(`目录: ${request.request.cwd}`);
  if (request.request.agentId) lines.push(`Agent: ${request.request.agentId}`);
  lines.push(`过期时间: ${expiresInSec}秒`);
  lines.push("", APPROVE_HINT);
  return lines.join("\n");
}

export function buildPluginApprovalText(
  request: PluginApprovalRequest,
  nowMs: number,
): string {
  const expiresInSec = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  const icon = request.request.severity === "critical" ? "🚨" : "⚠️";
  const lines: string[] = [`${icon} 需要审批 — ${request.request.title}`, ""];
  lines.push(request.request.description);
  if (request.request.toolName) lines.push(`工具: ${request.request.toolName}`);
  if (request.request.pluginId) lines.push(`Plugin: ${request.request.pluginId}`);
  if (request.request.agentId) lines.push(`Agent: ${request.request.agentId}`);
  lines.push(`过期时间: ${expiresInSec}秒`);
  lines.push("", APPROVE_HINT);
  return lines.join("\n");
}
