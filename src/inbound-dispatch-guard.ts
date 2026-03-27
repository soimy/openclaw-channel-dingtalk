import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { isMessageProcessed, markMessageProcessed } from "./dedup";
import { handleDingTalkMessage } from "./inbound-handler";
import type { DingTalkConfig, DingTalkInboundMessage, Logger } from "./types";

const INFLIGHT_TTL_MS = 5 * 60 * 1000; // 5 min safety net for hung handlers
type InflightEntry = {
  since: number;
  completion: Promise<boolean>;
  settle: (succeeded: boolean) => void;
};
const processingDedupKeys = new Map<string, InflightEntry>(); // key -> inflight metadata

export type InboundInFlightPolicy = "skip" | "wait";

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

async function waitForInflightCompletion(
  inflight: InflightEntry,
  ttlMs: number,
): Promise<boolean | "timeout"> {
  const remainingMs = ttlMs - (Date.now() - inflight.since);
  if (remainingMs <= 0) {
    return "timeout";
  }

  return await new Promise<boolean | "timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), remainingMs);
    void inflight.completion.then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

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
  inFlightPolicy?: InboundInFlightPolicy;
  inFlightTtlMs?: number;
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
    inFlightPolicy = "skip",
    inFlightTtlMs = INFLIGHT_TTL_MS,
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

  while (true) {
    if (isMessageProcessed(dedupKey)) {
      hooks?.onDedupSkipped?.(dedupKey);
      return { status: "dedup_skipped" };
    }

    const inflight = processingDedupKeys.get(dedupKey);
    if (inflight !== undefined) {
      const heldMs = Date.now() - inflight.since;
      if (heldMs > inFlightTtlMs) {
        hooks?.onStaleInflightReleased?.({ dedupKey, heldMs, ttlMs: inFlightTtlMs });
        processingDedupKeys.delete(dedupKey);
        continue;
      }

      if (inFlightPolicy === "skip") {
        hooks?.onInflightSkipped?.(dedupKey);
        return { status: "inflight_skipped" };
      }

      const completedSuccessfully = await waitForInflightCompletion(inflight, inFlightTtlMs);
      if (completedSuccessfully === "timeout") {
        const activeInflight = processingDedupKeys.get(dedupKey);
        if (activeInflight === inflight) {
          const refreshedHeldMs = Date.now() - inflight.since;
          hooks?.onStaleInflightReleased?.({
            dedupKey,
            heldMs: refreshedHeldMs,
            ttlMs: inFlightTtlMs,
          });
          processingDedupKeys.delete(dedupKey);
        }
        continue;
      }
      if (completedSuccessfully && isMessageProcessed(dedupKey)) {
        hooks?.onDedupSkipped?.(dedupKey);
        return { status: "dedup_skipped" };
      }
      continue;
    }

    let settleInflight!: (succeeded: boolean) => void;
    const nextInflight: InflightEntry = {
      since: Date.now(),
      completion: new Promise<boolean>((resolve) => {
        settleInflight = resolve;
      }),
      settle: (succeeded: boolean) => settleInflight(succeeded),
    };
    processingDedupKeys.set(dedupKey, nextInflight);

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
      nextInflight.settle(true);
      return { status: "processed" };
    } catch (error) {
      nextInflight.settle(false);
      throw error;
    } finally {
      if (processingDedupKeys.get(dedupKey) === nextInflight) {
        processingDedupKeys.delete(dedupKey);
      }
    }
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
