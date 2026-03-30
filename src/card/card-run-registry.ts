/**
 * In-process card run registry for tracking active AI card runs.
 *
 * DEPLOYMENT CONSTRAINT: This registry uses a process-local Map. In multi-process
 * deployments (cluster/PM2), stop callbacks may route to a different worker than
 * the one that created the card run, causing resolveCardRun to return null and
 * the stop button to silently fail. Ensure single-process deployment or sticky
 * routing per card callback when using the stop button feature.
 */
import type { CardDraftController } from "../card-draft-controller";
import type { AICardInstance } from "../types";

export interface CardRunRecord {
  outTrackId: string;
  accountId: string;
  sessionKey: string;
  /** OpenClaw agent ID resolved from the inbound route. */
  agentId: string;
  /** DingTalk userId of the user who initiated this card run. */
  ownerUserId?: string;
  card?: AICardInstance;
  controller?: CardDraftController;
  stopRequestedAt?: number;
  registeredAt: number;
}

const CARD_RUN_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const records = new Map<string, CardRunRecord>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweepTimer(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of records) {
      if (now - record.registeredAt > CARD_RUN_TTL_MS) {
        records.delete(key);
      }
    }
    if (records.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
  // Allow the process to exit without waiting for this timer.
  if (typeof sweepTimer === "object" && "unref" in sweepTimer) {
    sweepTimer.unref();
  }
}

export function registerCardRun(
  outTrackId: string,
  params: {
    accountId: string;
    sessionKey: string;
    agentId: string;
    ownerUserId?: string;
    card?: AICardInstance;
  },
): void {
  const trimmed = outTrackId.trim();
  if (!trimmed) {
    return;
  }
  records.set(trimmed, {
    outTrackId: trimmed,
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    ownerUserId: params.ownerUserId,
    card: params.card,
    registeredAt: Date.now(),
  });
  ensureSweepTimer();
}

export function attachCardRunController(outTrackId: string, controller: CardDraftController): void {
  const record = records.get(outTrackId.trim());
  if (record) {
    record.controller = controller;
  }
}

export function resolveCardRun(outTrackId: string): CardRunRecord | null {
  return records.get(outTrackId.trim()) ?? null;
}

export function markCardRunStopRequested(outTrackId: string): void {
  const record = records.get(outTrackId.trim());
  if (record && !record.stopRequestedAt) {
    record.stopRequestedAt = Date.now();
  }
}

export function isCardRunStopRequested(outTrackId: string): boolean {
  return Boolean(records.get(outTrackId.trim())?.stopRequestedAt);
}

export function removeCardRun(outTrackId: string): void {
  records.delete(outTrackId.trim());
  if (records.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function clearCardRunRegistryForTest(): void {
  records.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
