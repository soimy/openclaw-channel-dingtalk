import { defineChannelPluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { getAccessToken } from "./src/auth";
import { dingtalkPlugin } from "./src/channel";
import {
  getConfig,
  isConfigured,
  listDingTalkAccountIds,
  resolveDingTalkAccount,
} from "./src/config";
import {
  appendToDoc,
  createDoc,
  DocCreateAppendError,
  listDocs,
  searchDocs,
} from "./src/docs-service";
import { setDingTalkRuntime } from "./src/runtime";
import { sendMessage } from "./src/send-service";

type GatewayMethodContext = Pick<
  Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0],
  "params" | "respond"
>;

function registerDingTalkDocsGatewayMethods(api: OpenClawPluginApi): void {
  const createHandler = async ({ respond, params }: GatewayMethodContext) => {
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
  };

  const appendHandler = async ({ respond, params }: GatewayMethodContext) => {
    const accountId = readStringParam(params, "accountId");
    const docId = readStringParam(params, "docId", { required: true });
    const content = readStringParam(params, "content", { required: true, allowEmpty: false });
    const config = getConfig(api.config, accountId ?? undefined);
    const result = await appendToDoc(config, docId, content, api.logger);
    return respond(true, result);
  };

  const searchHandler = async ({ respond, params }: GatewayMethodContext) => {
    const accountId = readStringParam(params, "accountId");
    const keyword = readStringParam(params, "keyword", { required: true });
    const spaceId = readStringParam(params, "spaceId");
    const config = getConfig(api.config, accountId ?? undefined);
    const docs = await searchDocs(config, keyword, spaceId, api.logger);
    return respond(true, { docs });
  };

  const listHandler = async ({ respond, params }: GatewayMethodContext) => {
    const accountId = readStringParam(params, "accountId");
    const spaceId = readStringParam(params, "spaceId", { required: true });
    const parentId = readStringParam(params, "parentId");
    const config = getConfig(api.config, accountId ?? undefined);
    const docs = await listDocs(config, spaceId, parentId, api.logger);
    return respond(true, { docs });
  };

  api.registerGatewayMethod("dingtalk.docs.create", createHandler);
  api.registerGatewayMethod("dingtalk.docs.append", appendHandler);
  api.registerGatewayMethod("dingtalk.docs.search", searchHandler);
  api.registerGatewayMethod("dingtalk.docs.list", listHandler);
  api.registerGatewayMethod("dingtalk-connector.docs.create", createHandler);
  api.registerGatewayMethod("dingtalk-connector.docs.append", appendHandler);
  api.registerGatewayMethod("dingtalk-connector.docs.search", searchHandler);
  api.registerGatewayMethod("dingtalk-connector.docs.list", listHandler);
}

function getContentParam(params: Record<string, unknown>): string | undefined {
  return (
    readStringParam(params, "content", { allowEmpty: true }) ??
    readStringParam(params, "message", { allowEmpty: true })
  );
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function sendGatewayMessage(params: {
  api: OpenClawPluginApi;
  respond: GatewayMethodContext["respond"];
  accountId?: string;
  target: string;
  content: string;
  useAICard?: unknown;
}) {
  const config = getConfig(params.api.config, params.accountId);
  if (!isConfigured(params.api.config, params.accountId)) {
    return params.respond(false, { error: "DingTalk not configured" });
  }
  const result = await sendMessage(config, params.target, params.content, {
    log: params.api.logger,
    accountId: params.accountId,
    conversationId: params.target,
    forceMarkdown: params.useAICard === false,
  });
  return params.respond(
    result.ok,
    result.ok
      ? {
          ok: true,
          target: params.target,
          messageId:
            result.messageId ??
            result.tracking?.processQueryKey ??
            result.tracking?.cardInstanceId ??
            null,
          tracking: result.tracking ?? null,
        }
      : { error: result.error || "send failed" },
  );
}

function registerDingTalkConnectorCompatibilityGatewayMethods(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    "dingtalk-connector.sendToUser",
    async ({ respond, params }: GatewayMethodContext) => {
      const accountId = readStringParam(params, "accountId");
      const userId = readStringParam(params, "userId", { required: true });
      const content = getContentParam(params);
      if (!content) {
        return respond(false, { error: "content or message is required" });
      }
      return sendGatewayMessage({
        api,
        respond,
        accountId: accountId ?? undefined,
        target: `user:${userId}`,
        content,
        useAICard: params.useAICard,
      });
    },
  );

  api.registerGatewayMethod(
    "dingtalk-connector.sendToGroup",
    async ({ respond, params }: GatewayMethodContext) => {
      const accountId = readStringParam(params, "accountId");
      const openConversationId = readStringParam(params, "openConversationId", { required: true });
      const content = getContentParam(params);
      if (!content) {
        return respond(false, { error: "content or message is required" });
      }
      return sendGatewayMessage({
        api,
        respond,
        accountId: accountId ?? undefined,
        target: `group:${openConversationId}`,
        content,
        useAICard: params.useAICard,
      });
    },
  );

  api.registerGatewayMethod(
    "dingtalk-connector.send",
    async ({ respond, params }: GatewayMethodContext) => {
      const accountId = readStringParam(params, "accountId");
      const target = readStringParam(params, "target", { required: true });
      const content = getContentParam(params);
      if (!content) {
        return respond(false, { error: "content or message is required" });
      }
      return sendGatewayMessage({
        api,
        respond,
        accountId: accountId ?? undefined,
        target,
        content,
        useAICard: params.useAICard,
      });
    },
  );

  api.registerGatewayMethod(
    "dingtalk-connector.status",
    async ({ respond }: GatewayMethodContext) => {
      const accountIds = listDingTalkAccountIds(api.config);
      const accounts = accountIds.length > 0 ? accountIds : ["default"];
      return respond(true, {
        channel: "dingtalk",
        accounts: accounts.map((accountId) => {
          const account = resolveDingTalkAccount(api.config, accountId);
          return {
            accountId,
            configured: account.configured,
            enabled: account.enabled !== false,
            name: account.name ?? null,
            clientId: account.clientId || null,
          };
        }),
      });
    },
  );

  api.registerGatewayMethod(
    "dingtalk-connector.probe",
    async ({ respond, params }: GatewayMethodContext) => {
      const accountId = readStringParam(params, "accountId");
      const config = getConfig(api.config, accountId ?? undefined);
      if (!isConfigured(api.config, accountId ?? undefined)) {
        return respond(false, { error: "DingTalk not configured" });
      }
      try {
        await getAccessToken(config, api.logger);
        return respond(true, { ok: true, clientId: config.clientId });
      } catch (error: unknown) {
        return respond(false, { error: getErrorMessage(error, "probe failed") });
      }
    },
  );
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
    registerDingTalkConnectorCompatibilityGatewayMethods(api);
  },
});
