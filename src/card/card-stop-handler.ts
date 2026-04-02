import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getAccessToken } from "../auth";
import { finishStoppedAICard, hideCardStopButton } from "../card-service";
import { dispatchDingTalkCardStopCommand } from "../command/card-stop-command";
import type { DingTalkConfig, ChannelLogSink } from "../types";
import { AICardStatus } from "../types";
import { markCardRunStopRequested, resolveCardRun } from "./card-run-registry";

export interface StopCardRunResult {
  ok: boolean;
  status: string;
  reason?: string;
  /** Last streamed content before stop, so callback response can preserve it. */
  lastContent?: string;
}

export async function stopCardRun(params: {
  cfg: OpenClawConfig;
  accountId: string;
  outTrackId: string;
  config?: DingTalkConfig;
  clickerUserId?: string;
  log?: ChannelLogSink;
}): Promise<StopCardRunResult> {
  const record = resolveCardRun(params.outTrackId);
  if (!record) {
    return { ok: false, status: "missing-run", reason: "No active card run registration found." };
  }

  if (record.stopRequestedAt || record.card?.state === AICardStatus.STOPPED) {
    return { ok: true, status: "already-stopped", lastContent: record.card?.lastStreamedContent };
  }

  const lastContent = record.card?.lastStreamedContent;

  markCardRunStopRequested(params.outTrackId);
  record.controller?.stop();

  // --- Phase 1: Abort agent execution via native /stop command ---
  // Dispatch FIRST so that the current run is guaranteed to still be active
  // on the session. If we finalized the card first, a new run could start on
  // the same sessionKey in the async gap.
  //
  // Only abort when this card is actively dispatching (has a controller).
  // Cards still queued behind session lock have no controller yet — the stop
  // guard in inbound-handler will skip dispatch when the lock is acquired.
  let nativeStopStatus: string | undefined;
  if (record.controller) {
    try {
      await dispatchDingTalkCardStopCommand({
        cfg: params.cfg,
        accountId: params.accountId,
        agentId: record.agentId,
        targetSessionKey: record.sessionKey,
        clickerUserId: params.clickerUserId ?? record.ownerUserId ?? "unknown",
        log: params.log,
      });
      nativeStopStatus = "stopped";
    } catch (error) {
      params.log?.warn?.(
        `[${params.accountId}] [DingTalk][CardStop] native stop dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      nativeStopStatus = "stopped-dispatch-error";
    }
  }

  // --- Phase 2: Finalize card via streaming API (isFinalize=true) ---
  if (record.card) {
    const stoppedContent = lastContent
      ? `${lastContent}\n\n---\n*⏹️ 已停止*`
      : "⏹️ 已停止";
    try {
      await finishStoppedAICard(record.card, stoppedContent, params.log);
    } catch (error) {
      params.log?.warn?.(
        `[${params.accountId}] [DingTalk][CardStop] failed to finalize stopped card: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // --- Phase 3: Hide stop button (with retry, consistent with finishAICard path) ---
  if (params.config) {
    try {
      const token = await getAccessToken(params.config, params.log);
      await hideCardStopButton(params.outTrackId, token, params.config);
    } catch (error) {
      params.log?.debug?.(
        `[${params.accountId}] [DingTalk][CardStop] non-critical: failed to hide stop button: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { ok: true, status: nativeStopStatus ?? "stopped-pending", lastContent };
}
