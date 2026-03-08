import { normalizeAllowFrom, isSenderOwner } from "./access-control";
import type { DingTalkConfig } from "./types";

export function isWhoAmICommand(text: string | undefined): boolean {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === "/learn whoami" || normalized === "我是谁" || normalized === "我的信息";
}

export function isOwnerStatusCommand(text: string | undefined): boolean {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === "/learn owner status" || normalized === "owner状态" || normalized === "我是不是owner";
}

export function isLearnCommand(text: string | undefined): boolean {
  return String(text || "").trim().toLowerCase().startsWith("/learn ");
}

export function isLearningOwner(config: DingTalkConfig | undefined, params: {
  senderId?: string;
  rawSenderId?: string;
}): boolean {
  const allow = normalizeAllowFrom(config?.ownerAllowFrom);
  return isSenderOwner({
    allow,
    senderId: params.senderId,
    rawSenderId: params.rawSenderId,
  });
}

export function formatWhoAmIReply(params: {
  accountId: string;
  senderId: string;
  rawSenderId?: string;
  senderStaffId?: string;
  conversationId?: string;
  conversationType?: string;
  agentId?: string;
  sessionKey?: string;
  isOwner?: boolean;
}): string {
  const lines = [
    "这是你当前这条钉钉消息的身份信息：",
    "",
    `- senderId: \`${params.senderId || ""}\``,
    `- rawSenderId: \`${params.rawSenderId || ""}\``,
    `- senderStaffId: \`${params.senderStaffId || ""}\``,
    `- conversationId: \`${params.conversationId || ""}\``,
    `- conversationType: \`${params.conversationType || ""}\``,
    `- accountId: \`${params.accountId || ""}\``,
    `- agentId: \`${params.agentId || ""}\``,
    `- sessionKey: \`${params.sessionKey || ""}\``,
    `- isOwner: \`${params.isOwner ? "true" : "false"}\``,
    "",
    "后续如果要配置 owner 或控制命令权限，就以这里返回的 senderId 为准。",
  ];
  return lines.join("\n");
}

export function formatOwnerStatusReply(params: {
  senderId: string;
  rawSenderId?: string;
  isOwner: boolean;
  ownerAllowFrom?: string[];
}): string {
  return [
    "当前 owner 控制状态：",
    "",
    `- senderId: \`${params.senderId || ""}\``,
    `- rawSenderId: \`${params.rawSenderId || ""}\``,
    `- isOwner: \`${params.isOwner ? "true" : "false"}\``,
    `- ownerAllowFrom: \`${(params.ownerAllowFrom || []).join(",")}\``,
  ].join("\n");
}

export function formatOwnerOnlyDeniedReply(): string {
  return "这条学习/控制命令仅允许 owner 使用。先发送“我是谁”确认你的 senderId，再由宿主配置将该 senderId 加入 ownerAllowFrom。";
}
