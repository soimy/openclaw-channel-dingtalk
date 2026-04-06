import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import axios from "./http-client";
import { getAccessToken } from "./auth";
import { updateCardVariables } from "./card-callback-service";
import { DINGTALK_CARD_TEMPLATE, STOP_ACTION_VISIBLE, STOP_ACTION_HIDDEN } from "./card/card-template";
import { resolveRobotCode, stripTargetPrefix } from "./config";
import { resolveOriginalPeerId } from "./peer-id-registry";
import {
  createSyntheticOutboundMsgId,
  clearMessageContextCacheForTest,
  DEFAULT_CARD_CONTENT_TTL_MS,
  DEFAULT_CREATED_AT_MATCH_WINDOW_MS,
  DEFAULT_OUTBOUND_SENDER,
  inferConversationChatType,
  resolveByCreatedAtWindow,
  upsertOutboundMessageContext,
} from "./message-context-store";
import {
  readNamespaceJson,
  resolveNamespacePath,
  writeNamespaceJsonAtomic,
} from "./persistence-store";
import type {
  AICardInstance,
  AICardStreamingRequest,
  DingTalkConfig,
  DingTalkTrackingMetadata,
  Logger,
  QuotedRef,
} from "./types";
import { AICardStatus } from "./types";
import { formatDingTalkErrorPayloadLog, getProxyBypassOption } from "./utils";

const DINGTALK_API = "https://api.dingtalk.com";
// Thinking/tool stream snippets are truncated to keep card updates compact.
const CARD_STATE_FILE_VERSION = 1;
const CARD_PENDING_NAMESPACE = "cards.active.pending";
const RECOVERY_FINALIZE_MESSAGE = "⚠️ 上一次回复处理中断，已自动结束。请重新发送你的问题。";
const AICARD_DEGRADE_DEFAULT_MS = 30 * 60 * 1000;
const CARD_CACHE_MAX_PER_CONVERSATION = 20;
const CARD_CACHE_MAX_CONVERSATIONS = 500;
const DYNAMIC_SUMMARY_EXTENSION = { dynamicSummary: "true" } as const;

const aicardDegradeByAccount = new Map<string, { untilMs: number; reason: string }>();

export async function hideCardStopButton(
  outTrackId: string,
  token: string,
  config?: { bypassProxyForSend?: boolean },
  retries = 2,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await updateCardVariables(outTrackId, { stop_action: STOP_ACTION_HIDDEN }, token, config);
      return;
    } catch (err) {
      if (attempt >= retries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

const inMemoryCardContentStore = new Map<
  string,
  {
    entries: Array<{ content: string; createdAt: number; expiresAt: number }>;
    lastActiveAt: number;
  }
>();

function pruneInMemoryCardContentEntries(
  entries: Array<{ content: string; createdAt: number; expiresAt: number }>,
  nowMs: number,
): Array<{ content: string; createdAt: number; expiresAt: number }> {
  return entries.filter((entry) => nowMs < entry.expiresAt).slice(-CARD_CACHE_MAX_PER_CONVERSATION);
}

function touchInMemoryCardContentBucket(scopeKey: string, nowMs: number): {
  entries: Array<{ content: string; createdAt: number; expiresAt: number }>;
  lastActiveAt: number;
} {
  const existing = inMemoryCardContentStore.get(scopeKey);
  const bucket = existing
    ? {
        entries: pruneInMemoryCardContentEntries(existing.entries, nowMs),
        lastActiveAt: nowMs,
      }
    : { entries: [], lastActiveAt: nowMs };
  inMemoryCardContentStore.set(scopeKey, bucket);
  if (inMemoryCardContentStore.size > CARD_CACHE_MAX_CONVERSATIONS) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, candidate] of inMemoryCardContentStore) {
      if (candidate.lastActiveAt < oldestTime) {
        oldestTime = candidate.lastActiveAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      inMemoryCardContentStore.delete(oldestKey);
    }
  }
  return bucket;
}

function getAICardDegradeMs(config?: DingTalkConfig): number {
  const raw = config?.aicardDegradeMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 60_000) {
    return raw;
  }
  return AICARD_DEGRADE_DEFAULT_MS;
}

function normalizeDegradeErrorMessage(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function shouldTriggerAICardDegrade(err: unknown): boolean {
  const maybeErr = err as {
    response?: { status?: number; data?: { message?: string } };
    message?: string;
  };
  const status = maybeErr.response?.status;
  const msg = normalizeDegradeErrorMessage(
    String(maybeErr.response?.data?.message || maybeErr.message || ""),
  );
  if (status === 403 || status === 429) {
    return true;
  }
  if (typeof status === "number" && status >= 500 && status < 600) {
    return true;
  }
  return [
    "ipnotinwhitelist",
    "forbiddenaccessdenied",
    "timeout",
    "etimedout",
    "econnreset",
    "eaiagain",
    "sockethangup",
    "badgateway",
  ].some((keyword) => msg.includes(keyword));
}

export function isAICardDegraded(accountId: string): boolean {
  const state = aicardDegradeByAccount.get(accountId);
  if (!state) {
    return false;
  }
  if (Date.now() >= state.untilMs) {
    aicardDegradeByAccount.delete(accountId);
    return false;
  }
  return true;
}

export function getAICardDegradeState(
  accountId: string,
): { remainingMs: number; reason: string } | null {
  const state = aicardDegradeByAccount.get(accountId);
  if (!state) {
    return null;
  }
  const remainingMs = state.untilMs - Date.now();
  if (remainingMs <= 0) {
    aicardDegradeByAccount.delete(accountId);
    return null;
  }
  return { remainingMs, reason: state.reason };
}

export function activateAICardDegrade(
  accountId: string,
  reason: string,
  config?: DingTalkConfig,
  log?: Logger,
): void {
  const durationMs = getAICardDegradeMs(config);
  const untilMs = Date.now() + durationMs;
  const existed = isAICardDegraded(accountId);
  aicardDegradeByAccount.set(accountId, { untilMs, reason });
  const minutes = Math.round(durationMs / 60000);
  if (existed) {
    log?.warn?.(
      `[DingTalk][AICard][Degrade] Extended for account=${accountId}, minutes=${minutes}, reason=${reason}`,
    );
  } else {
    log?.warn?.(
      `[DingTalk][AICard][Degrade] Activated for account=${accountId}, minutes=${minutes}, reason=${reason}`,
    );
  }
}

export function clearAICardDegrade(accountId: string, log?: Logger): void {
  if (!aicardDegradeByAccount.has(accountId)) {
    return;
  }
  const reason = aicardDegradeByAccount.get(accountId)?.reason || "";
  aicardDegradeByAccount.delete(accountId);
  log?.info?.(`[DingTalk][AICard][Degrade] Cleared for account=${accountId}, lastReason=${reason}`);
}

function extractCardProcessQueryKey(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const data = payload as Record<string, any>;
  const deliverResults = data.result?.deliverResults;
  if (Array.isArray(deliverResults)) {
    for (const item of deliverResults) {
      if (typeof item?.carrierId === "string" && item.carrierId.trim()) {
        return item.carrierId.trim();
      }
    }
  }
  return undefined;
}

async function putAICardStreamingField(
  card: AICardInstance,
  key: string,
  content: string,
  finished: boolean,
  log?: Logger,
): Promise<void> {
  const tokenAge = Date.now() - card.createdAt;
  const tokenRefreshThreshold = 90 * 60 * 1000;
  let tokenAlreadyRefreshed = false;

  if (tokenAge > tokenRefreshThreshold && card.config) {
    log?.debug?.("[DingTalk][AICard] Token age exceeds threshold, refreshing...");
    try {
      card.accessToken = await getAccessToken(card.config, log);
      tokenAlreadyRefreshed = true;
      log?.debug?.("[DingTalk][AICard] Token refreshed successfully");
    } catch (err: any) {
      log?.warn?.(`[DingTalk][AICard] Failed to refresh token: ${err.message}`);
    }
  }

  const streamBody: AICardStreamingRequest = {
    outTrackId: card.outTrackId || card.cardInstanceId,
    guid: randomUUID(),
    key,
    content,
    isFull: true,
    isFinalize: finished,
    isError: false,
  };

  log?.debug?.(
    `[DingTalk][AICard] PUT /v1.0/card/streaming key=${key} contentLen=${content.length} isFull=true isFinalize=${finished} guid=${streamBody.guid} payload=${JSON.stringify(streamBody)}`,
  );

  const requestConfig = {
    headers: {
      "x-acs-dingtalk-access-token": card.accessToken,
      "Content-Type": "application/json",
    },
    ...(card.config ? getProxyBypassOption(card.config) : {}),
  };

  try {
    const streamResp = await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, streamBody, requestConfig);
    log?.debug?.(
      `[DingTalk][AICard] Streaming response: status=${streamResp.status}, data=${JSON.stringify(streamResp.data)}`,
    );
    card.lastUpdated = Date.now();
  } catch (err: any) {
    if (err.response?.status === 401 && card.config && !tokenAlreadyRefreshed) {
      log?.warn?.("[DingTalk][AICard] Received 401 error, attempting token refresh and retry...");
      try {
        card.accessToken = await getAccessToken(card.config, log);
        const retryResp = await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, streamBody, {
          ...requestConfig,
          headers: {
            ...requestConfig.headers,
            "x-acs-dingtalk-access-token": card.accessToken,
          },
        });
        log?.debug?.(
          `[DingTalk][AICard] Retry after token refresh succeeded: status=${retryResp.status}`,
        );
        card.lastUpdated = Date.now();
        return;
      } catch (retryErr: any) {
        log?.error?.(`[DingTalk][AICard] Retry after token refresh failed: ${retryErr.message}`);
        if (retryErr.response?.data !== undefined) {
          log?.error?.(
            formatDingTalkErrorPayloadLog(
              "card.stream.retryAfterRefresh",
              retryErr.response.data,
              "[DingTalk][AICard]",
            ),
          );
        }
      }
    }

    if (card.accountId && shouldTriggerAICardDegrade(err)) {
      activateAICardDegrade(
        card.accountId,
        `card.stream:${err?.response?.status || "unknown"}`,
        card.config,
        log,
      );
    }
    log?.error?.(`[DingTalk][AICard] Streaming update failed: key=${key} ${err.message}`);
    if (err.response?.data !== undefined) {
      log?.error?.(
        formatDingTalkErrorPayloadLog("card.stream", err.response.data, "[DingTalk][AICard]"),
      );
    }
    throw err;
  }
}

interface CreateAICardOptions {
  accountId?: string;
  storePath?: string;
  persistPending?: boolean;
  contextConversationId?: string;
  /** Whether to show quote section on the card (default: false) */
  hasQuote?: boolean;
  /** Quote content to display when hasQuote is true */
  quoteContent?: string;
}

interface PendingCardRecord {
  accountId: string;
  cardInstanceId: string;
  outTrackId?: string;
  conversationId: string;
  contextConversationId?: string;
  createdAt: number;
  lastUpdated: number;
  state: string;
}

interface PendingCardStateFile {
  version: number;
  updatedAt: number;
  pendingCards: PendingCardRecord[];
}

function getCardStateFilePath(storePath?: string): string | null {
  if (!storePath) {
    return null;
  }
  return resolveNamespacePath(CARD_PENDING_NAMESPACE, {
    storePath,
    format: "json",
  });
}

function getLegacyCardStateFilePath(storePath?: string): string | null {
  if (!storePath) {
    return null;
  }
  return path.join(path.dirname(storePath), "dingtalk-active-cards.json");
}

function normalizePendingState(parsed: Partial<PendingCardStateFile>): PendingCardStateFile {
  const records = Array.isArray(parsed.pendingCards) ? parsed.pendingCards : [];
  return {
    version: typeof parsed.version === "number" ? parsed.version : CARD_STATE_FILE_VERSION,
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    pendingCards: records.filter((entry): entry is PendingCardRecord =>
      Boolean(
        entry &&
        typeof entry.accountId === "string" &&
        typeof entry.cardInstanceId === "string" &&
        (entry.outTrackId === undefined || typeof entry.outTrackId === "string") &&
        typeof entry.conversationId === "string",
      ),
    ),
  };
}

function readPendingCardState(storePath?: string, log?: Logger): PendingCardStateFile {
  if (!storePath) {
    return { version: CARD_STATE_FILE_VERSION, updatedAt: Date.now(), pendingCards: [] };
  }

  const filePath = getCardStateFilePath(storePath);
  const legacyPath = getLegacyCardStateFilePath(storePath);

  if (filePath && fs.existsSync(filePath)) {
    const parsed = readNamespaceJson<Partial<PendingCardStateFile>>(CARD_PENDING_NAMESPACE, {
      storePath,
      format: "json",
      fallback: {},
      log,
    });
    return normalizePendingState(parsed);
  }

  try {
    if (!legacyPath || !fs.existsSync(legacyPath)) {
      return { version: CARD_STATE_FILE_VERSION, updatedAt: Date.now(), pendingCards: [] };
    }
    const raw = fs.readFileSync(legacyPath, "utf-8");
    if (!raw.trim()) {
      return { version: CARD_STATE_FILE_VERSION, updatedAt: Date.now(), pendingCards: [] };
    }
    const normalized = normalizePendingState(JSON.parse(raw) as Partial<PendingCardStateFile>);
    writePendingCardState(normalized, storePath, log);
    return normalized;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log?.warn?.(`[DingTalk][AICard] Failed to read pending card state: ${message}`);
    return { version: CARD_STATE_FILE_VERSION, updatedAt: Date.now(), pendingCards: [] };
  }
}

function writePendingCardState(
  state: PendingCardStateFile,
  storePath?: string,
  log?: Logger,
): void {
  if (!storePath) {
    return;
  }
  writeNamespaceJsonAtomic(CARD_PENDING_NAMESPACE, {
    storePath,
    format: "json",
    data: state,
    log,
  });
}

function upsertPendingCard(card: AICardInstance, storePath?: string, log?: Logger): void {
  if (!card.accountId || !storePath) {
    return;
  }
  const state = readPendingCardState(storePath, log);
  const next: PendingCardRecord = {
    accountId: card.accountId,
    cardInstanceId: card.cardInstanceId,
    outTrackId: card.outTrackId,
    conversationId: card.conversationId,
    contextConversationId: card.contextConversationId,
    createdAt: card.createdAt,
    lastUpdated: card.lastUpdated,
    state: card.state,
  };
  const index = state.pendingCards.findIndex((item) => item.cardInstanceId === card.cardInstanceId);
  if (index >= 0) {
    state.pendingCards[index] = next;
  } else {
    state.pendingCards.push(next);
  }
  state.updatedAt = Date.now();
  writePendingCardState(state, storePath, log);
}

function removePendingCard(card: AICardInstance, log?: Logger): void {
  if (!card.accountId || !card.storePath) {
    return;
  }
  removePendingCardById(card.cardInstanceId, card.storePath, log);
}

function removePendingCardById(cardInstanceId: string, storePath?: string, log?: Logger): void {
  if (!storePath) {
    return;
  }
  const state = readPendingCardState(storePath, log);
  const remaining = state.pendingCards.filter((item) => item.cardInstanceId !== cardInstanceId);
  if (remaining.length === state.pendingCards.length) {
    return;
  }
  state.pendingCards = remaining;
  state.updatedAt = Date.now();
  writePendingCardState(state, storePath, log);
}

function listPendingCardsByAccount(
  accountId: string,
  storePath?: string,
  log?: Logger,
): PendingCardRecord[] {
  const state = readPendingCardState(storePath, log);
  return state.pendingCards.filter((item) => item.accountId === accountId);
}

function normalizeRecoveredState(state: string): AICardInstance["state"] {
  if (state === AICardStatus.PROCESSING || state === AICardStatus.INPUTING) {
    return state;
  }
  return AICardStatus.PROCESSING;
}

// Helper to identify card terminal states.
export function isCardInTerminalState(state: string): boolean {
  return (
    state === AICardStatus.FINISHED
    || state === AICardStatus.STOPPED
    || state === AICardStatus.FAILED
  );
}

export function formatContentForCard(content: string | undefined, type: "thinking" | "tool"): string {
  if (!content) {
    return "";
  }

  const emoji = type === "thinking" ? "🤔" : "🛠️";
  const label = type === "thinking" ? "思考中" : "工具执行";

  const escaped = content
    .split("\n")
    .map((line) => line.replace(/^_(?=[^ ])/, "*").replace(/(?<=[^ ])_(?=$)/, "*"))
    .join("\n");

  return `${emoji} **${label}**\n\n${escaped}`;
}

async function sendTemplateMismatchNotification(
  card: AICardInstance,
  text: string,
  log?: Logger,
): Promise<void> {
  const config = card.config;
  if (!config) {
    return;
  }
  try {
    const token = await getAccessToken(config, log);
    const { targetId, isExplicitUser } = stripTargetPrefix(card.conversationId);
    const resolvedTarget = resolveOriginalPeerId(targetId);
    const isGroup = !isExplicitUser && resolvedTarget.startsWith("cid");
    const url = isGroup
      ? "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
      : "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";

    // Direct markdown fallback notification to user/group, without re-entering sendMessage card flow.
    const payload: Record<string, unknown> = {
      robotCode: resolveRobotCode(config),
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({ title: "OpenClaw 提醒", text }),
    };

    if (isGroup) {
      payload.openConversationId = resolvedTarget;
    } else {
      payload.userIds = [resolvedTarget];
    }

    await axios({
      url,
      method: "POST",
      data: payload,
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
    });
  } catch (sendErr: any) {
    log?.warn?.(`[DingTalk][AICard] Failed to send error notification to user: ${sendErr.message}`);
  }
}

/**
 * Send a proactive text message via card API (createAndDeliver + immediate finalize).
 * Used in card mode to replace oToMessages/batchSend for single-chat users.
 */
export async function sendProactiveCardText(
  config: DingTalkConfig,
  conversationId: string,
  content: string,
  log?: Logger,
): Promise<{ ok: boolean; error?: string } & DingTalkTrackingMetadata> {
  try {
    const card = await createAICard(config, conversationId, log, { persistPending: false });
    if (!card) {
      return { ok: false, error: "Failed to create AI card" };
    }
    await finishAICard(card, content, log);
    return {
      ok: true,
      processQueryKey: card.processQueryKey,
      outTrackId: card.outTrackId,
      cardInstanceId: card.cardInstanceId,
    };
  } catch (err: any) {
    log?.error?.(`[DingTalk][AICard] Proactive card send failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export async function recoverPendingCardsForAccount(
  config: DingTalkConfig,
  accountId: string,
  storePath?: string,
  log?: Logger,
): Promise<number> {
  return finalizePendingCardsByAccount(
    config,
    accountId,
    RECOVERY_FINALIZE_MESSAGE,
    storePath,
    "recover",
    log,
  );
}

export async function finalizeActiveCardsForAccount(
  config: DingTalkConfig,
  accountId: string,
  reason: string,
  storePath?: string,
  log?: Logger,
): Promise<number> {
  return finalizePendingCardsByAccount(config, accountId, reason, storePath, "finalize", log);
}

async function finalizePendingCardsByAccount(
  config: DingTalkConfig,
  accountId: string,
  reason: string,
  storePath: string | undefined,
  mode: "recover" | "finalize",
  log?: Logger,
): Promise<number> {
  if (!storePath) {
    return 0;
  }

  const pendingCards = listPendingCardsByAccount(accountId, storePath, log).filter(
    (item) => !isCardInTerminalState(item.state),
  );
  if (pendingCards.length === 0) {
    return 0;
  }

  let token = "";
  try {
    token = await getAccessToken(config, log);
  } catch (err: any) {
    const tokenFailureScope =
      mode === "recover" ? "pending card recovery" : "finalizing active cards";
    log?.warn?.(
      `[DingTalk][AICard] Failed to fetch token for ${tokenFailureScope}: ${err.message}`,
    );
    return 0;
  }

  let finalizedCount = 0;
  for (const entry of pendingCards) {
    const card: AICardInstance = {
      cardInstanceId: entry.cardInstanceId,
      accessToken: token,
      conversationId: entry.conversationId,
      contextConversationId: entry.contextConversationId,
      accountId: entry.accountId,
      storePath,
      outTrackId: entry.outTrackId,
      createdAt: entry.createdAt || Date.now(),
      lastUpdated: entry.lastUpdated || Date.now(),
      state: normalizeRecoveredState(entry.state),
      config,
    };
    try {
      await finishAICard(card, reason, log);
      finalizedCount += 1;
    } catch (err: any) {
      const action = mode === "recover" ? "recover" : "finalize";
      log?.warn?.(
        `[DingTalk][AICard] Failed to ${action} active card ${entry.cardInstanceId}: ${err.message}`,
      );
      removePendingCardById(entry.cardInstanceId, storePath, log);
    }
  }
  return finalizedCount;
}

export async function createAICard(
  config: DingTalkConfig,
  conversationId: string,
  log?: Logger,
  options: CreateAICardOptions = {},
): Promise<AICardInstance | null> {
  const accountId = options.accountId ?? "default";
  if (isAICardDegraded(accountId)) {
    const state = getAICardDegradeState(accountId);
    log?.warn?.(
      `[DingTalk][AICard][Degrade] Skip create for account=${accountId}, remainingMs=${state?.remainingMs || 0}, reason=${state?.reason || "unknown"}`,
    );
    return null;
  }

  try {
    const shouldPersistPending =
      options.persistPending ?? Boolean(options.accountId && options.storePath);
    const token = await getAccessToken(config, log);
    const template = DINGTALK_CARD_TEMPLATE;
    // Use randomUUID to avoid collisions across workers/restarts.
    const cardInstanceId = `card_${randomUUID()}`;

    log?.info?.(`[DingTalk][AICard] Creating and delivering card outTrackId=${cardInstanceId}`);

    const isGroup = conversationId.startsWith("cid");

    // DingTalk createAndDeliver API payload.
    // Note: do NOT include template.statusKey here — the createAndDeliver API may
    // reject unknown fields if the template variable is not yet provisioned.
    // Status is set to "streaming" via the streaming API immediately after creation.
    const cardParamMap = {
      config: JSON.stringify({ autoLayout: true, enableForward: true }),
      [template.streamingKey]: "",
      hasQuote: String(Boolean(options.hasQuote)),
      quoteContent: options.quoteContent || "",
      stop_action: STOP_ACTION_VISIBLE,
    };
    const createAndDeliverBody = {
      cardTemplateId: template.templateId,
      outTrackId: cardInstanceId,
      cardData: {
        cardParamMap,
      },
      callbackType: "STREAM",
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
      openSpaceId: isGroup
        ? `dtv1.card//IM_GROUP.${conversationId}`
        : `dtv1.card//IM_ROBOT.${conversationId}`,
      userIdType: 1,
      imGroupOpenDeliverModel: isGroup
        ? {
            robotCode: resolveRobotCode(config),
            extension: DYNAMIC_SUMMARY_EXTENSION,
          }
        : undefined,
      imRobotOpenDeliverModel: !isGroup
        ? {
            spaceType: "IM_ROBOT",
            robotCode: resolveRobotCode(config),
            extension: DYNAMIC_SUMMARY_EXTENSION,
          }
        : undefined,
    };

    log?.debug?.(
      `[DingTalk][AICard] POST /v1.0/card/instances/createAndDeliver body=${JSON.stringify(createAndDeliverBody)}`,
    );
    const resp = await axios.post(
      `${DINGTALK_API}/v1.0/card/instances/createAndDeliver`,
      createAndDeliverBody,
      {
        headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
        ...getProxyBypassOption(config),
      },
    );
    log?.debug?.(
      `[DingTalk][AICard] CreateAndDeliver response: status=${resp.status} data=${JSON.stringify(resp.data)}`,
    );
    const responseData = resp.data as
      | {
          result?: DingTalkTrackingMetadata;
          processQueryKey?: unknown;
          outTrackId?: unknown;
          cardInstanceId?: unknown;
        }
      | undefined;
    const responseTracking = responseData?.result;
    const processQueryKey =
      typeof responseTracking?.processQueryKey === "string" &&
      responseTracking.processQueryKey.trim()
        ? responseTracking.processQueryKey.trim()
        : typeof responseData?.processQueryKey === "string" && responseData.processQueryKey.trim()
          ? responseData.processQueryKey.trim()
          : undefined;
    const outTrackId =
      typeof responseTracking?.outTrackId === "string" && responseTracking.outTrackId.trim()
        ? responseTracking.outTrackId.trim()
        : typeof responseData?.outTrackId === "string" && responseData.outTrackId.trim()
          ? responseData.outTrackId.trim()
          : cardInstanceId;
    const resolvedCardInstanceId =
      typeof responseTracking?.cardInstanceId === "string" && responseTracking.cardInstanceId.trim()
        ? responseTracking.cardInstanceId.trim()
        : typeof responseData?.cardInstanceId === "string" && responseData.cardInstanceId.trim()
          ? responseData.cardInstanceId.trim()
          : cardInstanceId;

    // Return the AI card instance with config reference for token refresh/recovery.
    const aiCardInstance: AICardInstance = {
      cardInstanceId: resolvedCardInstanceId,
      accessToken: token,
      conversationId,
      contextConversationId: options.contextConversationId || conversationId,
      accountId,
      storePath: options.storePath,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      state: AICardStatus.PROCESSING,
      config,
      processQueryKey: processQueryKey || extractCardProcessQueryKey(resp.data),
      outTrackId,
    };
    if (shouldPersistPending) {
      upsertPendingCard(aiCardInstance, options.storePath, log);
    }

    clearAICardDegrade(accountId, log);

    // Kick the card into streaming mode immediately so the UI shows "输出中" and the
    // stop button becomes visible. Without this, the card sits in "创建中" skeleton state
    // until the first real content arrives — which may never happen for non-streaming replies.
    // This sends an empty content stream (isFull=true, isFinalize=false) which transitions
    // the card from PROCESSING to INPUTING on the DingTalk side.
    try {
      await putAICardStreamingField(aiCardInstance, template.contentKey, "", false, log);
      aiCardInstance.state = AICardStatus.INPUTING;
    } catch (kickErr: any) {
      log?.debug?.(`[DingTalk][AICard] Non-critical: failed to kick card into streaming mode: ${kickErr.message}`);
    }

    return aiCardInstance;
  } catch (err: any) {
    log?.error?.(`[DingTalk][AICard] Create failed: ${err.message}`);
    if (err.response) {
      const status = err.response.status;
      const statusText = err.response.statusText;
      const statusLabel = status ? ` status=${status}${statusText ? ` ${statusText}` : ""}` : "";
      log?.error?.(`[DingTalk][AICard] Create error response${statusLabel}`);
      log?.error?.(
        formatDingTalkErrorPayloadLog("card.create", err.response.data, "[DingTalk][AICard]"),
      );
    }
    if (shouldTriggerAICardDegrade(err)) {
      activateAICardDegrade(
        accountId,
        `card.create:${err?.response?.status || "unknown"}`,
        config,
        log,
      );
    }
    return null;
  }
}

/**
 * Update blockList via PUT /v1.0/card/instances API.
 * Required because streaming API returns 500 for complex loopArray types.
 */
export async function updateAICardBlockList(
  card: AICardInstance,
  blockListJson: string,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    log?.debug?.(
      `[DingTalk][AICard] Skip blockList update because card already terminal: outTrackId=${card.cardInstanceId} state=${card.state}`,
    );
    return;
  }

  const template = DINGTALK_CARD_TEMPLATE;
  const params: Record<string, unknown> = {
    [template.blockListKey]: blockListJson,
  };

  try {
    await updateCardVariables(
      card.outTrackId || card.cardInstanceId,
      params,
      card.accessToken,
      card.config,
    );
    card.lastStreamedContent = blockListJson;
    card.lastUpdated = Date.now();
    if (card.state === AICardStatus.PROCESSING) {
      card.state = AICardStatus.INPUTING;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log?.error?.(`[DingTalk][AICard] BlockList update failed: ${message}`);
    throw err;
  }
}

/**
 * Stream answer text to content key for real-time display.
 * Only used when cardRealTimeStream=true.
 * Uses streaming API because content is a simple string type.
 */
export async function streamAICardContent(
  card: AICardInstance,
  text: string,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    return;
  }
  const template = DINGTALK_CARD_TEMPLATE;
  await putAICardStreamingField(card, template.streamingKey, text, false, log);
}

/**
 * Clear the streaming content key.
 * Called when transitioning from streaming to blockList commit.
 */
export async function clearAICardStreamingContent(
  card: AICardInstance,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    return;
  }
  const template = DINGTALK_CARD_TEMPLATE;
  try {
    await putAICardStreamingField(card, template.streamingKey, "", false, log);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log?.debug?.(`[DingTalk][AICard] Non-critical: failed to clear streaming content: ${message}`);
  }
}

/**
 * Options for finalizing an AI Card via instances API.
 * All variables are written in a single API call for V2 template compatibility.
 */
export interface FinalizeCardOptions {
  /** CardBlock[] JSON string for blockList variable */
  blockListJson: string;
  /** Pure markdown answer text for copy action (content variable) */
  content: string;
  /** Optional quoted message preview text */
  quoteContent?: string;
  /** Optional task metadata JSON string */
  taskInfoJson?: string;
  /** Optional quoted message reference for caching */
  quotedRef?: QuotedRef;
}

/**
 * Commit blocks and finalize card via single instances API call.
 * V2 template requires finalize through instances API (not streaming API).
 * Writes blockList, content, quoteContent, taskInfo, and flowStatus in one call.
 */
export async function commitAICardBlocks(
  card: AICardInstance,
  options: FinalizeCardOptions,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    log?.debug?.(
      `[DingTalk][AICard] Skip finalize because card already terminal: outTrackId=${card.cardInstanceId} state=${card.state}`,
    );
    return;
  }

  const template = DINGTALK_CARD_TEMPLATE;
  const updates: Record<string, unknown> = {
    [template.blockListKey]: options.blockListJson,
    [template.streamingKey]: options.content, // content for copy action
    flowStatus: 3, // completed state - V2 template hides stop button automatically
  };

  // Optional fields
  if (options.quoteContent?.trim()) {
    updates.quoteContent = options.quoteContent;
  }
  if (options.taskInfoJson?.trim()) {
    updates.taskInfo = options.taskInfoJson;
  }

  log?.debug?.(
    `[DingTalk][AICard] Finalizing via instances API: outTrackId=${card.outTrackId || card.cardInstanceId} ` +
    `blockListLen=${options.blockListJson.length} contentLen=${options.content.length} flowStatus=3`,
  );

  try {
    await updateCardVariables(
      card.outTrackId || card.cardInstanceId,
      updates,
      card.accessToken,
      card.config,
    );
    card.lastStreamedContent = options.blockListJson;
    card.lastUpdated = Date.now();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log?.error?.(`[DingTalk][AICard] Finalize via instances API failed: ${message}`);
    throw err;
  }

  // Cache card content for quote recovery
  if (card.conversationId && options.content.trim() && card.accountId && card.processQueryKey) {
    const primaryConversationId = card.contextConversationId || card.conversationId;
    cacheCardContentByProcessQueryKey(
      card.accountId,
      primaryConversationId,
      card.processQueryKey,
      options.content,
      card.storePath,
      options.quotedRef,
      log,
    );
  }

  // Update local state
  card.state = AICardStatus.FINISHED;
  card.lastUpdated = Date.now();
  removePendingCard(card, log);
  log?.info?.(`[DingTalk][AICard] Card finalized: outTrackId=${card.outTrackId || card.cardInstanceId} state=FINISHED`);
}


export async function streamAICard(
  card: AICardInstance,
  content: string,
  finished: boolean = false,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    log?.debug?.(
      `[DingTalk][AICard] Skip stream update because card already terminal: outTrackId=${card.cardInstanceId} state=${card.state}`,
    );
    return;
  }
  const template = DINGTALK_CARD_TEMPLATE;

  try {
    await putAICardStreamingField(card, template.contentKey, content, finished, log);
    card.lastStreamedContent = content;
    if (finished) {
      card.state = AICardStatus.FINISHED;
      removePendingCard(card, log);
    } else if (card.state === AICardStatus.PROCESSING) {
      card.state = AICardStatus.INPUTING;
    }
  } catch (err: any) {
    card.state = AICardStatus.FAILED;
    card.lastUpdated = Date.now();
    removePendingCard(card, log);
    if (err.response?.status === 500 && err.response?.data?.code === "unknownError") {
      const errorMsg =
        "⚠️ **[DingTalk] AI Card 串流更新失败 (500 unknownError)**\n\n"
        + "这通常表示当前内置模板契约与钉钉侧模板字段不一致，当前及后续消息将自动回退为 Markdown 发送。";
      await sendTemplateMismatchNotification(card, errorMsg, log);
    }
    throw err;
  }
}

/**
 * Finalize AI Card via streaming API.
 *
 * @deprecated For V2 template, use `commitAICardBlocks()` instead which finalizes
 * via instances API (single call writes blockList, content, flowStatus=3).
 * This function is kept for backward compatibility with V1 template and for
 * card-stop-handler which uses streaming API for immediate stop acknowledgment.
 */
export async function finishAICard(
  card: AICardInstance,
  content: string,
  log?: Logger,
  options: { quotedRef?: QuotedRef } = {},
): Promise<void> {
  log?.debug?.(`[DingTalk][AICard] Starting finish, final content length=${content.length}`);
  await streamAICard(card, content, true, log);
  // Hide stop button on normal completion (symmetric with card-stop-handler).
  if (card.outTrackId && card.config) {
    try {
      const token = await getAccessToken(card.config, log);
      await hideCardStopButton(card.outTrackId, token, card.config);
    } catch (err: any) {
      log?.debug?.(`[DingTalk][AICard] Non-critical: failed to hide stop button on finish: ${err.message}`);
    }
  }
  if (card.conversationId && content.trim() && card.accountId && card.processQueryKey) {
    const primaryConversationId = card.contextConversationId || card.conversationId;
    cacheCardContentByProcessQueryKey(
      card.accountId,
      primaryConversationId,
      card.processQueryKey,
      content,
      card.storePath,
      options.quotedRef,
      log,
    );
  }
}

export async function finishStoppedAICard(
  card: AICardInstance,
  content: string,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    log?.debug?.(
      `[DingTalk][AICard] finishStoppedAICard skipped — already terminal: ${card.state}`,
    );
    return;
  }
  const template = DINGTALK_CARD_TEMPLATE;
  try {
    await putAICardStreamingField(card, template.contentKey, content, true, log);
  } finally {
    // Ensure local state is consistent even when the streaming API call fails.
    // The card is logically stopped regardless of whether DingTalk acknowledged it.
    card.lastStreamedContent = content;
    card.state = AICardStatus.STOPPED;
    card.lastUpdated = Date.now();
    removePendingCard(card, log);
  }
}

function cacheCardContentByProcessQueryKey(
  accountId: string,
  conversationId: string,
  processQueryKey: string,
  content: string,
  storePath?: string,
  quotedRef?: QuotedRef,
  log?: Logger,
): void {
  if (!processQueryKey.trim() || !content.trim() || !storePath) {
    return;
  }
  log?.debug?.(
    `[DingTalk][QuotedRef][Persist] direction=outbound scope=${conversationId} messageType=card ` +
    `processQueryKey=${processQueryKey} quotedRef=${quotedRef ? JSON.stringify(quotedRef) : "(none)"}`,
  );
  upsertOutboundMessageContext({
    storePath,
    accountId,
    conversationId,
    createdAt: Date.now(),
    text: content,
    messageType: "card",
    ...DEFAULT_OUTBOUND_SENDER,
    chatType: inferConversationChatType(conversationId),
    ttlMs: DEFAULT_CARD_CONTENT_TTL_MS,
    topic: null,
    quotedRef,
    delivery: {
      processQueryKey,
      kind: "proactive-card",
    },
  });
}

export function cacheCardContent(
  accountId: string,
  conversationId: string,
  content: string,
  createdAt: number,
  storePath?: string,
): void {
  if (!storePath) {
    // This fallback only serves short-lived, no-storePath sessions. It is kept
    // local to card-service instead of using the shared message context store
    // because there is no durable scope to share across modules or restarts.
    const scopeKey = `${accountId}:${conversationId}`;
    const nowMs = Date.now();
    const bucket = touchInMemoryCardContentBucket(scopeKey, nowMs);
    bucket.entries.push({ content, createdAt, expiresAt: nowMs + DEFAULT_CARD_CONTENT_TTL_MS });
    bucket.entries.sort((left, right) => left.createdAt - right.createdAt);
    bucket.entries = bucket.entries.slice(-CARD_CACHE_MAX_PER_CONVERSATION);
    return;
  }
  upsertOutboundMessageContext({
    storePath,
    accountId,
    conversationId,
    msgId: createSyntheticOutboundMsgId(createdAt),
    createdAt,
    text: content,
    messageType: "card",
    ...DEFAULT_OUTBOUND_SENDER,
    chatType: inferConversationChatType(conversationId),
    ttlMs: DEFAULT_CARD_CONTENT_TTL_MS,
    topic: null,
  });
}

export function findCardContent(
  accountId: string,
  conversationId: string,
  repliedCreatedAt: number,
  storePath?: string,
): string | null {
  if (!storePath) {
    const scopeKey = `${accountId}:${conversationId}`;
    const nowMs = Date.now();
    const bucket = inMemoryCardContentStore.get(scopeKey);
    if (!bucket) {
      return null;
    }
    bucket.entries = pruneInMemoryCardContentEntries(bucket.entries, nowMs);
    bucket.lastActiveAt = nowMs;
    if (bucket.entries.length === 0) {
      inMemoryCardContentStore.delete(scopeKey);
      return null;
    }
    let bestContent: string | null = null;
    let bestDelta = Infinity;
    for (const entry of bucket.entries) {
      const delta = Math.abs(entry.createdAt - repliedCreatedAt);
      if (delta <= DEFAULT_CREATED_AT_MATCH_WINDOW_MS && delta < bestDelta) {
        bestDelta = delta;
        bestContent = entry.content;
      }
    }
    return bestContent;
  }
  const record = resolveByCreatedAtWindow({
    storePath,
    accountId,
    conversationId,
    createdAt: repliedCreatedAt,
    windowMs: DEFAULT_CREATED_AT_MATCH_WINDOW_MS,
    direction: "outbound",
  });
  return record?.text || null;
}

export function clearCardContentCacheForTest(): void {
  inMemoryCardContentStore.clear();
  clearMessageContextCacheForTest();
}
