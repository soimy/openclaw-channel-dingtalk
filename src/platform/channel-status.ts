import { getAccessToken } from "../auth";
import type { DingTalkChannelPlugin } from "../types";
import { getCurrentTimestamp } from "../utils";

export function createDingTalkStatus(): NonNullable<DingTalkChannelPlugin["status"]> {
  return {
    defaultRuntime: {
      accountId: "default",
      running: false,
      connected: false,
      lastEventAt: null,
      lastConnectedAt: null,
      lastInboundAt: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts: any[]) => {
      return accounts.flatMap((account) => {
        if (!account.configured) {
          return [
            {
              channel: "dingtalk",
              accountId: account.accountId,
              kind: "config" as const,
              message: "Account not configured (missing clientId or clientSecret)",
            },
          ];
        }
        return [];
      });
    },
    buildChannelSummary: ({ snapshot }: any) => ({
      configured: snapshot?.configured ?? false,
      running: snapshot?.running ?? false,
      lastStartAt: snapshot?.lastStartAt ?? null,
      lastStopAt: snapshot?.lastStopAt ?? null,
      lastError: snapshot?.lastError ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }: any) => {
      if (!account.configured || !account.config?.clientId || !account.config?.clientSecret) {
        return { ok: false, error: "Not configured" };
      }
      try {
        const controller = new AbortController();
        const timeoutId = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
        try {
          await getAccessToken(account.config);
          return { ok: true, details: { clientId: account.config.clientId } };
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        }
      } catch (error: any) {
        return { ok: false, error: error.message };
      }
    },
    buildAccountSnapshot: ({ account, runtime, snapshot, probe }: any) => {
      const running = runtime?.running ?? snapshot?.running ?? false;
      const persistedLastEventAt = runtime?.lastEventAt ?? snapshot?.lastEventAt ?? null;

      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        clientId: account.config?.clientId ?? null,
        running,
        connected: runtime?.connected ?? snapshot?.connected ?? null,
        lastEventAt: running ? getCurrentTimestamp() : persistedLastEventAt,
        lastConnectedAt: runtime?.lastConnectedAt ?? snapshot?.lastConnectedAt ?? null,
        lastInboundAt: runtime?.lastInboundAt ?? snapshot?.lastInboundAt ?? null,
        lastStartAt: runtime?.lastStartAt ?? snapshot?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? snapshot?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? snapshot?.lastError ?? null,
        probe,
      };
    },
  };
}
