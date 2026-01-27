/**
 * Type stub for clawdbot/plugin-sdk
 * Auto-generated to provide TypeScript support
 */

export interface ClawdbotPluginApi {
  runtime: PluginRuntime;
  registerChannel(opts: { plugin: ChannelPlugin }): void;
  registerGatewayMethod(name: string, handler: (ctx: any) => Promise<any>): void;
}

export interface PluginRuntime {
  tts?: any;
  logging?: any;
  channel?: {
    text?: any;
  };
}

export interface ClawdbotConfig {
  channels?: Record<string, any>;
  debug?: boolean;
}

export interface ChannelPlugin {
  meta?: {
    label: string;
    description?: string;
    docsPath?: string;
  };
  capabilities?: Record<string, any>;
  config?: {
    listAccountIds(cfg: any): Promise<string[]>;
    resolveAccount(cfg: any, id: string): Promise<any>;
  };
  outbound?: {
    deliveryMode: string;
    sendText(ctx: any): Promise<any>;
    sendMedia?(ctx: any): Promise<any>;
    sendPoll?(ctx: any): Promise<any>;
  };
  gateway?: {
    startAccount(ctx: any): Promise<void>;
    stopAccount(ctx: any): Promise<void>;
  };
  auth?: Record<string, any>;
  status?: {
    collectStatusIssues(ctx: any): Promise<any>;
  };
}

declare module 'clawdbot/plugin-sdk' {
  export * from './clawdbot';
}
