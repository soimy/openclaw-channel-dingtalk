import { classifyAckReactionEmoji } from "../ack-reaction-classifier";
import { attachNativeAckReaction, recallNativeAckReactionWithRetry } from "../ack-reaction-service";
import { resolveAckReactionSetting } from "../config";
import type { DingTalkConfig, HandleDingTalkMessageParams } from "../types";

const MIN_THINKING_REACTION_VISIBLE_MS = 1200;

export function resolveInboundAckReaction(params: {
  cfg: HandleDingTalkMessageParams["cfg"];
  accountId: string;
  agentId: string;
  dingtalkConfig: DingTalkConfig;
  contentText: string;
}): string {
  const ackReaction =
    typeof params.dingtalkConfig.ackReaction === "string"
      ? params.dingtalkConfig.ackReaction.trim()
      : resolveAckReactionSetting({
          cfg: params.cfg,
          accountId: params.accountId,
          agentId: params.agentId,
        });
  return ackReaction === "emoji"
    ? classifyAckReactionEmoji(params.contentText).emoji
    : (ackReaction || "");
}

export async function runWithInboundAckReaction<T>(params: {
  cfg: HandleDingTalkMessageParams["cfg"];
  accountId: string;
  agentId: string;
  dingtalkConfig: DingTalkConfig;
  inboundText: string;
  msgId: string;
  conversationId: string;
  task: () => Promise<T>;
  log?: any;
}): Promise<T> {
  const resolvedAckReaction = resolveInboundAckReaction({
    cfg: params.cfg,
    accountId: params.accountId,
    agentId: params.agentId,
    dingtalkConfig: params.dingtalkConfig,
    contentText: params.inboundText,
  });
  const shouldAttachAckReaction = Boolean(resolvedAckReaction);
  let ackReactionAttached = false;
  let ackReactionAttachedAt = 0;

  if (shouldAttachAckReaction) {
    ackReactionAttached = await attachNativeAckReaction(
      params.dingtalkConfig,
      {
        msgId: params.msgId,
        conversationId: params.conversationId,
        reactionName: resolvedAckReaction,
      },
      params.log,
    );
    if (ackReactionAttached) {
      ackReactionAttachedAt = Date.now();
    }
  }

  try {
    return await params.task();
  } finally {
    if (ackReactionAttached) {
      const elapsedMs = ackReactionAttachedAt > 0 ? Date.now() - ackReactionAttachedAt : 0;
      const remainingVisibleMs = MIN_THINKING_REACTION_VISIBLE_MS - elapsedMs;
      if (remainingVisibleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingVisibleMs));
      }
      await recallNativeAckReactionWithRetry(
        params.dingtalkConfig,
        {
          msgId: params.msgId,
          conversationId: params.conversationId,
          reactionName: resolvedAckReaction,
        },
        params.log,
      );
    }
  }
}
