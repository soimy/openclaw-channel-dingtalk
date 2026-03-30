import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";

function buildApproveSection(id: string, expiresInSec: number, allowAlwaysLabel: string): string {
  return [
    "---",
    "",
    "### 📥 审批选项",
    `请在 **${expiresInSec}秒** 内选择并回复以下指令：`,
    "",
    "* **允许单次执行**",
    `    \`/approve ${id} allow-once\``,
    `* **${allowAlwaysLabel}**`,
    `    \`/approve ${id} allow-always\``,
    "* **拒绝本次操作**",
    `    \`/approve ${id} deny\``,
  ].join("\n");
}

export function buildExecApprovalText(
  request: ExecApprovalRequest,
  nowMs: number,
): string {
  const expiresInSec = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  const lines: string[] = ["## 🔒 命令审批请求", "", "### 🖥️ 指令详情", ""];

  lines.push("```bash", request.request.command, "```");

  const meta: string[] = [];
  if (request.request.cwd) meta.push(`> **目录:** \`${request.request.cwd}\``);
  if (request.request.agentId) meta.push(`> **Agent:** \`${request.request.agentId}\``);
  if (meta.length > 0) lines.push("", ...meta);

  lines.push("", buildApproveSection(request.id, expiresInSec, "加入白名单"));
  return lines.join("\n");
}

export function buildPluginApprovalText(
  request: PluginApprovalRequest,
  nowMs: number,
): string {
  const expiresInSec = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  const icon = request.request.severity === "critical" ? "🚨" : "⚠️";
  const lines: string[] = [
    `## ${icon} 操作审批请求 — ${request.request.title}`,
    "",
    "### 🛠️ 指令详情",
  ];

  if (request.request.toolName) lines.push(`> **工具:** \`${request.request.toolName}\``);
  if (request.request.pluginId) lines.push(`> **Plugin:** \`${request.request.pluginId}\``);
  if (request.request.agentId) lines.push(`> **Agent:** \`${request.request.agentId}\``);

  lines.push("", "```", request.request.description, "```");
  lines.push("", buildApproveSection(request.id, expiresInSec, "始终允许该插件"));
  return lines.join("\n");
}
