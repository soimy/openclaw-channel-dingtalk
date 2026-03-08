export interface CardCallbackAnalysis {
  summary: string;
  actionId?: string;
  feedbackTarget?: string;
  feedbackAckText?: string;
}

function stringifyCandidate(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseEmbeddedJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function extractCardActionSummary(data: any): string {
  const candidates = [
    data?.action,
    data?.actionType,
    data?.actionValue,
    data?.value,
    data?.eventType,
    data?.operate,
    data?.callbackType,
    data?.cardPrivateData,
    data?.privateData,
  ].filter((value) => value !== undefined && value !== null);

  if (candidates.length === 0) {
    return "(no action field found)";
  }

  return candidates.map(stringifyCandidate).join(" | ");
}

export function extractCardActionId(data: any): string | undefined {
  const embeddedValue = parseEmbeddedJson(data?.value);
  const embeddedContent = parseEmbeddedJson(data?.content);

  for (const source of [embeddedValue, embeddedContent, data].filter(Boolean)) {
    const actionIds = source?.cardPrivateData?.actionIds;
    if (Array.isArray(actionIds) && actionIds.length > 0 && typeof actionIds[0] === "string") {
      return actionIds[0];
    }
    if (typeof source?.actionValue === "string" && source.actionValue.trim()) {
      return source.actionValue.trim();
    }
    if (typeof source?.eventKey === "string" && source.eventKey.trim()) {
      return source.eventKey.trim();
    }
    if (typeof source?.value === "string" && source.value.trim()) {
      return source.value.trim();
    }
  }

  return undefined;
}

export function analyzeCardCallback(data: any): CardCallbackAnalysis {
  const summary = extractCardActionSummary(data);
  const actionId = extractCardActionId(data);

  if (actionId !== "feedback_up" && actionId !== "feedback_down") {
    return { summary, actionId };
  }

  const spaceType = typeof data?.spaceType === "string" ? data.spaceType.trim().toLowerCase() : "";
  const spaceId = typeof data?.spaceId === "string" ? data.spaceId.trim() : "";
  const userId = typeof data?.userId === "string" ? data.userId.trim() : "";
  const feedbackTarget = spaceType === "im" ? userId : spaceId;
  const feedbackAckText =
    actionId === "feedback_up"
      ? "✅ 已收到你的点赞（反馈已记录）"
      : "⚠️ 已收到你的点踩（反馈已记录，我会改进）";

  return {
    summary,
    actionId,
    feedbackTarget: feedbackTarget || undefined,
    feedbackAckText,
  };
}
