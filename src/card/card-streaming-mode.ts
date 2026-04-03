import type { DingTalkConfig } from "../types";

export type CardStreamingMode = "off" | "answer" | "all";

// Process-lifetime one-shot warnings are intentional here: a given config key
// should only emit the deprecation notice once per runtime.
const warnedLegacyConfigs = new Set<string>();

export function resolveCardStreamingMode(
  config: Pick<DingTalkConfig, "cardStreamingMode" | "cardRealTimeStream">,
): {
  mode: CardStreamingMode;
  usedDeprecatedCardRealTimeStream: boolean;
} {
  if (config.cardStreamingMode) {
    return { mode: config.cardStreamingMode, usedDeprecatedCardRealTimeStream: false };
  }
  if (config.cardRealTimeStream === true) {
    return { mode: "all", usedDeprecatedCardRealTimeStream: true };
  }
  return { mode: "off", usedDeprecatedCardRealTimeStream: false };
}

export function shouldWarnDeprecatedCardRealTimeStreamOnce(configKey: string): boolean {
  if (warnedLegacyConfigs.has(configKey)) {
    return false;
  }
  warnedLegacyConfigs.add(configKey);
  return true;
}
