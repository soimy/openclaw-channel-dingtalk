import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk';
import { dingtalkPlugin } from './src/channel';
import { setDingTalkRuntime } from './src/runtime';

const plugin = {
  id: 'dingtalk',
  name: 'DingTalk Channel',
  description: 'DingTalk (钉钉) messaging channel via Stream mode',
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi): void {
    setDingTalkRuntime(api.runtime);
    api.registerChannel({ plugin: dingtalkPlugin });
  },
};

export default plugin;
