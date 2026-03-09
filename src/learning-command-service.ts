import { normalizeAllowFrom, isSenderOwner } from "./access-control";
import type { DingTalkConfig } from "./types";

export function isWhoAmICommand(text: string | undefined): boolean {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === "/learn whoami"
    || normalized === "/whoami"
    || normalized === "我是谁"
    || normalized === "我的信息";
}

export function isOwnerStatusCommand(text: string | undefined): boolean {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === "/learn owner status"
    || normalized === "/owner status"
    || normalized === "/owner-status";
}

export function isLearnCommand(text: string | undefined): boolean {
  return String(text || "").trim().toLowerCase().startsWith("/learn ");
}

export function isLearningOwner(config: DingTalkConfig | undefined, params: {
  senderId?: string;
  rawSenderId?: string;
}): boolean {
  const allow = normalizeAllowFrom(config?.allowFrom);
  return isSenderOwner({ allow, senderId: params.senderId, rawSenderId: params.rawSenderId });
}

export function formatWhoAmIReply(params: {
  senderId: string;
  rawSenderId?: string;
  senderStaffId?: string;
  isOwner?: boolean;
}): string {
  return [
    "这是你当前消息对应的身份信息：",
    "",
    `- senderId: \`${params.senderId || ""}\``,
    `- rawSenderId: \`${params.rawSenderId || ""}\``,
    `- senderStaffId: \`${params.senderStaffId || ""}\``,
    `- isOwner: \`${params.isOwner ? "true" : "false"}\``,
    "",
    "后续如果要配置 owner 或控制命令权限，就以这里返回的 senderId 为准。",
  ].join("\n");
}

export function formatOwnerStatusReply(params: {
  senderId: string;
  rawSenderId?: string;
  isOwner: boolean;
}): string {
  return [
    "当前 owner 控制状态：",
    "",
    `- senderId: \`${params.senderId || ""}\``,
    `- rawSenderId: \`${params.rawSenderId || ""}\``,
    `- isOwner: \`${params.isOwner ? "true" : "false"}\``,
    "",
    "如果需要变更 owner，请由宿主修改本机运行配置。",
  ].join("\n");
}

export function formatOwnerOnlyDeniedReply(): string {
  return "这条学习/控制命令仅允许 owner 使用。先发送“我是谁”确认你的 senderId，再由宿主配置将该 senderId 加入 allowFrom。";
}
