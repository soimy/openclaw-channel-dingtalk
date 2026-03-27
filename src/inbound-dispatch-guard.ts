import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { isMessageProcessed, markMessageProcessed } from "./dedup";
import { handleDingTalkMessage } from "./inbound-handler";
import type { DingTalkConfig, DingTalkInboundMessage, Logger } from "./types";

const INFLIGHT_TTL_MS = 5 * 60 * 1000; // 5 min safety net for hung handlers
const processingDedupKeys = new Map<string, number>(); // key -> timestamp when acquired

export type InboundDispatchGuardResult =
  | { status: "processed" }
  | { status: "dedup_skipped" }
  | { status: "inflight_skipped" };

export type InboundDispatchGuardHooks = {
  onMissingMessageId?: () => void;
  onDedupSkipped?: (dedupKey: string) => void;
  onInflightSkipped?: (dedupKey: string) => void;
  onStaleInflightReleased?: (ctx: { dedupKey: string; heldMs: number; ttlMs: number }) => void;
};

export async function dispatchInboundMessageWithGuard(params: {
  cfg: OpenClawConfig;
  accountId: string;
  data: DingTalkInboundMessage;
  sessionWebhook?: string;
  log?: Logger;
  dingtalkConfig: DingTalkConfig;
  robotCode?: string;
  clientId?: string;
  msgId?: string;
  hooks?: InboundDispatchGuardHooks;
}): Promise<InboundDispatchGuardResult> {
  const {
    cfg,
    accountId,
    data,
    sessionWebhook,
    log,
    dingtalkConfig,
    robotCode,
    clientId,
    msgId,
    hooks,
  } = params;
  const robotKey = robotCode || clientId || accountId;
  const effectiveMsgId = (msgId || "").trim();
  const dedupKey = effectiveMsgId ? `${robotKey}:${effectiveMsgId}` : undefined;

  if (!dedupKey) {
    hooks?.onMissingMessageId?.();
    await handleDingTalkMessage({
      cfg,
      accountId,
      data,
      sessionWebhook,
      log,
      dingtalkConfig,
    });
    return { status: "processed" };
  }

  if (isMessageProcessed(dedupKey)) {
    hooks?.onDedupSkipped?.(dedupKey);
    return { status: "dedup_skipped" };
  }

  const inflightSince = processingDedupKeys.get(dedupKey);
  if (inflightSince !== undefined) {
    const heldMs = Date.now() - inflightSince;
    if (heldMs > INFLIGHT_TTL_MS) {
      hooks?.onStaleInflightReleased?.({ dedupKey, heldMs, ttlMs: INFLIGHT_TTL_MS });
      processingDedupKeys.delete(dedupKey);
    } else {
      hooks?.onInflightSkipped?.(dedupKey);
      return { status: "inflight_skipped" };
    }
  }

  processingDedupKeys.set(dedupKey, Date.now());
  try {
    await handleDingTalkMessage({
      cfg,
      accountId,
      data,
      sessionWebhook,
      log,
      dingtalkConfig,
    });
    markMessageProcessed(dedupKey);
    return { status: "processed" };
  } finally {
    processingDedupKeys.delete(dedupKey);
  }
}

export function clearInboundDispatchInFlightLocks(robotKey: string): number {
  let cleared = 0;
  for (const key of processingDedupKeys.keys()) {
    if (key.startsWith(`${robotKey}:`)) {
      processingDedupKeys.delete(key);
      cleared++;
    }
  }
  return cleared;
}
