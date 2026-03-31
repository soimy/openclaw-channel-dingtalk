import { randomUUID } from "node:crypto";
import axios from "axios";
import type { ExecApprovalRequest, PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getAccessToken } from "./auth";
import { stripTargetPrefix } from "./config";
import { getLogger } from "./logger-context";
import { resolveOriginalPeerId } from "./peer-id-registry";
import { getProxyBypassOption } from "./utils";
import type { DingTalkConfig } from "./types";

const DINGTALK_API = "https://api.dingtalk.com";

// Process-local store: approvalId → card metadata
export type ApprovalCardEntry = {
  outTrackId: string;
  conversationId: string;
  accountId: string | null | undefined;
  expiresAt: number;
};
export const approvalCardStore = new Map<string, ApprovalCardEntry>();

function cleanupExpiredApprovalCards(): void {
  const now = Date.now();
  for (const [key, entry] of approvalCardStore.entries()) {
    if (entry.expiresAt < now) {
      approvalCardStore.delete(key);
    }
  }
}

// --- Card param map builders ---

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
    actionIdOnce: JSON.stringify({ t: "approval", d: "allow-once", id: request.id }),
    actionIdAlways: JSON.stringify({ t: "approval", d: "allow-always", id: request.id }),
    actionIdDeny: JSON.stringify({ t: "approval", d: "deny", id: request.id }),
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
    actionIdOnce: JSON.stringify({ t: "approval", d: "allow-once", id: request.id }),
    actionIdAlways: JSON.stringify({ t: "approval", d: "allow-always", id: request.id }),
    actionIdDeny: JSON.stringify({ t: "approval", d: "deny", id: request.id }),
  };
}

// --- Approval card creation ---

async function createApprovalCard(
  config: DingTalkConfig,
  conversationId: string,
  cardParamMap: Record<string, string>,
  outTrackId: string,
): Promise<{ ok: boolean; error?: string }> {
  const log = getLogger();
  try {
    const token = await getAccessToken(config, log);
    const isGroup = conversationId.startsWith("cid");
    const body = {
      cardTemplateId: config.approvalCardTemplateId,
      outTrackId,
      cardData: { cardParamMap },
      callbackType: "STREAM",
      imGroupOpenSpaceModel: isGroup ? { supportForward: false } : undefined,
      imRobotOpenSpaceModel: !isGroup ? { supportForward: false } : undefined,
      openSpaceId: isGroup
        ? `dtv1.card//IM_GROUP.${conversationId}`
        : `dtv1.card//IM_ROBOT.${conversationId}`,
      userIdType: 1,
      imGroupOpenDeliverModel: isGroup
        ? { robotCode: config.robotCode || config.clientId }
        : undefined,
      imRobotOpenDeliverModel: !isGroup
        ? { spaceType: "IM_ROBOT", robotCode: config.robotCode || config.clientId }
        : undefined,
    };
    log?.debug?.(`[DingTalk][ApprovalCard] POST createAndDeliver outTrackId=${outTrackId}`);
    await axios.post(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, body, {
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      ...getProxyBypassOption(config),
    });
    return { ok: true };
  } catch (err: unknown) {
    log?.error?.(`[DingTalk][ApprovalCard] Card creation failed: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

export async function sendExecApprovalCard(
  config: DingTalkConfig,
  target: string,
  accountId: string | null | undefined,
  request: ExecApprovalRequest,
  nowMs: number,
): Promise<{ ok: boolean; outTrackId?: string; error?: string }> {
  const log = getLogger();
  if (!config.approvalCardTemplateId) {
    return { ok: false, error: "approvalCardTemplateId not configured" };
  }
  const { targetId } = stripTargetPrefix(target);
  const conversationId = resolveOriginalPeerId(targetId);
  const outTrackId = `approval_${randomUUID()}`;
  const cardParamMap = buildExecApprovalCardParamMap(request, nowMs);
  const result = await createApprovalCard(config, conversationId, cardParamMap, outTrackId);
  if (result.ok) {
    cleanupExpiredApprovalCards();
    approvalCardStore.set(request.id, {
      outTrackId,
      conversationId,
      accountId,
      expiresAt: request.expiresAtMs + 30_000,
    });
    log?.info?.(`[DingTalk][ApprovalCard] Card sent for exec approval ${request.id} outTrackId=${outTrackId}`);
  }
  return { ok: result.ok, outTrackId: result.ok ? outTrackId : undefined, error: result.error };
}

export async function sendPluginApprovalCard(
  config: DingTalkConfig,
  target: string,
  accountId: string | null | undefined,
  request: PluginApprovalRequest,
  nowMs: number,
): Promise<{ ok: boolean; outTrackId?: string; error?: string }> {
  const log = getLogger();
  if (!config.approvalCardTemplateId) {
    return { ok: false, error: "approvalCardTemplateId not configured" };
  }
  const { targetId } = stripTargetPrefix(target);
  const conversationId = resolveOriginalPeerId(targetId);
  const outTrackId = `approval_${randomUUID()}`;
  const cardParamMap = buildPluginApprovalCardParamMap(request, nowMs);
  const result = await createApprovalCard(config, conversationId, cardParamMap, outTrackId);
  if (result.ok) {
    cleanupExpiredApprovalCards();
    approvalCardStore.set(request.id, {
      outTrackId,
      conversationId,
      accountId,
      expiresAt: request.expiresAtMs + 30_000,
    });
    log?.info?.(`[DingTalk][ApprovalCard] Card sent for plugin approval ${request.id} outTrackId=${outTrackId}`);
  }
  return { ok: result.ok, outTrackId: result.ok ? outTrackId : undefined, error: result.error };
}

// --- Card update after resolution ---

export async function updateApprovalCardResolved(
  config: DingTalkConfig,
  outTrackId: string,
  decision: "allow-once" | "allow-always" | "deny",
): Promise<void> {
  const log = getLogger();
  const resolvedText =
    decision === "allow-once"
      ? "✅ 已允许（单次）"
      : decision === "allow-always"
        ? "✅ 已加入白名单"
        : "❌ 已拒绝";
  try {
    const token = await getAccessToken(config, log);
    await axios.put(
      `${DINGTALK_API}/v1.0/card/instances/${outTrackId}`,
      {
        outTrackId,
        cardData: {
          cardParamMap: {
            // Update status variable: hides action buttons, shows result button with this text
            status: resolvedText,
          },
        },
      },
      {
        headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
        ...getProxyBypassOption(config),
      },
    );
    log?.info?.(`[DingTalk][ApprovalCard] Card updated to resolved: ${resolvedText} outTrackId=${outTrackId}`);
  } catch (err: unknown) {
    log?.warn?.(`[DingTalk][ApprovalCard] Card update failed (non-critical): ${(err as Error).message}`);
  }
}

// --- Action value parsing ---

export type ApprovalAction = {
  t: "approval";
  d: "allow-once" | "allow-always" | "deny";
  id: string;
};

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

// --- Gateway client singleton ---

let _gatewayClientPromise: Promise<GatewayClient | null> | undefined;

function getGatewayClient(cfg: OpenClawConfig): Promise<GatewayClient | null> {
  if (!_gatewayClientPromise) {
    _gatewayClientPromise = (async () => {
      try {
        const { createOperatorApprovalsGatewayClient } = await import(
          "openclaw/plugin-sdk/gateway-runtime"
        );
        return await createOperatorApprovalsGatewayClient({
          config: cfg,
          clientDisplayName: "dingtalk-approval",
        });
      } catch {
        getLogger()?.warn?.("[DingTalk][ApprovalCard] Gateway client unavailable (old OpenClaw?)");
        return null;
      }
    })();
  }
  return _gatewayClientPromise;
}

// --- Resolve approval via gateway ---

export async function resolveApprovalDecision(
  action: ApprovalAction,
  client: GatewayClient,
): Promise<void> {
  const method = action.id.startsWith("exec:") ? "exec.approval.resolve" : "plugin.approval.resolve";
  await client.request(method, { approvalId: action.id, decision: action.d }, { expectFinal: true });
}

export async function handleApprovalCardCallback(
  action: ApprovalAction,
  cfg: OpenClawConfig,
  config: DingTalkConfig,
): Promise<void> {
  const log = getLogger();
  const client = await getGatewayClient(cfg);
  if (!client) {
    log?.warn?.(`[DingTalk][ApprovalCard] No gateway client, cannot resolve ${action.id}`);
    return;
  }
  try {
    await resolveApprovalDecision(action, client);
    log?.info?.(`[DingTalk][ApprovalCard] Resolved ${action.id} decision=${action.d}`);
  } catch (err: unknown) {
    log?.error?.(`[DingTalk][ApprovalCard] Gateway resolve failed: ${(err as Error).message}`);
    return;
  }
  // Update card UI (best-effort)
  const entry = approvalCardStore.get(action.id);
  if (entry) {
    approvalCardStore.delete(action.id);
    await updateApprovalCardResolved(config, entry.outTrackId, action.d);
  }
}
