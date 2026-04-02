import type { ChannelLogSink } from "./types";

let currentLogger: ChannelLogSink | undefined;

/**
 * Persist current request logger for shared services invoked outside handler scope.
 */
export function setCurrentLogger(log?: ChannelLogSink): void {
  currentLogger = log;
}

/**
 * Read current logger bound by inbound handler.
 */
export function getLogger(): ChannelLogSink | undefined {
  return currentLogger;
}
