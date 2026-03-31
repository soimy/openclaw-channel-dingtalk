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
import type { CardBtn, DingTalkConfig } from "./types";

const DINGTALK_API = "https://api.dingtalk.com";

// Current approval card template (same ID, updated to support btns/hasAction)
// When PR #448 merges: replace with PRESET_CARD_TEMPLATE_ID
const APPROVAL_CARD_TEMPLATE_ID = "bd04e9b9-832c-42b9-9d4f-a8361acebc09.schema";

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

function makeApprovalBtns(approvalId: string): CardBtn[] {
  return [
    {
      text: "✅ 允许一次",
      color: "green",
      status: "normal",
      event: { type: "sendCardRequest", params: { actionId: "approval", params: { t: "approval", d: "allow-once", id: approvalId } } },
    },
    {
      text: "🔒 永久允许",
      color: "blue",
      status: "normal",
      event: { type: "sendCardRequest", params: { actionId: "approval", params: { t: "approval", d: "allow-always", id: approvalId } } },
    },
    {
      text: "❌ 拒绝",
      color: "red",
      status: "normal",
      event: { type: "sendCardRequest", params: { actionId: "approval", params: { t: "approval", d: "deny", id: approvalId } } },
    },
  ];
}

export function buildExecApprovalCardParamMap(
  request: ExecApprovalRequest,
  nowMs: number,
): Record<string, string> {
  const expiresInSec = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  const lines = ["## 🔒 命令审批请求", "", "```bash", request.request.command, "```"];
  if (request.request.cwd) lines.push(`\n**目录:** \`${request.request.cwd}\``);
  if (request.request.agentId) lines.push(`**Agent:** \`${request.request.agentId}\``);
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
  if (request.request.toolName) lines.push(`**工具:** \`${request.request.toolName}\``);
  if (request.request.pluginId) lines.push(`**Plugin:** \`${request.request.pluginId}\``);
  if (request.request.agentId) lines.push(`**Agent:** \`${request.request.agentId}\``);
  lines.push("", "```", request.request.description, "```");
  lines.push(`\n**有效期:** ${expiresInSec}秒`);

  return {
    content: lines.join("\n"),
    status: "",
    btns: JSON.stringify(makeApprovalBtns(request.id)),
    hasAction: "true",
  };
}

// --- Approval card creation ---

async function createApprovalCard(
  config: DingTalkConfig,
  conversationId: string,
  cardParamMap: Record<string, string>,
  outTrackId: string,
): Promise<{ ok: boolean; effectiveOutTrackId?: string; error?: string }> {
  const log = getLogger();
  try {
    const token = await getAccessToken(config, log);
    const isGroup = conversationId.startsWith("cid");
    // AI Card template: initialize with button variables only (content is populated via streaming)
    const { content, ...buttonParamMap } = cardParamMap;
    const enrichedParamMap = {
      ...buttonParamMap,
      config: JSON.stringify({ autoLayout: true, enableForward: false }),
    };
    const body = {
      cardTemplateId: APPROVAL_CARD_TEMPLATE_ID,
      outTrackId,
      cardData: { cardParamMap: enrichedParamMap },
      callbackType: "STREAM",
      imGroupOpenSpaceModel: { supportForward: false },
      imRobotOpenSpaceModel: { supportForward: false },
      openSpaceId: isGroup
        ? `dtv1.card//IM_GROUP.${conversationId}`
        : `dtv1.card//IM_ROBOT.${conversationId}`,
      userIdType: 1,
      imGroupOpenDeliverModel: isGroup
        ? { robotCode: config.robotCode || config.clientId, extension: { dynamicSummary: "true" } }
        : undefined,
      imRobotOpenDeliverModel: !isGroup
        ? {
            spaceType: "IM_ROBOT",
            robotCode: config.robotCode || config.clientId,
            extension: { dynamicSummary: "true" },
          }
        : undefined,
    };
    log?.info?.(`[DingTalk][ApprovalCard] POST createAndDeliver outTrackId=${outTrackId}`);
    const createResp = await axios.post(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, body, {
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      ...getProxyBypassOption(config),
    });
    // DingTalk may return a different outTrackId; use it for subsequent streaming updates
    const respData = createResp.data as { result?: { outTrackId?: string }; outTrackId?: string } | undefined;
    const effectiveOutTrackId =
      (typeof respData?.result?.outTrackId === "string" && respData.result.outTrackId) ||
      (typeof respData?.outTrackId === "string" && respData.outTrackId) ||
      outTrackId;
    if (effectiveOutTrackId !== outTrackId) {
      log?.info?.(`[DingTalk][ApprovalCard] Response outTrackId differs: sent=${outTrackId} got=${effectiveOutTrackId}`);
    }
    // AI Card content must be populated via streaming endpoint (cardParamMap is ignored for content key)
    // isFinalize: true → card enters done state, action buttons become visible
    if (content) {
      await axios.put(
        `${DINGTALK_API}/v1.0/card/streaming`,
        { outTrackId: effectiveOutTrackId, guid: randomUUID(), key: "content", content, isFull: true, isFinalize: true },
        {
          headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
          ...getProxyBypassOption(config),
        },
      );
    }
    return { ok: true, effectiveOutTrackId };
  } catch (err: unknown) {
    log?.error?.(`[DingTalk][ApprovalCard] Card creation failed: ${(err as Error).message}`);
    return { ok: false, effectiveOutTrackId: outTrackId, error: (err as Error).message };
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
  const { targetId } = stripTargetPrefix(target);
  const conversationId = resolveOriginalPeerId(targetId);
  const outTrackId = `approval_${randomUUID()}`;
  const cardParamMap = buildExecApprovalCardParamMap(request, nowMs);
  const result = await createApprovalCard(config, conversationId, cardParamMap, outTrackId);
  if (result.ok) {
    const storedOutTrackId = result.effectiveOutTrackId ?? outTrackId;
    cleanupExpiredApprovalCards();
    approvalCardStore.set(request.id, {
      outTrackId: storedOutTrackId,
      conversationId,
      accountId,
      expiresAt: request.expiresAtMs + 30_000,
    });
    log?.info?.(`[DingTalk][ApprovalCard] Card sent for exec approval ${request.id} outTrackId=${storedOutTrackId}`);
  }
  return { ok: result.ok, outTrackId: result.ok ? (result.effectiveOutTrackId ?? outTrackId) : undefined, error: result.error };
}

export async function sendPluginApprovalCard(
  config: DingTalkConfig,
  target: string,
  accountId: string | null | undefined,
  request: PluginApprovalRequest,
  nowMs: number,
): Promise<{ ok: boolean; outTrackId?: string; error?: string }> {
  const log = getLogger();
  const { targetId } = stripTargetPrefix(target);
  const conversationId = resolveOriginalPeerId(targetId);
  const outTrackId = `approval_${randomUUID()}`;
  const cardParamMap = buildPluginApprovalCardParamMap(request, nowMs);
  const result = await createApprovalCard(config, conversationId, cardParamMap, outTrackId);
  if (result.ok) {
    const storedOutTrackId = result.effectiveOutTrackId ?? outTrackId;
    cleanupExpiredApprovalCards();
    approvalCardStore.set(request.id, {
      outTrackId: storedOutTrackId,
      conversationId,
      accountId,
      expiresAt: request.expiresAtMs + 30_000,
    });
    log?.info?.(`[DingTalk][ApprovalCard] Card sent for plugin approval ${request.id} outTrackId=${storedOutTrackId}`);
  }
  return { ok: result.ok, outTrackId: result.ok ? (result.effectiveOutTrackId ?? outTrackId) : undefined, error: result.error };
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
      `${DINGTALK_API}/v1.0/card/instances`,
      {
        outTrackId,
        cardData: { cardParamMap: { status: resolvedText } },
        cardUpdateOptions: { updateCardDataByKey: true, updatePrivateDataByKey: true },
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

/**
 * Parse approval action from sendCardRequest callback (cardPrivateData format).
 * DingTalk appends button index to actionId: "approval" → "approval0"/"approval1"/"approval2"
 */
export function parseApprovalFromCardPrivateData(
  cardPrivateData: { actionIds?: string[]; params?: Record<string, unknown> } | undefined,
): ApprovalAction | null {
  if (!cardPrivateData?.actionIds?.length) return null;
  const actionId = cardPrivateData.actionIds[0];
  if (typeof actionId !== "string" || !actionId.startsWith("approval")) return null;
  const params = cardPrivateData.params;
  if (!params || params.t !== "approval" || typeof params.d !== "string" || typeof params.id !== "string") return null;
  return { t: params.t as "approval", d: params.d as ApprovalAction["d"], id: params.id };
}

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
        const client = await createOperatorApprovalsGatewayClient({
          config: cfg,
          clientDisplayName: "dingtalk-approval",
        });
        client.start();
        return client;
      } catch {
        getLogger()?.warn?.("[DingTalk][ApprovalCard] Gateway client unavailable (old OpenClaw?)");
        return null;
      }
    })();
  }
  return _gatewayClientPromise;
}

// Prewarm: trigger gateway client init early so connection is ready before button click
export function prewarmGatewayClient(cfg: OpenClawConfig): void {
  void getGatewayClient(cfg);
}

// --- Resolve approval via gateway ---

export async function resolveApprovalDecision(
  action: ApprovalAction,
  client: GatewayClient,
): Promise<void> {
  const method = action.id.startsWith("exec:") ? "exec.approval.resolve" : "plugin.approval.resolve";
  await client.request(method, { id: action.id, decision: action.d }, { expectFinal: true });
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
  const maxAttempts = 5;
  let resolved = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await resolveApprovalDecision(action, client);
      log?.info?.(`[DingTalk][ApprovalCard] Resolved ${action.id} decision=${action.d}`);
      resolved = true;
      break;
    } catch (err: unknown) {
      if (attempt === maxAttempts) {
        log?.error?.(`[DingTalk][ApprovalCard] Gateway resolve failed after ${maxAttempts} attempts: ${(err as Error).message}`);
      } else {
        log?.warn?.(`[DingTalk][ApprovalCard] Resolve attempt ${attempt} failed, retrying in 500ms: ${(err as Error).message}`);
        await new Promise<void>((r) => setTimeout(r, 500));
      }
    }
  }
  if (!resolved) {
    return;
  }
  // Update card UI (best-effort)
  const entry = approvalCardStore.get(action.id);
  if (entry) {
    approvalCardStore.delete(action.id);
    await updateApprovalCardResolved(config, entry.outTrackId, action.d);
  }
}
