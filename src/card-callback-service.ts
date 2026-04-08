import axios from "./http-client";
import { getProxyBypassOption } from "./utils";

const DINGTALK_API = "https://api.dingtalk.com";

export interface CardCallbackAnalysis {
  summary: string;
  actionId?: string;
  feedbackTarget?: string;
  feedbackAckText?: string;
  userId?: string;
  spaceId?: string;
  processQueryKey?: string;
  outTrackId?: string;
  cardInstanceId?: string;
  cardPrivateData?: {
    actionIds?: string[];
    params?: Record<string, unknown>;
  };
}

function stringifyCandidate(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
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

export function extractCardActionSummary(data: unknown): string {
  const record = asRecord(data);
  const candidates = [
    record?.action,
    record?.actionType,
    record?.actionValue,
    record?.value,
    record?.eventType,
    record?.operate,
    record?.callbackType,
    record?.cardPrivateData,
    record?.privateData,
  ].filter((value) => value !== undefined && value !== null);

  if (candidates.length === 0) {
    return "(no action field found)";
  }

  return candidates.map(stringifyCandidate).join(" | ");
}

export function extractCardActionId(data: unknown): string | undefined {
  const record = asRecord(data);
  const embeddedValue = parseEmbeddedJson(record?.value);
  const embeddedContent = parseEmbeddedJson(record?.content);

  for (const source of [embeddedValue, embeddedContent, record].filter(Boolean)) {
    const sourceRecord = asRecord(source);
    const cardPrivateData = asRecord(sourceRecord?.cardPrivateData);
    const actionIds = cardPrivateData?.actionIds;
    if (Array.isArray(actionIds) && actionIds.length > 0 && typeof actionIds[0] === "string") {
      return actionIds[0];
    }
    if (typeof sourceRecord?.actionValue === "string" && sourceRecord.actionValue.trim()) {
      return sourceRecord.actionValue.trim();
    }
    if (typeof sourceRecord?.eventKey === "string" && sourceRecord.eventKey.trim()) {
      return sourceRecord.eventKey.trim();
    }
    if (typeof sourceRecord?.value === "string" && sourceRecord.value.trim()) {
      return sourceRecord.value.trim();
    }
  }

  return undefined;
}

export function analyzeCardCallback(data: unknown): CardCallbackAnalysis {
  const record = asRecord(data);
  const summary = extractCardActionSummary(data);
  const actionId = extractCardActionId(data);
  const embeddedValue = asRecord(parseEmbeddedJson(record?.value));
  const embeddedContent = asRecord(parseEmbeddedJson(record?.content));
  const embeddedCardPrivateData = asRecord(parseEmbeddedJson(record?.cardPrivateData));
  const embeddedValuePrivateData = asRecord(parseEmbeddedJson(embeddedValue?.cardPrivateData));
  const embeddedContentPrivateData = asRecord(parseEmbeddedJson(embeddedContent?.cardPrivateData));
  const candidateRecords = [
    record,
    embeddedValue,
    embeddedContent,
    embeddedCardPrivateData,
    embeddedValuePrivateData,
    embeddedContentPrivateData,
  ].filter(Boolean) as Array<Record<string, unknown>>;
  const pickString = (...keys: string[]): string | undefined => {
    for (const source of candidateRecords) {
      for (const key of keys) {
        const value = source[key];
        if (typeof value === "string" && value.trim()) {
          return value.trim();
        }
      }
    }
    return undefined;
  };
  const processQueryKey =
    pickString("processQueryKey");
  const outTrackId = pickString("outTrackId");
  const cardInstanceId = pickString("cardInstanceId");
  // For non-feedback paths, pickString is fine for spaceId/userId (broad search).
  // For feedback paths, use precise extraction from record to avoid picking a
  // same-named but different-valued spaceId from nested embedded objects.
  const spaceId = pickString("spaceId");
  const userId = pickString("userId");

  // Extract cardPrivateData from sendCardRequest callbacks
  let cardPrivateData: CardCallbackAnalysis["cardPrivateData"];
  for (const source of [embeddedContent, embeddedValue, record].filter(Boolean)) {
    const sourceRecord = asRecord(source);
    const cpd = asRecord(sourceRecord?.cardPrivateData);
    if (cpd && Array.isArray(cpd.actionIds)) {
      cardPrivateData = {
        actionIds: cpd.actionIds as string[],
        params: asRecord(cpd.params),
      };
      break;
    }
  }

  if (actionId !== "feedback_up" && actionId !== "feedback_down") {
    return {
      summary,
      actionId,
      userId,
      spaceId,
      processQueryKey,
      outTrackId,
      cardInstanceId,
      cardPrivateData,
    };
  }

  // Feedback path: use precise extraction for spaceId/userId to avoid misrouting
  // feedbackTarget when nested objects contain same-named fields with different values.
  const preciseSpaceId =
    (typeof record?.spaceId === "string" && record.spaceId.trim()) || spaceId;
  const preciseUserId =
    (typeof record?.userId === "string" && record.userId.trim()) || userId;
  const spaceType = typeof record?.spaceType === "string" ? record.spaceType.trim().toLowerCase() : "";
  const feedbackTarget = spaceType === "im" ? preciseUserId : preciseSpaceId;
  const feedbackAckText =
    actionId === "feedback_up"
      ? "✅ 已收到你的点赞（反馈已记录）"
      : "⚠️ 已收到你的点踩（反馈已记录，我会改进）";

  return {
    summary,
    actionId,
    feedbackTarget: feedbackTarget || undefined,
    feedbackAckText,
    userId: userId || undefined,
    spaceId: spaceId || undefined,
    processQueryKey,
    outTrackId,
    cardInstanceId,
    cardPrivateData,
  };
}

/**
 * Update card variables via PUT /v1.0/card/instances.
 * Echoes params back into cardParamMap so the template can use conditional
 * rendering (e.g. hiding buttons when a param is set).
 */
export async function updateCardVariables(
  outTrackId: string,
  params: Record<string, unknown>,
  token: string,
  config?: { bypassProxyForSend?: boolean },
): Promise<number> {
  const stringMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    stringMap[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  const resp = await axios.put(
    `${DINGTALK_API}/v1.0/card/instances`,
    {
      outTrackId,
      cardData: { cardParamMap: stringMap },
      cardUpdateOptions: { updateCardDataByKey: true, updatePrivateDataByKey: true },
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      ...getProxyBypassOption(config),
    },
  );
  return resp.status;
}
