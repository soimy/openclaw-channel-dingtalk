import type { ClawdbotPluginApi } from 'clawdbot/plugin-sdk';
import { dingtalkPlugin, dingtalkConfigSchema } from './src/channel';
import { setDingTalkRuntime } from './src/runtime';

const plugin = {
  id: 'dingtalk',
  name: 'DingTalk Channel',
  description: 'DingTalk (钉钉) messaging channel via Stream mode',
  configSchema: dingtalkConfigSchema,
  register(api: ClawdbotPluginApi): void {
    setDingTalkRuntime(api.runtime);
    api.registerChannel({ plugin: dingtalkPlugin });
    api.registerGatewayMethod('dingtalk.status', async ({ respond, cfg }: any) => {
      const result = await dingtalkPlugin.status.probe({ cfg });
      respond(true, result);
    });
    api.registerGatewayMethod('dingtalk.probe', async ({ respond, cfg }: any) => {
      const result = await dingtalkPlugin.status.probe({ cfg });
      respond(result.ok, result);
    });
    api.logger?.info?.('[DingTalk] Plugin registered');
  },
};

export default plugin;
