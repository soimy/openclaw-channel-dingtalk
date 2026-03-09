import { normalizeAllowFrom, isSenderOwner } from "./access-control";
import type { DingTalkConfig } from "./types";

export interface ParsedLearnCommand {
  scope: "global" | "session" | "list" | "whoami" | "owner-status" | "unknown";
  instruction?: string;
}

export function parseLearnCommand(text: string | undefined): ParsedLearnCommand {
  const raw = String(text || "").trim();
  if (!raw) {
    return { scope: "unknown" };
  }
  const normalized = raw.toLowerCase();
  if (
    normalized === "/learn whoami"
    || normalized === "/whoami"
    || normalized === "我是谁"
    || normalized === "我的信息"
  ) {
    return { scope: "whoami" };
  }
  if (
    normalized === "/learn owner status"
    || normalized === "/owner status"
    || normalized === "/owner-status"
  ) {
    return { scope: "owner-status" };
  }
  if (normalized === "/learn list") {
    return { scope: "list" };
  }
  if (normalized.startsWith("/learn global ")) {
    return { scope: "global", instruction: raw.slice("/learn global ".length).trim() };
  }
  if (normalized.startsWith("/learn session ")) {
    return { scope: "session", instruction: raw.slice("/learn session ".length).trim() };
  }
  return { scope: "unknown" };
}

export function isLearningOwner(params: {
  cfg?: { commands?: { ownerAllowFrom?: Array<string | number> } };
  config?: DingTalkConfig;
  senderId?: string;
  rawSenderId?: string;
}): boolean {
  const allow = normalizeAllowFrom(params.cfg?.commands?.ownerAllowFrom as string[] | undefined);
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
  return "这条学习/控制命令仅允许 owner 使用。先发送“我是谁”确认你的 senderId，再由宿主将该 senderId 加入 commands.ownerAllowFrom。";
}

export function formatLearnCommandHelp(): string {
  return [
    "可用的 owner 学习命令：",
    "",
    "- /learn global <规则>：发布到当前钉钉账号下所有会话",
    "- /learn session <规则>：仅发布到当前私聊会话",
    "- /learn list：查看当前全局规则摘要",
  ].join("\n");
}

export function formatLearnAppliedReply(params: {
  scope: "global" | "session";
  instruction: string;
  ruleId?: string;
}): string {
  return [
    params.scope === "global" ? "已注入全局知识。" : "已注入当前会话知识。",
    "",
    params.ruleId ? `- ruleId: \`${params.ruleId}\`` : undefined,
    `- instruction: ${params.instruction}`,
    params.scope === "global"
      ? "- 生效范围：同一钉钉账号下所有会话，将在下一条消息进入时自动加载"
      : "- 生效范围：当前会话，将在下一条消息进入时自动加载",
  ].filter(Boolean).join("\n");
}

export function formatLearnListReply(lines: string[]): string {
  if (lines.length === 0) {
    return "当前还没有已启用的全局知识。";
  }
  return ["当前已启用的全局知识：", "", ...lines].join("\n");
}
