import { FEEDBACK_REASON_LABELS } from "../card/feedback-callback";
import { feedbackDetail, type FeedbackContentReader } from "./feedback-detail";
import { feedbackStats, type FeedbackScope } from "./feedback-store";

export async function runFeedbackCommand(
  text: string,
  options: {
    scope: FeedbackScope;
    userId: string;
    isDirect: boolean;
    enabled: boolean;
    readContent?: FeedbackContentReader;
  },
): Promise<string | undefined> {
  if (!/^\/feedback(?:\s|$)/i.test(text.trim())) {
    return undefined;
  }
  if (!options.isDirect) {
    return "请在与机器人的私聊中查询本人评价统计。";
  }
  if (!options.enabled) {
    return "卡片评价尚未启用，请管理员设置 feedbackEnabled: true。";
  }
  if (!options.userId) {
    return "无法核实你的员工身份，不能查询评价。";
  }
  const detail = /^\/feedback\s+detail\s+([A-Za-z0-9_-]{1,200})$/i.exec(text.trim());
  if (detail) {
    if (!options.readContent) {
      return "当前宿主未提供转录读取能力。";
    }
    return feedbackDetail({
      scope: options.scope,
      userId: options.userId,
      outTrackId: detail[1],
      readContent: options.readContent,
    });
  }
  const match = /^\/feedback\s+stats(?:\s+(\d{1,3})d)?$/i.exec(text.trim());
  const days = match?.[1] ? Number(match[1]) : 7;
  if (!match || days < 1 || days > 365) {
    return "用法：/feedback stats（最近 7 天）、/feedback stats 30d（1～365 天），或 /feedback detail <卡片ID>。";
  }
  if (!options.userId) {
    return "无法核实你的员工身份，不能查询统计。";
  }
  const stats = await feedbackStats(options.scope, options.userId, days);
  const rated = stats.like + stats.dislike;
  const lines = [
    `### 我的回答评价 · 最近 ${days} 天`,
    "",
    `- 已完成且仍保留的回答：${stats.total} 条`,
    `- 点赞：${stats.like} 条`,
    `- 点踩：${stats.dislike} 条`,
    `- 评价率：${stats.total ? ((rated / stats.total) * 100).toFixed(1) : "0"}%`,
    "",
    "按回答创建时间筛选，以当前有效评价统计；已撤销的不计入赞踩。",
  ];
  const reasons = Object.entries(stats.reasons).toSorted((a, b) => b[1] - a[1]);
  if (reasons.length) {
    lines.push(
      "",
      "**点踩原因（可多选）**",
      ...reasons.map(([code, count]) => `- ${FEEDBACK_REASON_LABELS[code] ?? code}：${count}`),
    );
  }
  return lines.join("\n");
}
