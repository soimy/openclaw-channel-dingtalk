import { normalizeAllowFrom, isSenderOwner } from "./access-control";
import type { DingTalkConfig } from "./types";

export interface ParsedLearnCommand {
  scope: "global" | "session" | "target" | "here" | "list" | "unknown";
  instruction?: string;
  targetId?: string;
}

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
  const normalized = String(text || "").trim().toLowerCase();
  return (
    normalized.startsWith("/learn ")
    || normalized.startsWith("全局注入：")
    || normalized.startsWith("注入全局：")
    || normalized.startsWith("全局知识：")
    || normalized.startsWith("这里注入：")
    || normalized.startsWith("注入这里：")
    || normalized.startsWith("当前会话注入：")
  );
}

export function parseLearnCommand(text: string | undefined): ParsedLearnCommand {
  const raw = String(text || "").trim();
  if (!raw) {
    return { scope: "unknown" };
  }
  const normalized = raw.toLowerCase();
  if (normalized === "/learn list") {
    return { scope: "list" };
  }
  if (normalized.startsWith("/learn here ")) {
    return { scope: "here", instruction: raw.slice("/learn here ".length).trim() };
  }
  if (normalized.startsWith("/learn target ")) {
    const rest = raw.slice("/learn target ".length).trim();
    const firstSpace = rest.indexOf(" ");
    if (firstSpace > 0) {
      return {
        scope: "target",
        targetId: rest.slice(0, firstSpace).trim(),
        instruction: rest.slice(firstSpace + 1).trim(),
      };
    }
  }
  if (normalized.startsWith("/learn global ")) {
    return { scope: "global", instruction: raw.slice("/learn global ".length).trim() };
  }
  if (normalized.startsWith("/learn session ")) {
    return { scope: "session", instruction: raw.slice("/learn session ".length).trim() };
  }
  if (raw.startsWith("全局注入：") || raw.startsWith("注入全局：") || raw.startsWith("全局知识：")) {
    return { scope: "global", instruction: raw.split("：").slice(1).join("：").trim() };
  }
  if (raw.startsWith("这里注入：") || raw.startsWith("注入这里：")) {
    return { scope: "here", instruction: raw.split("：").slice(1).join("：").trim() };
  }
  if (raw.startsWith("当前会话注入：")) {
    return { scope: "session", instruction: raw.split("：").slice(1).join("：").trim() };
  }
  return { scope: "unknown" };
}

export function isWhereAmICommand(text: string | undefined): boolean {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized === "/learn whereami"
    || normalized === "这里是谁"
    || normalized === "这个群是谁"
    || normalized === "这个会话是谁"
    || normalized === "这里的信息"
  );
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

export function formatWhereAmIReply(params: {
  accountId: string;
  conversationId: string;
  conversationType?: string;
  sessionKey?: string;
  senderId?: string;
  agentId?: string;
}): string {
  const typeLabel = params.conversationType === "2" || params.conversationType === "group" ? "群聊" : "私聊";
  return [
    "这是当前对话位置的信息：",
    "",
    `- 类型：${typeLabel}`,
    `- conversationId: \`${params.conversationId || ""}\``,
    `- accountId: \`${params.accountId || ""}\``,
    `- agentId: \`${params.agentId || ""}\``,
    `- sessionKey: \`${params.sessionKey || ""}\``,
    `- senderId: \`${params.senderId || ""}\``,
    "",
    `可直接用：\`/learn target ${params.conversationId || "<conversationId>"} <规则>\``,
    "或者在这里直接用：`/learn here <规则>`",
  ].join("\n");
}

export function formatLearnCommandHelp(): string {
  return [
    "可用的 owner 学习命令：",
    "",
    "- /learn global <规则>：发布到当前钉钉账号下所有会话",
    "- /learn session <规则>：仅发布到当前会话的临时学习笔记",
    "- /learn here <规则>：发布到当前群/当前私聊",
    "- /learn target <conversationId> <规则>：发布到指定群/指定私聊",
    "- /learn list：查看当前会话与全局规则摘要",
  ].join("\n");
}

export function formatLearnAppliedReply(params: {
  scope: "global" | "session" | "target";
  instruction: string;
  ruleId?: string;
  targetId?: string;
}): string {
  return [
    params.scope === "global"
      ? "已注入全局知识。"
      : params.scope === "target"
        ? "已注入当前目标知识。"
        : "已注入当前会话知识。",
    "",
    params.ruleId ? `- ruleId: \`${params.ruleId}\`` : undefined,
    params.targetId ? `- targetId: \`${params.targetId}\`` : undefined,
    `- instruction: ${params.instruction}`,
    params.scope === "global"
      ? "- 生效范围：同一钉钉账号下所有会话，将在下一条消息进入时自动加载"
      : params.scope === "target"
        ? "- 生效范围：指定群/私聊，将在该目标的下一条消息进入时自动加载"
        : "- 生效范围：当前会话的临时学习笔记，将在下一条消息进入时自动加载",
  ].filter(Boolean).join("\n");
}

export function formatLearnListReply(lines: string[]): string {
  if (lines.length === 0) {
    return "当前还没有已启用的学习规则。";
  }
  return ["当前可见的学习规则：", "", ...lines].join("\n");
}
