import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { dingtalkPlugin } from "./src/channel";
import { getConfig } from "./src/config";
import { appendToDoc, createDoc, listDocs, searchDocs } from "./src/docs-service";
import { setDingTalkRuntime } from "./src/runtime";
import type { DingtalkPluginModule } from "./src/types";

const plugin: DingtalkPluginModule = {
  id: "dingtalk",
  name: "DingTalk Channel",
  description: "DingTalk (钉钉) messaging channel via Stream mode",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi): void {
    setDingTalkRuntime(api.runtime);
    api.registerChannel({ plugin: dingtalkPlugin });
    api.registerGatewayMethod("dingtalk.docs.create", async ({ respond, cfg, params, log }: any) => {
      const spaceId = typeof params?.spaceId === "string" ? params.spaceId.trim() : "";
      const title = typeof params?.title === "string" ? params.title.trim() : "";
      const content = typeof params?.content === "string" ? params.content : undefined;
      if (!spaceId || !title) {
        return respond(false, { error: "spaceId and title are required" });
      }
      const config = getConfig(cfg, params?.accountId);
      const doc = await createDoc(config, spaceId, title, content, log);
      return respond(true, doc);
    });
    api.registerGatewayMethod("dingtalk.docs.append", async ({ respond, cfg, params, log }: any) => {
      const docId = typeof params?.docId === "string" ? params.docId.trim() : "";
      const content = typeof params?.content === "string" ? params.content : "";
      if (!docId || !content) {
        return respond(false, { error: "docId and content are required" });
      }
      const config = getConfig(cfg, params?.accountId);
      const result = await appendToDoc(config, docId, content, log);
      return respond(true, result);
    });
    api.registerGatewayMethod("dingtalk.docs.search", async ({ respond, cfg, params, log }: any) => {
      const keyword = typeof params?.keyword === "string" ? params.keyword.trim() : "";
      const spaceId = typeof params?.spaceId === "string" ? params.spaceId.trim() : undefined;
      if (!keyword) {
        return respond(false, { error: "keyword is required" });
      }
      const config = getConfig(cfg, params?.accountId);
      const docs = await searchDocs(config, keyword, spaceId, log);
      return respond(true, { docs });
    });
    api.registerGatewayMethod("dingtalk.docs.list", async ({ respond, cfg, params, log }: any) => {
      const spaceId = typeof params?.spaceId === "string" ? params.spaceId.trim() : "";
      const parentId = typeof params?.parentId === "string" ? params.parentId.trim() : undefined;
      if (!spaceId) {
        return respond(false, { error: "spaceId is required" });
      }
      const config = getConfig(cfg, params?.accountId);
      const docs = await listDocs(config, spaceId, parentId, log);
      return respond(true, { docs });
    });
  },
};

export default plugin;
