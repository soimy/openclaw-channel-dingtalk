import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveActiveCardRunBySession } from "../card/card-run-registry";

export interface FindActiveAgentCardInput {
  cfg: OpenClawConfig;
  accountId: string;
  sessionKey: string;
}

export interface ActiveAgentCardLocation {
  outTrackId: string;
  sessionKey: string;
}

export function findActiveAgentCard(input: FindActiveAgentCardInput): ActiveAgentCardLocation | null {
  if (!input.sessionKey) {
    return null;
  }
  const record = resolveActiveCardRunBySession(input.accountId, input.sessionKey);
  if (!record) {
    return null;
  }
  return { outTrackId: record.outTrackId, sessionKey: record.sessionKey };
}
