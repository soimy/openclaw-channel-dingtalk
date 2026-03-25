import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getDingTalkRuntime } from "../runtime";

export function resolveDeliveryStorePath(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): string | undefined {
  if (!params.accountId) {
    return undefined;
  }
  try {
    const rt = getDingTalkRuntime();
    return rt.channel.session.resolveStorePath(params.cfg.session?.store, {
      agentId: params.accountId,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "DingTalk runtime not initialized") {
      return undefined;
    }
    throw err;
  }
}
