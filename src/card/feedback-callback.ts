import { resolveFeedbackReporting } from "../command/feedback-reporting-config";
import { withFeedbackForegroundActivity } from "../command/feedback-reporting-events";
import { applyFeedback, type FeedbackVote, type FeedbackScope } from "../command/feedback-store";
import type { DingTalkConfig, Logger } from "../platform/types";

export const FEEDBACK_ACTION_ID = "feedback_vote";
export const FEEDBACK_REASON_LABELS: Record<string, string> = {
  "1": "内容不匹配",
  "2": "内容不完整",
  "3": "表达不合逻辑",
  "4": "存在事实偏差",
  "5": "有敏感词或观点",
  "6": "回答不是我想要的",
};
function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function parseFeedbackCallback(payload: unknown) {
  const envelope = object(payload);
  const content = object(envelope?.content) ?? object(envelope?.value);
  const data = object(content?.cardPrivateData);
  const actions = data?.actionIds;
  if (
    !Array.isArray(actions) ||
    !actions.some((action) =>
      [FEEDBACK_ACTION_ID, "sys_action_like_component", "feedback_up", "feedback_down"].includes(
        String(action),
      ),
    )
  ) {
    return undefined;
  }
  const params = object(data?.params);
  const variableKey = typeof params?.variableKey === "string" ? params.variableKey : "";
  const match = /^(node_[A-Za-z0-9_]{1,100})_(likeOrDislike|dislikeTags)$/.exec(variableKey);
  let vote: FeedbackVote | undefined;
  let reasons: string[] | undefined;
  if (
    match?.[2] === "likeOrDislike" &&
    typeof params?.variableValue === "string" &&
    ["like", "dislike", "none"].includes(params.variableValue)
  ) {
    vote = params?.variableValue as FeedbackVote;
  } else if (
    match?.[2] === "dislikeTags" &&
    Array.isArray(params?.variableValue) &&
    params.variableValue.length <= 6 &&
    params.variableValue.every(
      (value) => typeof value === "string" && Object.hasOwn(FEEDBACK_REASON_LABELS, value),
    )
  ) {
    reasons = params.variableValue as string[];
  }
  return {
    outTrackId: typeof envelope?.outTrackId === "string" ? envelope.outTrackId : "",
    userId:
      envelope?.userIdType === 1 && typeof envelope.userId === "string" ? envelope.userId : "",
    component: match?.[1],
    vote,
    reasons,
    valid: Boolean(match && (vote || reasons)),
  };
}
async function handleFeedbackCallbackInner(params: {
  payload: unknown;
  eventId?: string;
  eventAt?: string;
  scope?: FeedbackScope;
  config: DingTalkConfig;
  log?: Logger;
}): Promise<{ response: unknown; notice?: string; userId: string } | undefined> {
  const feedback = parseFeedbackCallback(params.payload);
  if (!feedback) {
    return undefined;
  }
  const { component, userId } = feedback;
  const disabled = !params.config.feedbackEnabled || !params.scope;
  let reporting: ReturnType<typeof resolveFeedbackReporting>;
  try {
    reporting = resolveFeedbackReporting(params.config.feedbackReporting);
  } catch {
    /* Invalid reporting must not reject a valid rating. */
  }
  const result = disabled
    ? { status: "disabled" as const }
    : !feedback.valid
      ? { status: "invalid" as const }
      : await applyFeedback(
          params.scope!,
          {
            ...feedback,
            eventId: params.eventId ?? "",
            eventAt: Number(params.eventAt),
            vote: feedback.vote,
            reasons: feedback.reasons,
          },
          Date.now(),
          reporting,
        );
  const accepted = "record" in result;
  params.log?.info?.(
    `[DingTalk][Feedback] card=${feedback.outTrackId} status=${result.status}${accepted ? ` vote=${result.record.vote}` : ""}`,
  );
  // Update only the actor's private state, never global content or another person's selection.
  const response = component
    ? {
        cardUpdateOptions: { updatePrivateDataByKey: true },
        userPrivateData: {
          cardParamMap: {
            [`${component}_likeOrDislike`]: accepted ? result.record.vote : "none",
            [`${component}_dislikeTags`]: JSON.stringify(
              accepted && result.record.reasonsSubmitted ? result.record.reasons : null,
            ),
          },
        },
      }
    : { success: false };
  const notices: Record<string, string> = {
    disabled: "卡片评价尚未启用，请管理员检查配置。",
    invalid: "评价参数无效，请重新操作。",
    unknown: "这张卡片没有可验证的回答关联，暂不能记录评价。",
    forbidden: "只有这条回答的原提问者可以评价。",
    expired: "这张卡片已超过评价保留期限。",
    unfinished: "回答尚未完成，请在完成后评价。",
  };
  return { response, userId, notice: accepted ? undefined : notices[result.status] };
}

export async function handleFeedbackCallback(
  params: Parameters<typeof handleFeedbackCallbackInner>[0],
): ReturnType<typeof handleFeedbackCallbackInner> {
  return withFeedbackForegroundActivity(() => handleFeedbackCallbackInner(params));
}
