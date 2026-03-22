import type { PluginRuntime } from "./sdk-compat";

let runtime: PluginRuntime | null = null;

export function setDingTalkRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getDingTalkRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("DingTalk runtime not initialized");
  }
  return runtime;
}
