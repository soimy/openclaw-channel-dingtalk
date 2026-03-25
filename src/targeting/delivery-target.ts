import { stripTargetPrefix } from "../config";
import { resolveOriginalPeerId } from "../peer-id-registry";
import { resolveKnownConversationChatType } from "./target-directory-store";
import type { Logger } from "../types";

export interface ResolvedDingTalkDeliveryTarget {
  apiTarget: string;
  conversationId: string;
  chatType: "direct" | "group";
}

function normalizeScopedConversationId(raw: string): string {
  return resolveOriginalPeerId(stripTargetPrefix(raw).targetId);
}

export function normalizeExplicitChatType(raw: unknown): "direct" | "group" | undefined {
  if (raw == null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new Error(`chatType must be a string when provided; received ${typeof raw}`);
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "direct" || normalized === "dm") {
    return "direct";
  }
  if (normalized === "group") {
    return "group";
  }
  throw new Error(`Unsupported chatType "${raw}". Use "direct" or "group".`);
}

export function resolveDingTalkDeliveryTarget(params: {
  target: string;
  conversationId?: string;
  explicitChatType?: "direct" | "group";
  storePath?: string;
  accountId?: string;
  log?: Logger;
}): ResolvedDingTalkDeliveryTarget {
  const parsedTarget = stripTargetPrefix(params.target);
  const apiTarget = resolveOriginalPeerId(parsedTarget.targetId);
  const conversationId = normalizeScopedConversationId(params.conversationId?.trim() || apiTarget);
  const chatType =
    params.explicitChatType ||
    parsedTarget.explicitChatType ||
    (params.storePath && params.accountId
      ? resolveKnownConversationChatType({
          storePath: params.storePath,
          accountId: params.accountId,
          conversationId,
        })
      : undefined);

  if (!chatType) {
    throw new Error(
      `Unable to determine DingTalk chatType for target ${apiTarget}; use user:/group: prefix or pass chatType explicitly.`,
    );
  }

  return {
    apiTarget,
    conversationId,
    chatType,
  };
}
