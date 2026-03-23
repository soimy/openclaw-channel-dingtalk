import {
  type ConversationHistorySlice,
  queryConversationHistory,
} from "../history/group-history-store";
import { getDingTalkRuntime } from "../runtime";
import { acquireSessionLock } from "../session-lock";
import type { HandleDingTalkMessageParams } from "../types";

export interface ParsedSummaryCommand {
  scope: "summary" | "unknown";
  chatType?: "direct" | "group";
  conversationIds?: string[];
  senderIds?: string[];
  mentionNames?: string[];
  useCurrentConversation?: boolean;
  sinceTs?: number;
  windowLabel: string;
}

export interface SummaryQueryParams {
  storePath?: string;
  accountId: string;
  chatType?: "direct" | "group";
  conversationIds?: string[];
  senderIds?: string[];
  mentionNames?: string[];
  sinceTs?: number;
  historyRetainLimit?: number;
  windowLabel: string;
}

export interface GenerateSummaryNarrativeParams {
  rt: ReturnType<typeof getDingTalkRuntime>;
  cfg: HandleDingTalkMessageParams["cfg"];
  accountId: string;
  senderId: string;
  senderName: string;
  replyTarget: string;
  routeSessionKey: string;
  conversationLabel: string;
  chatType: "direct" | "group";
  storePath?: string;
  chatTypeFilter?: "direct" | "group";
  conversationIds?: string[];
  senderIds?: string[];
  mentionNames?: string[];
  sinceTs?: number;
  historyRetainLimit?: number;
  windowLabel: string;
}

const DEFAULT_SUMMARY_WINDOW_LABEL = "最近 1 天";
const SUMMARY_RECENT_LIMIT_PER_CONVERSATION = 8;
const SUMMARY_COMMAND_HELP_LINES = [
  "Summary 命令用法：",
  "- /summary",
  "- /summary all [1d|3d|12h|today]",
  "- /summary group [1d|3d|12h|today]",
  "- /summary dm [1d|3d|12h|today]",
  "- /summary here [1d|3d|12h|today]",
  "- /summary conversations <conversationId1,conversationId2> [1d|3d|12h|today]",
  "- /summary sender <senderId1,senderId2> [1d|3d|12h|today]",
  "- /summary mention <name1,name2|me> [1d|3d|12h|today]",
].join("\n");

function parseTimeWindow(raw: string | undefined, nowMs: number): { sinceTs?: number; label: string; valid: boolean } {
  const value = (raw || "").trim().toLowerCase();
  if (!value) {
    return { sinceTs: nowMs - 24 * 60 * 60 * 1000, label: DEFAULT_SUMMARY_WINDOW_LABEL, valid: true };
  }
  if (value === "today" || value === "今天") {
    const start = new Date(nowMs);
    start.setHours(0, 0, 0, 0);
    return { sinceTs: start.getTime(), label: "今天", valid: true };
  }
  const matched = value.match(/^(\d+)([hdw])$/);
  if (!matched) {
    return { label: value, valid: false };
  }
  const amount = Number.parseInt(matched[1] || "0", 10);
  const unit = matched[2];
  if (!Number.isFinite(amount) || amount <= 0 || !unit) {
    return { label: value, valid: false };
  }
  const multiplier =
    unit === "h" ? 60 * 60 * 1000 : unit === "d" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return {
    sinceTs: nowMs - amount * multiplier,
    label: `最近 ${amount}${unit === "h" ? " 小时" : unit === "d" ? " 天" : " 周"}`,
    valid: true,
  };
}

function isDefinedString(value: string | undefined): value is string {
  return typeof value === "string";
}

function formatTime(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function formatConversationLabel(slice: ConversationHistorySlice): string {
  const prefix = slice.conversation.chatType === "group" ? "group" : "dm";
  return `[${prefix}] ${slice.conversation.title || slice.conversation.conversationId} (${slice.conversation.conversationId})`;
}

export function isSummaryCommandText(text: string | undefined): boolean {
  return String(text || "").trim().toLowerCase().startsWith("/summary");
}

export function formatSummaryCommandHelp(): string {
  return SUMMARY_COMMAND_HELP_LINES;
}

export function resolveSummaryMentionNames(
  mentionNames: string[] | undefined,
  senderName: string | undefined,
): string[] | undefined {
  if (!mentionNames || mentionNames.length === 0) {
    return undefined;
  }
  const sender = String(senderName || "").trim();
  const aliases = new Set(["me", "@me", "self", "@self", "我", "@我", "自己", "@自己"]);
  const resolved = mentionNames
    .map((name) => {
      const normalized = name.trim().toLowerCase();
      if (aliases.has(normalized)) {
        return sender || undefined;
      }
      return name.trim();
    })
    .filter((name): name is string => Boolean(name));
  return resolved.length > 0 ? [...new Set(resolved)] : undefined;
}

export function parseSummaryCommand(text: string | undefined, nowMs: number = Date.now()): ParsedSummaryCommand {
  const raw = String(text || "").trim();
  if (!raw || !raw.toLowerCase().startsWith("/summary")) {
    return { scope: "unknown", windowLabel: DEFAULT_SUMMARY_WINDOW_LABEL };
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  const args = tokens.slice(1);
  if (args.length === 0 || args[0] === "all") {
    const window = parseTimeWindow(args[1], nowMs);
    return window.valid
      ? { scope: "summary", sinceTs: window.sinceTs, windowLabel: window.label }
      : { scope: "unknown", windowLabel: DEFAULT_SUMMARY_WINDOW_LABEL };
  }
  if (args[0] === "group") {
    const window = parseTimeWindow(args[1], nowMs);
    return window.valid
      ? { scope: "summary", chatType: "group", sinceTs: window.sinceTs, windowLabel: window.label }
      : { scope: "unknown", windowLabel: DEFAULT_SUMMARY_WINDOW_LABEL };
  }
  if (args[0] === "dm" || args[0] === "direct") {
    const window = parseTimeWindow(args[1], nowMs);
    return window.valid
      ? { scope: "summary", chatType: "direct", sinceTs: window.sinceTs, windowLabel: window.label }
      : { scope: "unknown", windowLabel: DEFAULT_SUMMARY_WINDOW_LABEL };
  }
  if (args[0] === "here") {
    const window = parseTimeWindow(args[1], nowMs);
    return window.valid
      ? { scope: "summary", useCurrentConversation: true, sinceTs: window.sinceTs, windowLabel: window.label }
      : { scope: "unknown", windowLabel: DEFAULT_SUMMARY_WINDOW_LABEL };
  }
  if (args[0] === "conversations" && args[1]) {
    const conversationIds = args[1].split(",").map((item) => item.trim()).filter(Boolean);
    const window = parseTimeWindow(args[2], nowMs);
    return window.valid && conversationIds.length > 0
      ? { scope: "summary", conversationIds, sinceTs: window.sinceTs, windowLabel: window.label }
      : { scope: "unknown", windowLabel: DEFAULT_SUMMARY_WINDOW_LABEL };
  }
  if (args[0] === "sender" && args[1]) {
    const senderIds = args[1].split(",").map((item) => item.trim()).filter(Boolean);
    const window = parseTimeWindow(args[2], nowMs);
    return window.valid && senderIds.length > 0
      ? { scope: "summary", senderIds, sinceTs: window.sinceTs, windowLabel: window.label }
      : { scope: "unknown", windowLabel: DEFAULT_SUMMARY_WINDOW_LABEL };
  }
  if ((args[0] === "mention" || args[0] === "mentions") && args[1]) {
    const mentionNames = args[1].split(",").map((item) => item.replace(/^@+/, "").trim()).filter(Boolean);
    const window = parseTimeWindow(args[2], nowMs);
    return window.valid && mentionNames.length > 0
      ? { scope: "summary", mentionNames, sinceTs: window.sinceTs, windowLabel: window.label }
      : { scope: "unknown", windowLabel: DEFAULT_SUMMARY_WINDOW_LABEL };
  }
  return { scope: "unknown", windowLabel: DEFAULT_SUMMARY_WINDOW_LABEL };
}

export function querySummarySlices(params: SummaryQueryParams): ConversationHistorySlice[] {
  return queryConversationHistory({
    storePath: params.storePath,
    accountId: params.accountId,
    chatType: params.chatType,
    conversationIds: params.conversationIds,
    senderIds: params.senderIds,
    mentionNames: params.mentionNames,
    sinceTs: params.sinceTs,
    historyRetainLimit: params.historyRetainLimit,
    recentLimitPerConversation: SUMMARY_RECENT_LIMIT_PER_CONVERSATION,
  });
}

export function formatSummaryReply(params: {
  slices: ConversationHistorySlice[];
  windowLabel: string;
  chatType?: "direct" | "group";
  senderIds?: string[];
  conversationIds?: string[];
  mentionNames?: string[];
}): string {
  if (params.slices.length === 0) {
    return [
      "未找到可总结的消息。",
      "",
      `- 时间范围：${params.windowLabel}`,
      params.chatType ? `- 会话类型：${params.chatType === "group" ? "群聊" : "私聊"}` : undefined,
      params.conversationIds?.length ? `- 指定会话：${params.conversationIds.join(", ")}` : undefined,
      params.senderIds?.length ? `- 指定 senderId：${params.senderIds.join(", ")}` : undefined,
      params.mentionNames?.length ? `- 指定 mention：${params.mentionNames.join(", ")}` : undefined,
    ].filter(Boolean).join("\n");
  }

  const totalRecent = params.slices.reduce((sum, slice) => sum + slice.recentEntries.length, 0);
  const totalSegments = params.slices.reduce((sum, slice) => sum + slice.summarySegments.length, 0);
  const lines: string[] = [
    "Summary 检索结果：",
    "",
    `- 时间范围：${params.windowLabel}`,
    params.chatType ? `- 会话类型：${params.chatType === "group" ? "群聊" : "私聊"}` : undefined,
    params.conversationIds?.length ? `- 指定会话：${params.conversationIds.join(", ")}` : undefined,
    params.senderIds?.length ? `- 指定 senderId：${params.senderIds.join(", ")}` : undefined,
    params.mentionNames?.length ? `- 指定 mention：${params.mentionNames.join(", ")}` : undefined,
    `- 命中会话数：${params.slices.length}`,
    `- 最近原始消息数：${totalRecent}`,
    `- 历史摘要段数：${totalSegments}`,
    "",
  ].filter(isDefinedString);

  for (const slice of params.slices.slice(0, 10)) {
    lines.push(`## ${formatConversationLabel(slice)}`);
    if (slice.summarySegments.length > 0) {
      const segment = slice.summarySegments.at(-1);
      if (segment) {
        lines.push(
          `- 历史摘要：${segment.messageCount} 条，覆盖 ${formatTime(segment.fromTs) || "unknown"} ~ ${formatTime(segment.toTs) || "unknown"}`,
        );
        lines.push(`  ${segment.summary.split("\n").slice(0, 3).join(" / ")}`);
      }
    }
    if (slice.recentEntries.length > 0) {
      lines.push("- 最近消息：");
      for (const entry of slice.recentEntries.slice(-5)) {
        const ts = formatTime(entry.timestamp) || "unknown-time";
        lines.push(`  - ${ts} ${entry.sender}: ${entry.body}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function buildSummaryNarrativePrompt(params: SummaryQueryParams & { slices?: ConversationHistorySlice[] }): {
  fallbackReply: string;
  userPrompt: string;
  systemPrompt: string;
  slices: ConversationHistorySlice[];
} {
  const slices = params.slices ?? querySummarySlices(params);
  const fallbackReply = formatSummaryReply({
    slices,
    windowLabel: params.windowLabel,
    chatType: params.chatType,
    conversationIds: params.conversationIds,
    senderIds: params.senderIds,
    mentionNames: params.mentionNames,
  });

  const materialLines: string[] = [
    `时间范围：${params.windowLabel}`,
    params.chatType ? `会话类型：${params.chatType === "group" ? "群聊" : "私聊"}` : undefined,
    params.conversationIds?.length ? `指定会话：${params.conversationIds.join(", ")}` : undefined,
    params.senderIds?.length ? `指定 senderId：${params.senderIds.join(", ")}` : undefined,
    params.mentionNames?.length ? `指定 mention：${params.mentionNames.join(", ")}` : undefined,
    `命中会话数：${slices.length}`,
    "",
  ].filter(isDefinedString);

  // Keep the prompt material bounded even without a token estimator:
  // conversation count, segment count, recent-entry count, and per-segment
  // char caps are all limited upstream so this v1 path cannot grow without bound.
  for (const slice of slices.slice(0, 12)) {
    materialLines.push(`## 会话 ${formatConversationLabel(slice)}`);
    for (const segment of slice.summarySegments.slice(-3)) {
      materialLines.push(
        `- 历史摘要段：${segment.messageCount} 条，覆盖 ${formatTime(segment.fromTs) || "unknown"} ~ ${formatTime(segment.toTs) || "unknown"}`,
      );
      materialLines.push(segment.summary);
    }
    for (const entry of slice.recentEntries.slice(-8)) {
      const ts = formatTime(entry.timestamp) || "unknown-time";
      const mentionSuffix = entry.mentions?.length ? ` | mentions: ${entry.mentions.join(", ")}` : "";
      materialLines.push(`- ${ts} ${entry.sender}: ${entry.body}${mentionSuffix}`);
    }
    materialLines.push("");
  }

  const userPrompt = [
    "请根据下面提供的本地会话材料，生成中文总结。",
    "",
    "输出要求：",
    "1. 先给一个总览，说明主要话题、结论、分歧或待办。",
    "2. 再按会话分段总结，明确这是哪个群/私聊，不要串会话。",
    "3. 如果材料不足或只能看出局部线索，要明确说明，不要编造。",
    "4. 如果有引用/回复关系，尽量说明是谁在回应谁。",
    "5. 保持简洁，优先中文自然表达，不要输出 JSON。",
    "",
    "材料：",
    ...materialLines,
  ].join("\n");

  const systemPrompt = [
    "你在为 owner 生成 DingTalk 会话摘要。",
    "只能基于给定材料总结，不能编造未出现的事实。",
    "不同会话、不同时间段、不同发送者必须严格区分。",
    "如果材料里只有局部消息或摘要段，要明确这是局部总结。",
  ].join("\n");

  return { fallbackReply, userPrompt, systemPrompt, slices };
}

export async function generateSummaryNarrative(
  params: GenerateSummaryNarrativeParams,
): Promise<string> {
  const prompt = buildSummaryNarrativePrompt({
    storePath: params.storePath,
    accountId: params.accountId,
    chatType: params.chatTypeFilter,
    conversationIds: params.conversationIds,
    senderIds: params.senderIds,
    mentionNames: params.mentionNames,
    sinceTs: params.sinceTs,
    historyRetainLimit: params.historyRetainLimit,
    windowLabel: params.windowLabel,
  });
  if (prompt.slices.length === 0) {
    return prompt.fallbackReply;
  }

  const ctx = params.rt.channel.reply.finalizeInboundContext({
    Body: prompt.userPrompt,
    RawBody: prompt.userPrompt,
    CommandBody: prompt.userPrompt,
    BodyForCommands: prompt.userPrompt,
    From: params.replyTarget,
    To: params.replyTarget,
    SessionKey: `${params.routeSessionKey}::summary`,
    AccountId: params.accountId,
    ChatType: params.chatType,
    ConversationLabel: `${params.conversationLabel} [summary]`,
    SenderName: params.senderName,
    SenderId: params.senderId,
    Provider: "dingtalk",
    Surface: "dingtalk",
    Timestamp: Date.now(),
    GroupSystemPrompt: prompt.systemPrompt,
    CommandAuthorized: true,
    OriginatingChannel: "dingtalk",
    OriginatingTo: params.replyTarget,
  });

  let finalText = "";
  const summarySessionKey = `${params.routeSessionKey}::summary`;
  const releaseSessionLock = await acquireSessionLock(summarySessionKey);
  try {
    const dispatchResult = await params.rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg: params.cfg,
      dispatcherOptions: {
        responsePrefix: "",
        deliver: async (payload: { text?: string }, info?: { kind?: string }) => {
          if (info?.kind && info.kind !== "final") {
            return;
          }
          const text = payload.text;
          if (typeof text === "string" && text.trim()) {
            finalText = text.trim();
          }
        },
      },
      replyOptions: {},
    });
    const queuedFinalText =
      typeof dispatchResult?.queuedFinal === "string" ? String(dispatchResult.queuedFinal).trim() : "";
    if (!finalText && queuedFinalText) {
      finalText = queuedFinalText;
    }
  } catch {
    return prompt.fallbackReply;
  } finally {
    releaseSessionLock();
  }

  return finalText || prompt.fallbackReply;
}
