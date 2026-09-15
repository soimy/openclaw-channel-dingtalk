/** Undefined preserves ordinary reply behavior; zero means unknown/unsafe expiry. */
export function resolveReplySessionWebhook(webhook: string, expiresAt?: number): string {
  if (expiresAt === undefined) {
    return webhook;
  }
  // Leave a small margin for transport time rather than sending at the expiry boundary.
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 30_000 ? webhook : "";
}
