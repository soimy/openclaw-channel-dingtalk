export function isWhoAmICommand(text: string | undefined): boolean {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === "/learn whoami" || normalized === "我是谁" || normalized === "我的信息";
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
    "",
    "后续如果要配置 owner 或控制命令权限，就以这里返回的 senderId 为准。",
  ];
  return lines.join("\n");
}
