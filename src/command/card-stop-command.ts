import { resolveNativeCommandSessionTargets } from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getDingTalkRuntime } from "../runtime";
import type { Logger } from "../types";

/**
 * Dispatch a native targeted `/stop` command through the OpenClaw SDK,
 * replacing the previous self-built Gateway WebSocket `chat.abort` approach.
 *
 * Uses the same `resolveNativeCommandSessionTargets` + `CommandSource: "native"`
 * model as Telegram / Discord / Slack slash commands, producing:
 *   - A dedicated command SessionKey (`agent:<agentId>:dingtalk:card-stop:<userId>`)
 *   - A CommandTargetSessionKey pointing at the real conversation session
 *
 * Inside the SDK, `dispatch-from-config` → `tryFastAbortFromMessage` picks up
 * the `/stop` body, resolves the target session via `CommandTargetSessionKey`,
 * and executes `abortEmbeddedPiRun` + `clearSessionQueues`.
 *
 * Accesses SDK functions via `getDingTalkRuntime().channel.reply` — the same
 * pattern used by `inbound-handler.ts` — while reusing the upstream native
 * command session-target helper exported by the plugin SDK.
 */
export async function dispatchDingTalkCardStopCommand(params: {
  cfg: OpenClawConfig;
  accountId: string;
  agentId: string;
  targetSessionKey: string;
  clickerUserId: string;
  log?: Logger;
}): Promise<{ ok: boolean }> {
  const rt = getDingTalkRuntime();

  const { sessionKey: commandSessionKey, commandTargetSessionKey } =
    resolveNativeCommandSessionTargets({
      agentId: params.agentId,
      sessionPrefix: "dingtalk:card-stop",
      userId: params.clickerUserId,
      targetSessionKey: params.targetSessionKey,
    });

  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: "/stop",
    RawBody: "/stop",
    CommandBody: "/stop",
    SessionKey: commandSessionKey,
    CommandTargetSessionKey: commandTargetSessionKey,
    CommandSource: "native" as const,
    CommandAuthorized: true,
    AccountId: params.accountId,
    Provider: "dingtalk",
    Surface: "dingtalk",
    // "direct" because the synthetic /stop body contains no @mentions to strip.
    // The actual chat type of the target session is irrelevant for abort routing.
    ChatType: "direct",
    From: `dingtalk:card-stop:${params.clickerUserId}`,
    To: `card-stop:${params.clickerUserId}`,
    SenderId: params.clickerUserId,
    OriginatingChannel: "dingtalk",
  });

  // DispatchInboundResult = { queuedFinal, counts } — the return value does
  // not expose whether tryFastAbortFromMessage took the fast-abort path.
  // Treat successful dispatch as best-effort abort, consistent with the
  // previous gateway chat.abort approach.
  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg: params.cfg,
    dispatcherOptions: {
      responsePrefix: "",
      deliver: async () => {
        // SDK abort confirmation text is swallowed here; the card
        // finalize path handles stopped content independently.
      },
    },
  });

  return { ok: true };
}
