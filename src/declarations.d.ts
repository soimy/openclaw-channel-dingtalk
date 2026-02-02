declare module 'openclaw/plugin-sdk' {
  export interface OpenClawPluginApi {
    [key: string]: any;
  }

  export interface OpenClawConfig {
    [key: string]: any;
  }

  export interface PluginRuntime {
    [key: string]: any;
  }

  export const emptyPluginConfigSchema: any;
  export const buildChannelConfigSchema: any;
}