import { defineChannelPluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { dingtalkPlugin } from "./src/channel";
import { getConfig } from "./src/config";
import { appendToDoc, createDoc, DocCreateAppendError, listDocs, searchDocs } from "./src/docs-service";
import { accumulateUsage } from "./src/run-usage-store";
import { setDingTalkRuntime } from "./src/runtime";

type GatewayMethodContext = Pick<
  Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0],
  "params" | "respond"
>;

function registerDingTalkDocsGatewayMethods(api: OpenClawPluginApi): void {
  api.registerGatewayMethod("dingtalk.docs.create", async ({ respond, params }: GatewayMethodContext) => {
    const accountId = readStringParam(params, "accountId");
    const spaceId = readStringParam(params, "spaceId", { required: true });
    const title = readStringParam(params, "title", { required: true });
    const content = readStringParam(params, "content", { allowEmpty: true });
    const parentId = readStringParam(params, "parentId");
    const config = getConfig(api.config, accountId ?? undefined);
    try {
      const doc = await createDoc(
        config,
        spaceId,
        title,
        content ?? undefined,
        api.logger,
        parentId ?? undefined,
      );
      return respond(true, doc);
    } catch (error) {
      if (error instanceof DocCreateAppendError) {
        return respond(true, {
          partialSuccess: true,
          initContentAppended: false,
          docId: error.doc.docId,
          doc: error.doc,
          appendError: error.message,
        });
      }
      throw error;
    }
  });

  api.registerGatewayMethod("dingtalk.docs.append", async ({ respond, params }: GatewayMethodContext) => {
    const accountId = readStringParam(params, "accountId");
    const docId = readStringParam(params, "docId", { required: true });
    const content = readStringParam(params, "content", { required: true, allowEmpty: false });
    const config = getConfig(api.config, accountId ?? undefined);
    const result = await appendToDoc(config, docId, content, api.logger);
    return respond(true, result);
  });

  api.registerGatewayMethod("dingtalk.docs.search", async ({ respond, params }: GatewayMethodContext) => {
    const accountId = readStringParam(params, "accountId");
    const keyword = readStringParam(params, "keyword", { required: true });
    const spaceId = readStringParam(params, "spaceId");
    const config = getConfig(api.config, accountId ?? undefined);
    const docs = await searchDocs(config, keyword, spaceId, api.logger);
    return respond(true, { docs });
  });

  api.registerGatewayMethod("dingtalk.docs.list", async ({ respond, params }: GatewayMethodContext) => {
    const accountId = readStringParam(params, "accountId");
    const spaceId = readStringParam(params, "spaceId", { required: true });
    const parentId = readStringParam(params, "parentId");
    const config = getConfig(api.config, accountId ?? undefined);
    const docs = await listDocs(config, spaceId, parentId, api.logger);
    return respond(true, { docs });
  });
}

export { dingtalkPlugin } from "./src/channel";
export { setDingTalkRuntime } from "./src/runtime";

export default defineChannelPluginEntry({
  id: "dingtalk",
  name: "DingTalk Channel",
  description: "DingTalk (钉钉) messaging channel via Stream mode",
  plugin: dingtalkPlugin,
  setRuntime: setDingTalkRuntime,
  registerFull(api) {
    registerDingTalkDocsGatewayMethods(api);

    api.on("llm_output", (event: { runId: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } }) => {
      if (event.usage) {
        accumulateUsage(event.runId, event.usage);
      }
    });
  },
});
