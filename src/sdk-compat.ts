import type { ChannelPlugin as CoreChannelPlugin, OpenClawConfig as CoreOpenClawConfig, OpenClawPluginApi as CoreOpenClawPluginApi, PluginRuntime as CorePluginRuntime } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type {
  ChannelDirectoryEntry,
  ChannelMessageActionAdapter,
  WizardPrompter,
} from "openclaw/plugin-sdk/matrix";
import {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  formatDocsLink,
  jsonResult,
  normalizeAccountId,
  readStringParam,
} from "openclaw/plugin-sdk/matrix";
import { extractToolSend } from "openclaw/plugin-sdk/googlechat";
import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
} from "openclaw/plugin-sdk";

export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  defineChannelPluginEntry,
  extractToolSend,
  formatDocsLink,
  jsonResult,
  normalizeAccountId,
  readStringParam,
};

export type OpenClawConfig = CoreOpenClawConfig;
export type OpenClawPluginApi = CoreOpenClawPluginApi;
export type PluginRuntime = CorePluginRuntime;
export type ChannelPlugin<TResolvedAccount = unknown> = CoreChannelPlugin<TResolvedAccount>;
export type DingTalkChannelPluginBase<TResolvedAccount = unknown> = CoreChannelPlugin<TResolvedAccount> & {
  setupWizard?: unknown;
};
export type {
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelGatewayContext,
  ChannelMessageActionAdapter,
  WizardPrompter,
};

export type ChannelLogSink = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};
