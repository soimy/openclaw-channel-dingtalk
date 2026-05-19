import type {
  ChannelApprovalNativeRuntimeAdapter,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { getAccessToken } from "../auth";
import {
  isActiveCardRun,
  resolveCardRun,
} from "../card/card-run-registry";
import { getConfig } from "../config";
import { getLogger } from "../logger-context";
import { sendProactiveTextOrMarkdown } from "../send-service";
import type { ApprovalDecision } from "../types";
import { findActiveAgentCard } from "./approval-card-locator";
import {
  applyExpiredPatch,
  applyPendingPatch,
  applyResolvedPatch,
} from "./approval-card-patcher";
import { getExecApprovalsConfig, listExecApprovers } from "./approval-config";
import {
  buildExecApprovalCardBody,
  buildExecApprovalMarkdown,
  buildPluginApprovalCardBody,
  buildPluginApprovalMarkdown,
} from "./approval-markdown-render";
import { normalizeApprovalTargetTo } from "./approval-target-resolver";

export type DingTalkApprovalPendingPayload = {
  approvalId: string;
  /** Markdown body used for the fallback markdown route (sendProactive). */
  markdownText: string;
  /** Friendly card-body markdown used for the v3-card route — overrides the
   *  upstream tool-result text the agent reply pipeline streamed in so the
   *  user sees a concise approval prompt above the native button group. */
  cardBodyMarkdown: string;
};

export type DingTalkApprovalPreparedTarget = {
  route: "card" | "markdown";
  to: string;
  accountId: string;
  activeCardOutTrackId?: string;
};

export type DingTalkApprovalEntry =
  | {
      mode: "card";
      approvalId: string;
      accountId: string;
      outTrackId: string;
    }
  | {
      mode: "markdown";
      approvalId: string;
      accountId: string;
    };

export type DingTalkApprovalFinalPayload =
  | { phase: "resolved"; decision: ApprovalDecision }
  | { phase: "expired" };

function isExplicitHttpFailure(error: unknown): boolean {
  const candidate = error as { status?: number; response?: { status?: number }; code?: string } | null;
  const status =
    typeof candidate?.status === "number" ? candidate.status : candidate?.response?.status;
  return (typeof status === "number" && status >= 400) || candidate?.code === "EBADREQ";
}

function shouldFallbackToMarkdown(error: unknown): boolean {
  return isExplicitHttpFailure(error);
}

function isSuccessfulSendResult(result: unknown): boolean {
  return !(
    result &&
    typeof result === "object" &&
    "ok" in result &&
    (result as { ok?: unknown }).ok === false
  );
}

export function createDingTalkApprovalNativeRuntime(): ChannelApprovalNativeRuntimeAdapter<
  DingTalkApprovalPendingPayload,
  DingTalkApprovalPreparedTarget,
  DingTalkApprovalEntry,
  unknown,
  DingTalkApprovalFinalPayload
> {
  return {
    eventKinds: ["exec", "plugin"],
    availability: {
      isConfigured: ({ cfg, accountId }) =>
        getExecApprovalsConfig({ cfg, accountId: accountId ?? "default" }).isNativeDeliveryEnabled,
      shouldHandle: ({ cfg, accountId, request }) => {
        const resolvedAccountId = accountId ?? "default";
        const log = getLogger(resolvedAccountId);
        const tsc = request.request.turnSourceChannel;
        const tst = request.request.turnSourceTo;
        const reqId = request.id;
        if (!getExecApprovalsConfig({ cfg, accountId: resolvedAccountId }).isNativeDeliveryEnabled) {
          log?.info?.(
            `[DingTalk][Approval][shouldHandle] skip approval=${reqId} reason=native-delivery-disabled account=${resolvedAccountId}`,
          );
          return false;
        }
        if (tsc !== "dingtalk") {
          log?.info?.(
            `[DingTalk][Approval][shouldHandle] skip approval=${reqId} reason=turnSourceChannel-mismatch got=${String(tsc)}`,
          );
          return false;
        }
        if (!tst) {
          log?.info?.(
            `[DingTalk][Approval][shouldHandle] skip approval=${reqId} reason=missing-turnSourceTo`,
          );
          return false;
        }
        const approvers = listExecApprovers({ cfg, accountId: resolvedAccountId }).length;
        if (approvers === 0) {
          log?.info?.(
            `[DingTalk][Approval][shouldHandle] skip approval=${reqId} reason=no-approvers account=${resolvedAccountId}`,
          );
          return false;
        }
        log?.info?.(
          `[DingTalk][Approval][shouldHandle] accept approval=${reqId} account=${resolvedAccountId} approvers=${approvers}`,
        );
        return true;
      },
    },
    presentation: {
      buildPendingPayload: ({ request, approvalKind, nowMs }) => {
        getLogger()?.info?.(
          `[DingTalk][Approval][buildPendingPayload] approval=${request.id} kind=${approvalKind}`,
        );
        if (approvalKind === "plugin") {
          return {
            approvalId: request.id,
            markdownText: buildPluginApprovalMarkdown(request as never, nowMs),
            cardBodyMarkdown: buildPluginApprovalCardBody(request as never, nowMs),
          };
        }
        return {
          approvalId: request.id,
          markdownText: buildExecApprovalMarkdown(request as never, nowMs),
          cardBodyMarkdown: buildExecApprovalCardBody(request as never, nowMs),
        };
      },
      buildResolvedResult: ({ resolved }) => ({
        kind: "update",
        payload: { phase: "resolved", decision: resolved.decision },
      }),
      buildExpiredResult: () => ({
        kind: "update",
        payload: { phase: "expired" },
      }),
    },
    transport: {
      prepareTarget: ({ cfg, accountId, plannedTarget, request }) => {
        const target = plannedTarget.target as { to: string; accountId?: string | null };
        const resolvedAccountId =
          target.accountId ?? accountId ?? request.request.turnSourceAccountId ?? "default";
        const log = getLogger(resolvedAccountId);
        const to = normalizeApprovalTargetTo(target.to);
        const activeCard = findActiveAgentCard({
          cfg,
          accountId: resolvedAccountId,
          sessionKey: request.request.sessionKey ?? "",
          approvalId: request.id,
        });
        if (activeCard) {
          log?.info?.(
            `[DingTalk][Approval][prepareTarget] route=card approval=${request.id} account=${resolvedAccountId} to=${to} outTrackId=${activeCard.outTrackId}`,
          );
          return {
            dedupeKey: `dingtalk:${resolvedAccountId}:${to}:${activeCard.outTrackId}:${request.id}`,
            target: {
              route: "card",
              to,
              accountId: resolvedAccountId,
              activeCardOutTrackId: activeCard.outTrackId,
            },
          };
        }
        log?.info?.(
          `[DingTalk][Approval][prepareTarget] route=markdown approval=${request.id} account=${resolvedAccountId} to=${to} reason=no-active-card sessionKey=${request.request.sessionKey ?? "<empty>"}`,
        );
        return {
          dedupeKey: `dingtalk:${resolvedAccountId}:${to}:markdown:${request.id}`,
          target: {
            route: "markdown",
            to,
            accountId: resolvedAccountId,
          },
        };
      },
      deliverPending: async ({ cfg, preparedTarget, pendingPayload }) => {
        const dtConfig = getConfig(cfg, preparedTarget.accountId);
        const log = getLogger(preparedTarget.accountId);
        if (preparedTarget.route === "card" && preparedTarget.activeCardOutTrackId) {
          const token = await getAccessToken(dtConfig, log);
          try {
            await applyPendingPatch(
              preparedTarget.activeCardOutTrackId,
              pendingPayload.approvalId,
              token,
              dtConfig,
              pendingPayload.cardBodyMarkdown,
            );
            return {
              mode: "card",
              approvalId: pendingPayload.approvalId,
              accountId: preparedTarget.accountId,
              outTrackId: preparedTarget.activeCardOutTrackId,
            };
          } catch (error) {
            if (!shouldFallbackToMarkdown(error)) {
              return null;
            }
          }
        }

        const sent = await sendProactiveTextOrMarkdown(
          dtConfig,
          preparedTarget.to,
          pendingPayload.markdownText,
          { forceMarkdown: true, accountId: preparedTarget.accountId, log },
        );
        if (!isSuccessfulSendResult(sent)) {
          return null;
        }
        return {
          mode: "markdown",
          approvalId: pendingPayload.approvalId,
          accountId: preparedTarget.accountId,
        };
      },
      updateEntry: async ({ cfg, entry, payload, phase }) => {
        if (entry.mode !== "card") {
          return;
        }
        const dtConfig = getConfig(cfg, entry.accountId);
        const log = getLogger(entry.accountId);
        const token = await getAccessToken(dtConfig, log);
        const record = resolveCardRun(entry.outTrackId);
        const cardStillActive = record ? isActiveCardRun(record) : false;
        if (phase === "resolved" && payload.phase === "resolved") {
          await applyResolvedPatch(
            entry.outTrackId,
            payload.decision,
            token,
            cardStillActive,
            dtConfig,
          );
          return;
        }
        await applyExpiredPatch(entry.outTrackId, token, cardStillActive, dtConfig);
      },
    },
    observe: {
      onDelivered: ({ accountId, entry, request }) => {
        getLogger(accountId)?.info?.(
          `[DingTalk][Approval] delivered approval=${request.id} mode=${(entry as DingTalkApprovalEntry).mode}`,
        );
      },
      onDeliveryError: ({ accountId, error, request }) => {
        getLogger(accountId)?.warn?.(
          `[DingTalk][Approval][DeliveryError] approval=${request.id} error=${String(error)}`,
        );
      },
    },
  };
}
