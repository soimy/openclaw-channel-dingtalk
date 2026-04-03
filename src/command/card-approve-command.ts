import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getDingTalkRuntime } from "../runtime";
import type { DingTalkConfig, Logger } from "../types";
import { updateApprovalCardResolved, approvalCardStore } from "../approval-card-service";

/**
 * Resolve native command session targets for approval commands.
 *
 * Inlined from `openclaw/plugin-sdk/command-auth` because the CI openclaw
 * package does not yet export that sub-path. Same approach as card-stop-command.ts.
 */
function resolveNativeCommandSessionTargets(params: {
  agentId: string;
  sessionPrefix: string;
  userId: string;
  targetSessionKey: string;
}): { sessionKey: string; commandTargetSessionKey: string } {
  return {
    sessionKey: `agent:${params.agentId}:${params.sessionPrefix}:${params.userId}`,
    commandTargetSessionKey: params.targetSessionKey,
  };
}

/**
 * Dispatch a native targeted `/approve` command through the OpenClaw SDK,
 * using the same `CommandTargetSessionKey` + `CommandSource: "native"` model
 * as card-stop-command.ts.
 *
 * Inside the SDK, `handleApproveCommand` picks up the `/approve` body,
 * resolves the target session via `CommandTargetSessionKey`, and resolves
 * the pending exec or plugin approval.
 */
export async function dispatchDingTalkCardApproveCommand(params: {
  cfg: OpenClawConfig;
  config: DingTalkConfig;
  accountId: string;
  agentId: string;
  targetSessionKey: string;
  clickerUserId: string;
  approvalId: string;
  decision: "allow-once" | "allow-always" | "deny";
  log?: Logger;
}): Promise<{ ok: boolean }> {
  const rt = getDingTalkRuntime();

  const { sessionKey: commandSessionKey, commandTargetSessionKey } =
    resolveNativeCommandSessionTargets({
      agentId: params.agentId,
      sessionPrefix: "dingtalk:card-approve",
      userId: params.clickerUserId,
      targetSessionKey: params.targetSessionKey,
    });

  const commandBody = `/approve ${params.approvalId} ${params.decision}`;

  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: commandBody,
    RawBody: commandBody,
    CommandBody: commandBody,
    SessionKey: commandSessionKey,
    CommandTargetSessionKey: commandTargetSessionKey,
    CommandSource: "native" as const,
    CommandAuthorized: true,
    AccountId: params.accountId,
    Provider: "dingtalk",
    Surface: "dingtalk",
    ChatType: "direct",
    From: `dingtalk:card-approve:${params.clickerUserId}`,
    To: `card-approve:${params.clickerUserId}`,
    SenderId: params.clickerUserId,
    OriginatingChannel: "dingtalk",
  });

  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg: params.cfg,
    dispatcherOptions: {
      responsePrefix: "",
      deliver: async () => {
        // SDK approval confirmation text is swallowed here;
        // the card UI update handles resolved state independently.
      },
    },
  });

  // Update card UI (best-effort)
  const entry = approvalCardStore.get(params.approvalId);
  if (entry) {
    approvalCardStore.delete(params.approvalId);
    await updateApprovalCardResolved(params.config, entry.outTrackId, params.decision);
  }

  return { ok: true };
}
