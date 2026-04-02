import type { Logger } from "./types";

let currentLogger: Logger | undefined;
const loggerByAccountId = new Map<string, Logger>();

/**
 * Persist current request logger for shared services invoked outside handler scope.
 */
export function setCurrentLogger(log?: Logger, accountId?: string | null): void {
  currentLogger = log;
  const normalizedAccountId = typeof accountId === "string" ? accountId.trim() : "";
  if (!normalizedAccountId) {
    return;
  }
  if (log) {
    loggerByAccountId.set(normalizedAccountId, log);
    return;
  }
  loggerByAccountId.delete(normalizedAccountId);
}

/**
 * Read current logger bound by inbound handler.
 */
export function getLogger(accountId?: string | null): Logger | undefined {
  const normalizedAccountId = typeof accountId === "string" ? accountId.trim() : "";
  if (normalizedAccountId) {
    return loggerByAccountId.get(normalizedAccountId);
  }
  return currentLogger;
}
