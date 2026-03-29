import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { CardCallbackAnalysis } from "../card-callback-service";
import type { DingTalkConfig, Logger } from "../types";
import { resolveCardRun } from "./card-run-registry";
import { stopCardRun } from "./card-stop-handler";

export interface CardActionResult {
  handled: boolean;
}

export async function handleCardAction(params: {
  analysis: CardCallbackAnalysis;
  cfg: OpenClawConfig;
  accountId: string;
  config: DingTalkConfig;
  log?: Logger;
}): Promise<CardActionResult> {
  if (params.analysis.actionId !== "btn_stop") {
    return { handled: false };
  }

  const outTrackId = params.analysis.outTrackId;
  if (!outTrackId) {
    params.log?.warn?.(
      `[${params.accountId}] [DingTalk][CardStop] stop callback missing outTrackId — cannot route stop request`,
    );
    return { handled: false };
  }

  // In group chats, only the user who initiated the conversation can stop it.
  const clickerUserId = params.analysis.userId;
  const record = resolveCardRun(outTrackId);
  if (record?.ownerUserId && clickerUserId && record.ownerUserId !== clickerUserId) {
    params.log?.info?.(
      `[${params.accountId}] [DingTalk][CardStop] ignored: clicker=${clickerUserId} is not owner=${record.ownerUserId}`,
    );
    return { handled: true };
  }

  const result = await stopCardRun({
    cfg: params.cfg,
    accountId: params.accountId,
    outTrackId,
    config: params.config,
    clickerUserId,
    log: params.log,
  });
  if (!result.ok) {
    params.log?.warn?.(
      `[${params.accountId}] [DingTalk][CardStop] stop failed status=${result.status} reason=${result.reason ?? "unknown"}`,
    );
  } else {
    params.log?.info?.(
      `[${params.accountId}] [DingTalk][CardStop] stop succeeded outTrackId=${outTrackId}`,
    );
  }

  return { handled: true };
}
