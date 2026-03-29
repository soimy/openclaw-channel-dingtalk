import { attachNativeAckReaction, recallNativeAckReactionWithRetry } from "../ack-reaction-service";
import type { DingTalkConfig } from "../types";
import { getErrorMessage } from "../utils";
import {
  createDynamicAckReactionCorrelator,
  describeEvent,
  type DynamicAckReactionLogger,
  type RuntimeAgentEvent,
  type RuntimeEventsSurface,
} from "./dynamic-ack-reaction-events";
import { resolveToolProgressReaction } from "./dynamic-ack-reaction-progress";

type DynamicAckReactionControllerParams = {
  enabled: boolean;
  initialReaction: string;
  initialAttached: boolean;
  initialAttachedAt: number;
  dingtalkConfig: DingTalkConfig;
  msgId: string;
  conversationId: string;
  sessionKey: string;
  log?: DynamicAckReactionLogger;
  runtimeEvents?: RuntimeEventsSurface;
  onReactionDisposed?: () => void;
};

const TOOL_REACTION_SILENCE_MS = 55_000;
const TOOL_REACTION_HEARTBEAT_INTERVAL_MS = 60_000;
const DYNAMIC_REACTION_MIN_SWITCH_INTERVAL_MS = 5_000;
const OPTIMISTIC_RUN_ID_CAPTURE_WINDOW_MS = 5_000;
const TOOL_HEARTBEAT_REACTION = "⏳";

export function createDynamicAckReactionController(params: DynamicAckReactionControllerParams) {
  let dynamicReactionStartedAt = 0;
  let lastDynamicReactionAt = 0;
  let currentAckReaction = params.initialReaction;
  let ackReactionAttached = params.initialAttached;
  let ackReactionAttachedAt = params.initialAttachedAt;
  let progressHeartbeatInFlight = false;
  let progressHeartbeatTimer: NodeJS.Timeout | undefined;
  let dynamicReactionUpdatePromise: Promise<void> = Promise.resolve();
  let lastDynamicReactionSwitchAt = 0;
  let disposed = false;
  const createdAt = Date.now();
  const isCorrelatedEvent = createDynamicAckReactionCorrelator({
    sessionKey: params.sessionKey,
    enabled: params.enabled,
    createdAt,
    optimisticCaptureWindowMs: OPTIMISTIC_RUN_ID_CAPTURE_WINDOW_MS,
    log: params.log,
  });

  const updateDynamicAckReaction = async (nextReaction: string) => {
    const normalizedReaction = typeof nextReaction === "string" ? nextReaction.trim() : "";
    if (disposed || !normalizedReaction || !params.enabled || !ackReactionAttached) {
      params.log?.debug?.(
        `[DingTalk] Dynamic ack reaction update skipped reaction=${normalizedReaction || "-"} ` +
        `enabled=${params.enabled} ackReactionAttached=${ackReactionAttached} disposed=${disposed}`,
      );
      return;
    }
    if (normalizedReaction === currentAckReaction) {
      params.log?.debug?.(
        `[DingTalk] Dynamic ack reaction update skipped because reaction is unchanged: ${normalizedReaction}`,
      );
      if (dynamicReactionStartedAt === 0) {
        dynamicReactionStartedAt = Date.now();
      }
      lastDynamicReactionAt = Date.now();
      return;
    }
    if (
      lastDynamicReactionSwitchAt > 0
      && Date.now() - lastDynamicReactionSwitchAt < DYNAMIC_REACTION_MIN_SWITCH_INTERVAL_MS
    ) {
      params.log?.debug?.(
        `[DingTalk] Dynamic ack reaction update throttled previous=${currentAckReaction} next=${normalizedReaction} ` +
        `minIntervalMs=${DYNAMIC_REACTION_MIN_SWITCH_INTERVAL_MS}`,
      );
      return;
    }

    const previousReaction = currentAckReaction;
    ackReactionAttached = false;
    await recallNativeAckReactionWithRetry(
      params.dingtalkConfig,
      {
        msgId: params.msgId,
        conversationId: params.conversationId,
        reactionName: previousReaction,
      },
      params.log,
    );

    const attached = await attachNativeAckReaction(
      params.dingtalkConfig,
      {
        msgId: params.msgId,
        conversationId: params.conversationId,
        reactionName: normalizedReaction,
      },
      params.log,
    );
    if (!attached) {
      if (disposed) {
        return;
      }
      params.log?.debug?.(
        `[DingTalk] Dynamic ack reaction attach did not succeed for reaction=${normalizedReaction}; restoring previous reaction=${previousReaction}`,
      );
      const restored = await attachNativeAckReaction(
        params.dingtalkConfig,
        {
          msgId: params.msgId,
          conversationId: params.conversationId,
          reactionName: previousReaction,
        },
        params.log,
      );
      ackReactionAttached = restored;
      if (restored) {
        currentAckReaction = previousReaction;
        ackReactionAttachedAt = Date.now();
        if (dynamicReactionStartedAt === 0) {
          dynamicReactionStartedAt = ackReactionAttachedAt;
        }
        lastDynamicReactionAt = ackReactionAttachedAt;
      }
      return;
    }

    params.log?.debug?.(`[DingTalk] Dynamic ack reaction switched to ${normalizedReaction}`);
    ackReactionAttached = true;
    currentAckReaction = normalizedReaction;
    ackReactionAttachedAt = Date.now();
    lastDynamicReactionSwitchAt = ackReactionAttachedAt;
    if (dynamicReactionStartedAt === 0) {
      dynamicReactionStartedAt = ackReactionAttachedAt;
    }
    lastDynamicReactionAt = ackReactionAttachedAt;
  };

  const queueDynamicAckReactionUpdate = (nextReaction: string) => {
    if (disposed) {
      return dynamicReactionUpdatePromise;
    }
    params.log?.debug?.(
      `[DingTalk] Queue dynamic ack reaction update ${currentAckReaction || "-"} -> ${nextReaction || "-"}`,
    );
    dynamicReactionUpdatePromise = dynamicReactionUpdatePromise
      .then(() => updateDynamicAckReaction(nextReaction))
      .catch((err: unknown) => {
        params.log?.warn?.(`[DingTalk] Dynamic ack reaction update failed: ${getErrorMessage(err)}`);
      });
    return dynamicReactionUpdatePromise;
  };

  const handleAgentEvent = async (event: unknown) => {
    const agentEvent = event as RuntimeAgentEvent | undefined;
    if (!params.enabled || disposed) {
      return;
    }
    params.log?.debug?.(`[DingTalk] Dynamic reaction observed agent event ${describeEvent(agentEvent)}`);
    if (agentEvent?.stream === "lifecycle" && agentEvent.data?.phase === "start") {
      void isCorrelatedEvent(agentEvent);
      return;
    }
    if (agentEvent?.stream !== "tool" || agentEvent.data?.phase !== "start") {
      return;
    }
    if (!isCorrelatedEvent(agentEvent)) {
      params.log?.debug?.(
        `[DingTalk] Dynamic reaction ignored uncorrelated tool event ${describeEvent(agentEvent)}`,
      );
      return;
    }
    const toolCallId = typeof agentEvent.data?.toolCallId === "string" ? agentEvent.data.toolCallId : "-";
    params.log?.debug?.(
      `[DingTalk] Tool event received for dynamic ack reaction: name=${agentEvent.data?.name || "-"} toolCallId=${toolCallId}`,
    );
    await queueDynamicAckReactionUpdate(
      resolveToolProgressReaction(agentEvent.data?.name, agentEvent.data?.args),
    );
  };

  const unsubscribeAgentEvents = params.enabled && params.runtimeEvents?.onAgentEvent
    ? params.runtimeEvents.onAgentEvent((event: unknown) => {
        void handleAgentEvent(event).catch((err: unknown) => {
          params.log?.warn?.(`[DingTalk] Dynamic ack reaction event handling failed: ${getErrorMessage(err)}`);
        });
      })
    : () => {};

  if (params.enabled && !params.runtimeEvents?.onAgentEvent) {
    params.log?.debug?.("[DingTalk] onAgentEvent not available, dynamic reaction tracking disabled");
  }

  if (params.enabled) {
    progressHeartbeatTimer = setInterval(() => {
      if (
        disposed
        || !ackReactionAttached
        || progressHeartbeatInFlight
        || dynamicReactionStartedAt === 0
        || lastDynamicReactionAt === 0
      ) {
        return;
      }
      if (Date.now() - lastDynamicReactionAt < TOOL_REACTION_SILENCE_MS) {
        return;
      }
      params.log?.debug?.(
        `[DingTalk] Dynamic ack reaction heartbeat triggered currentReaction=${currentAckReaction} ` +
        `lastDynamicReactionAt=${lastDynamicReactionAt}`,
      );
      progressHeartbeatInFlight = true;
      void queueDynamicAckReactionUpdate(TOOL_HEARTBEAT_REACTION).finally(() => {
        progressHeartbeatInFlight = false;
      });
    }, TOOL_REACTION_HEARTBEAT_INTERVAL_MS);
  }

  const stop = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribeAgentEvents();
    if (progressHeartbeatTimer) {
      clearInterval(progressHeartbeatTimer);
      progressHeartbeatTimer = undefined;
    }
  };

  return {
    async awaitDrain(): Promise<void> {
      await dynamicReactionUpdatePromise.catch(() => undefined);
    },
    async dispose(minVisibleMs: number): Promise<void> {
      stop();
      await this.awaitDrain();
      if (!ackReactionAttached) {
        params.onReactionDisposed?.();
        return;
      }
      try {
        const shouldRespectMinVisible = params.enabled && dynamicReactionStartedAt > 0;
        const elapsedMs = ackReactionAttachedAt > 0 ? Date.now() - ackReactionAttachedAt : 0;
        const remainingVisibleMs = shouldRespectMinVisible ? minVisibleMs - elapsedMs : 0;
        if (remainingVisibleMs > 0) {
          await new Promise(resolve => setTimeout(resolve, remainingVisibleMs));
        }
        await recallNativeAckReactionWithRetry(
          params.dingtalkConfig,
          {
            msgId: params.msgId,
            conversationId: params.conversationId,
            reactionName: currentAckReaction,
          },
          params.log,
        );
      } catch (err: unknown) {
        params.log?.warn?.(`[DingTalk] Dynamic ack reaction dispose recall failed: ${getErrorMessage(err)}`);
      } finally {
        ackReactionAttached = false;
        params.onReactionDisposed?.();
      }
    },
    stop,
  };
}
