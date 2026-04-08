import { randomUUID } from "node:crypto";
import axios from "axios";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { getAccessToken } from "../auth";
import {
  buildExecApprovalCardParamMap,
  buildPluginApprovalCardParamMap,
} from "../approval-card-service";
import { getConfig } from "../config";
import { getLogger } from "../logger-context";
import { resolveOriginalPeerId } from "../peer-id-registry";
import type { DingTalkConfig } from "../types";
import { getProxyBypassOption } from "../utils";

const DINGTALK_API = "https://api.dingtalk.com";
const APPROVAL_CARD_TEMPLATE_ID = "bd04e9b9-832c-42b9-9d4f-a8361acebc09.schema";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

/** Payload built by presentation and consumed by transport. */
export type DingTalkApprovalPendingPayload = {
  outTrackId: string;
  cardParamMap: Record<string, string>;
  content: string;
};

/** Target prepared from the delivery plan, carrying DingTalk-specific routing info. */
export type DingTalkApprovalPreparedTarget = {
  conversationId: string;
  isGroup: boolean;
  accountId: string | null;
};

/** Entry persisted by core between pending delivery and final update. */
export type DingTalkApprovalPendingEntry = {
  approvalId: string;
  outTrackId: string;
  conversationId: string;
  accountId: string | null;
};

/** Final payload passed to updateEntry when the approval is resolved or expired. */
export type DingTalkApprovalFinalPayload = {
  phase: "resolved" | "expired";
  decision?: "allow-once" | "allow-always" | "deny";
};

function resolveDingTalkConfig(
  cfg: unknown,
  accountId: string | null | undefined,
): DingTalkConfig {
  return getConfig(cfg as never, accountId ?? undefined);
}

async function createApprovalCard(
  config: DingTalkConfig,
  conversationId: string,
  isGroup: boolean,
  payload: DingTalkApprovalPendingPayload,
): Promise<{ ok: boolean; effectiveOutTrackId: string; error?: string }> {
  const log = getLogger();
  try {
    const token = await getAccessToken(config, log);
    const { content, ...buttonParamMap } = payload.cardParamMap;
    const enrichedParamMap = {
      ...buttonParamMap,
      config: JSON.stringify({ autoLayout: true, enableForward: false }),
    };
    const body = {
      cardTemplateId: APPROVAL_CARD_TEMPLATE_ID,
      outTrackId: payload.outTrackId,
      cardData: { cardParamMap: enrichedParamMap },
      callbackType: "STREAM",
      imGroupOpenSpaceModel: { supportForward: false },
      imRobotOpenSpaceModel: { supportForward: false },
      openSpaceId: isGroup
        ? `dtv1.card//IM_GROUP.${conversationId}`
        : `dtv1.card//IM_ROBOT.${conversationId}`,
      userIdType: 1,
      imGroupOpenDeliverModel: isGroup
        ? { robotCode: config.clientId, extension: { dynamicSummary: "true" } }
        : undefined,
      imRobotOpenDeliverModel: !isGroup
        ? {
            spaceType: "IM_ROBOT",
            robotCode: config.clientId,
            extension: { dynamicSummary: "true" },
          }
        : undefined,
    };
    log?.info?.(
      `[DingTalk][ApprovalCard] POST createAndDeliver outTrackId=${payload.outTrackId}`,
    );
    const createResp = await axios.post(
      `${DINGTALK_API}/v1.0/card/instances/createAndDeliver`,
      body,
      {
        headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
        ...getProxyBypassOption(config),
      },
    );
    const respData = createResp.data as
      | { result?: { outTrackId?: string }; outTrackId?: string }
      | undefined;
    const effectiveOutTrackId =
      (typeof respData?.result?.outTrackId === "string" && respData.result.outTrackId) ||
      (typeof respData?.outTrackId === "string" && respData.outTrackId) ||
      payload.outTrackId;
    if (content) {
      await axios.put(
        `${DINGTALK_API}/v1.0/card/streaming`,
        {
          outTrackId: effectiveOutTrackId,
          guid: randomUUID(),
          key: "content",
          content,
          isFull: true,
          isFinalize: true,
        },
        {
          headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
          ...getProxyBypassOption(config),
        },
      );
    }
    return { ok: true, effectiveOutTrackId };
  } catch (err: unknown) {
    const message = (err as Error).message;
    log?.error?.(`[DingTalk][ApprovalCard] Card creation failed: ${message}`);
    return { ok: false, effectiveOutTrackId: payload.outTrackId, error: message };
  }
}

async function updateApprovalCardFinal(
  config: DingTalkConfig,
  outTrackId: string,
  finalPayload: DingTalkApprovalFinalPayload,
): Promise<void> {
  const log = getLogger();
  const resolvedText =
    finalPayload.phase === "expired"
      ? "⏱️ 已过期"
      : finalPayload.decision === "allow-once"
        ? "✅ 已允许（单次）"
        : finalPayload.decision === "allow-always"
          ? "✅ 已加入白名单"
          : finalPayload.decision === "deny"
            ? "❌ 已拒绝"
            : "—";
  try {
    const token = await getAccessToken(config, log);
    await axios.put(
      `${DINGTALK_API}/v1.0/card/instances`,
      {
        outTrackId,
        cardData: {
          cardParamMap: {
            status: resolvedText,
            btns: JSON.stringify([]),
            hasAction: "false",
          },
        },
        cardUpdateOptions: { updateCardDataByKey: true, updatePrivateDataByKey: true },
      },
      {
        headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
        ...getProxyBypassOption(config),
      },
    );
    log?.info?.(
      `[DingTalk][ApprovalCard] Card updated to ${resolvedText} outTrackId=${outTrackId}`,
    );
  } catch (err: unknown) {
    log?.warn?.(
      `[DingTalk][ApprovalCard] Card update failed (non-critical): ${(err as Error).message}`,
    );
  }
}

function buildCardPayload(
  request: ApprovalRequest,
  approvalKind: "exec" | "plugin",
  nowMs: number,
): DingTalkApprovalPendingPayload {
  const cardParamMap =
    approvalKind === "exec"
      ? buildExecApprovalCardParamMap(request as ExecApprovalRequest, nowMs)
      : buildPluginApprovalCardParamMap(request as PluginApprovalRequest, nowMs);
  return {
    outTrackId: `approval_${randomUUID()}`,
    cardParamMap,
    content: cardParamMap.content ?? "",
  };
}

/**
 * DingTalk 审批 native runtime adapter.
 *
 * 调用流：
 *   core → availability.shouldHandle → presentation.buildPendingPayload
 *        → transport.prepareTarget → transport.deliverPending
 *        → (later) presentation.buildResolvedResult → transport.updateEntry
 *
 * DingTalk 特性：仅支持 origin 投递（审批卡片发到 agent 所在会话），
 * 不走 approver DM 分发。按钮回调走 card-callback-service → resolveApprovalOverGateway。
 */
export const dingtalkApprovalNativeRuntimeAdapter = createChannelApprovalNativeRuntimeAdapter<
  DingTalkApprovalPendingPayload,
  DingTalkApprovalPreparedTarget,
  DingTalkApprovalPendingEntry,
  unknown,
  DingTalkApprovalFinalPayload
>({
  eventKinds: ["exec", "plugin"],

  availability: {
    isConfigured: ({ cfg, accountId }) => {
      try {
        return Boolean(resolveDingTalkConfig(cfg, accountId));
      } catch {
        return false;
      }
    },
    shouldHandle: ({ request }) => {
      const source = (request.request.turnSourceChannel ?? "").toString().toLowerCase();
      return source === "dingtalk";
    },
  },

  presentation: {
    buildPendingPayload: ({ request, approvalKind, nowMs }) =>
      buildCardPayload(request, approvalKind, nowMs),

    buildResolvedResult: ({ view }) => ({
      kind: "update",
      payload: {
        phase: "resolved",
        decision: view.decision,
      },
    }),

    buildExpiredResult: () => ({
      kind: "update",
      payload: { phase: "expired" },
    }),
  },

  transport: {
    prepareTarget: ({ plannedTarget, accountId }) => {
      const rawTo = plannedTarget.target.to;
      if (!rawTo) {
        return null;
      }
      // turnSourceTo from DingTalk inbound-handler is raw (cid... for groups, userId for direct).
      // resolveOriginalPeerId is a no-op for already-canonical ids; defensive only.
      const conversationId = resolveOriginalPeerId(rawTo);
      const isGroup = conversationId.startsWith("cid");
      return {
        dedupeKey: `dingtalk:${conversationId}`,
        target: {
          conversationId,
          isGroup,
          accountId: accountId ?? null,
        },
      };
    },

    deliverPending: async ({ cfg, accountId, preparedTarget, request, pendingPayload }) => {
      const config = resolveDingTalkConfig(cfg, accountId);
      const result = await createApprovalCard(
        config,
        preparedTarget.conversationId,
        preparedTarget.isGroup,
        pendingPayload,
      );
      if (!result.ok) {
        return null;
      }
      return {
        approvalId: request.id,
        outTrackId: result.effectiveOutTrackId,
        conversationId: preparedTarget.conversationId,
        accountId: preparedTarget.accountId,
      };
    },

    updateEntry: async ({ cfg, accountId, entry, payload }) => {
      const config = resolveDingTalkConfig(cfg, accountId ?? entry.accountId);
      await updateApprovalCardFinal(config, entry.outTrackId, payload);
    },
  },

  observe: {
    onDelivered: ({ entry, request }) => {
      getLogger()?.info?.(
        `[DingTalk][ApprovalCard] delivered approval=${request.id} outTrackId=${entry.outTrackId}`,
      );
    },
    onDeliveryError: ({ request, error }) => {
      getLogger()?.warn?.(
        `[DingTalk][ApprovalCard] delivery error approval=${request.id} error=${String(error)}`,
      );
    },
  },
});
