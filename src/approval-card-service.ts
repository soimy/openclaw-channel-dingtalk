import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { CardBtn } from "./types";

/**
 * Approval card param map builders + action callback parsers.
 *
 * Card delivery (createAndDeliver) and lifecycle updates are owned by
 * `src/approval/approval-native-adapter.ts`. Callback resolution goes through
 * `resolveApprovalOverGateway` (see channel.ts card callback handler) — no
 * local store, no command session dispatch.
 */

function makeApprovalBtns(approvalId: string): CardBtn[] {
  return [
    {
      text: "✅ 允许一次",
      color: "green",
      status: "normal",
      event: {
        type: "sendCardRequest",
        params: {
          actionId: "approval",
          params: { t: "approval", d: "allow-once", id: approvalId },
        },
      },
    },
    {
      text: "🔒 永久允许",
      color: "blue",
      status: "normal",
      event: {
        type: "sendCardRequest",
        params: {
          actionId: "approval",
          params: { t: "approval", d: "allow-always", id: approvalId },
        },
      },
    },
    {
      text: "❌ 拒绝",
      color: "red",
      status: "normal",
      event: {
        type: "sendCardRequest",
        params: { actionId: "approval", params: { t: "approval", d: "deny", id: approvalId } },
      },
    },
  ];
}

export function buildExecApprovalCardParamMap(
  request: ExecApprovalRequest,
  nowMs: number,
): Record<string, string> {
  const expiresInSec = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  const lines = ["## 🔒 命令审批请求", "", "```bash", request.request.command, "```"];
  if (request.request.cwd) {
    lines.push(`\n**目录:** \`${request.request.cwd}\``);
  }
  if (request.request.agentId) {
    lines.push(`**Agent:** \`${request.request.agentId}\``);
  }
  lines.push(`\n**有效期:** ${expiresInSec}秒`);

  return {
    content: lines.join("\n"),
    status: "",
    btns: JSON.stringify(makeApprovalBtns(request.id)),
    hasAction: "true",
  };
}

export function buildPluginApprovalCardParamMap(
  request: PluginApprovalRequest,
  nowMs: number,
): Record<string, string> {
  const expiresInSec = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  const icon = request.request.severity === "critical" ? "🚨" : "⚠️";
  const lines = [`## ${icon} 操作审批请求 — ${request.request.title}`, ""];
  if (request.request.toolName) {
    lines.push(`**工具:** \`${request.request.toolName}\``);
  }
  if (request.request.pluginId) {
    lines.push(`**Plugin:** \`${request.request.pluginId}\``);
  }
  if (request.request.agentId) {
    lines.push(`**Agent:** \`${request.request.agentId}\``);
  }
  lines.push("", "```", request.request.description, "```");
  lines.push(`\n**有效期:** ${expiresInSec}秒`);

  return {
    content: lines.join("\n"),
    status: "",
    btns: JSON.stringify(makeApprovalBtns(request.id)),
    hasAction: "true",
  };
}

// --- Action value parsing ---

export type ApprovalAction = {
  t: "approval";
  d: "allow-once" | "allow-always" | "deny";
  id: string;
};

/**
 * Parse approval action from sendCardRequest callback (cardPrivateData format).
 * DingTalk appends button index to actionId: "approval" → "approval0"/"approval1"/"approval2"
 */
export function parseApprovalFromCardPrivateData(
  cardPrivateData: { actionIds?: string[]; params?: Record<string, unknown> } | undefined,
): ApprovalAction | null {
  if (!cardPrivateData?.actionIds?.length) {
    return null;
  }
  const actionId = cardPrivateData.actionIds[0];
  if (typeof actionId !== "string" || !actionId.startsWith("approval")) {
    return null;
  }
  const params = cardPrivateData.params;
  const validDecisions = ["allow-once", "allow-always", "deny"];
  if (
    !params ||
    params.t !== "approval" ||
    typeof params.d !== "string" ||
    !validDecisions.includes(params.d) ||
    typeof params.id !== "string"
  ) {
    return null;
  }
  return { t: "approval", d: params.d as ApprovalAction["d"], id: params.id };
}

/**
 * Legacy fallback: parse approval action from JSON string (processQueryKey path).
 * Primary path is parseApprovalFromCardPrivateData (sendCardRequest format).
 * Kept as defensive fallback for older card template versions.
 */
export function parseApprovalActionValue(raw: string): ApprovalAction | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.t === "approval" &&
      (parsed.d === "allow-once" || parsed.d === "allow-always" || parsed.d === "deny") &&
      typeof parsed.id === "string"
    ) {
      return parsed as ApprovalAction;
    }
  } catch {
    // not JSON or not an approval action
  }
  return null;
}
