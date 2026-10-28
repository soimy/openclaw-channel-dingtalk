const RETRY_DELAY_MS = 60_000;
const STATE_TTL_MS = 60 * 60 * 1000;
const MAX_STATES = 1000;

type DeliveryState = {
  code: string;
  expiresAt: number;
  retryAt: number;
  inFlight: boolean;
  sent: boolean;
};

// shortcut: process-local delivery memory can repeat a hint after restart/eviction;
// persist only if notification dedup across restarts becomes a requirement.
const deliveries = new Map<string, DeliveryState>();

function scopeKey(accountId: string, senderId: string): string {
  return JSON.stringify([accountId, senderId]);
}

export function clearPairingChallengeDelivery(accountId: string, senderId: string): void {
  deliveries.delete(scopeKey(accountId, senderId));
}

export function resetPairingChallengeDeliveryForTest(): void {
  deliveries.clear();
}

export async function deliverPairingChallenge(
  params: { accountId: string; senderId: string; code: string },
  send: () => Promise<unknown>,
): Promise<void> {
  if (!params.code) {
    return;
  }
  const now = Date.now();
  for (const [key, state] of deliveries) {
    if (!state.inFlight && state.expiresAt <= now && state.retryAt <= now) {
      deliveries.delete(key);
    }
  }

  const key = scopeKey(params.accountId, params.senderId);
  let state = deliveries.get(key);
  if (state?.code !== params.code) {
    if (!state && deliveries.size >= MAX_STATES) {
      // Keep active sends and failed-send cooldowns reserved even under memory pressure.
      for (const [oldKey, oldState] of deliveries) {
        if (!oldState.inFlight && oldState.retryAt <= now) {
          deliveries.delete(oldKey);
          break;
        }
      }
      if (deliveries.size >= MAX_STATES) {
        return;
      }
    }
    state = {
      code: params.code,
      expiresAt: now + STATE_TTL_MS,
      retryAt: 0,
      inFlight: false,
      sent: false,
    };
    deliveries.set(key, state);
  }
  if (state.inFlight || state.sent || now < state.retryAt) {
    return;
  }

  // Reserve synchronously before invoking the sender, including synchronous failures.
  state.inFlight = true;
  try {
    await send();
    state.sent = true;
  } catch (error) {
    state.retryAt = Date.now() + RETRY_DELAY_MS;
    throw error;
  } finally {
    state.inFlight = false;
  }
}
