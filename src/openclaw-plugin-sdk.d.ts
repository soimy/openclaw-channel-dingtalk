/**
 * Type augmentation for the base `openclaw/plugin-sdk` module.
 *
 * The published `openclaw/plugin-sdk` index declarations expose only types.
 * At runtime, `root-alias.cjs` is a Proxy that lazy-loads the full SDK, so
 * all value exports are available. This file merges the missing value exports
 * into the base module so that `import { ... } from "openclaw/plugin-sdk"` is
 * valid at both compile-time and runtime.
 *
 * See: https://github.com/soimy/openclaw-channel-dingtalk/issues/402
 */
declare module "openclaw/plugin-sdk" {
  export { defineChannelPluginEntry, buildChannelConfigSchema } from "openclaw/plugin-sdk/core";
  export { readStringParam } from "openclaw/plugin-sdk/param-readers";
  export { jsonResult } from "openclaw/plugin-sdk/telegram-core";
  export { extractToolSend } from "openclaw/plugin-sdk/tool-send";
  export { DEFAULT_ACCOUNT_ID, formatDocsLink, normalizeAccountId } from "openclaw/plugin-sdk/setup";
  export { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
}
