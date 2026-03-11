import axios from "axios";
import { getAccessToken } from "./auth";
import { getLogger } from "./logger-context";
import { getProxyBypassOption } from "./utils";
import type { DingTalkConfig, DocInfo } from "./types";

const DINGTALK_API = "https://api.dingtalk.com";

async function buildHeaders(config: DingTalkConfig, log?: any): Promise<Record<string, string>> {
  const token = await getAccessToken(config, log);
  return {
    "x-acs-dingtalk-access-token": token,
    "Content-Type": "application/json",
  };
}

function mapDocInfo(item: any): DocInfo {
  return {
    docId: item.docId || item.dentryUuid || "",
    title: item.name || item.title || "",
    docType: item.docType || item.dentryType || "unknown",
    creatorId: item.creatorId,
    updatedAt: item.updatedAt,
  };
}

export async function createDoc(
  config: DingTalkConfig,
  spaceId: string,
  title: string,
  content?: string,
  log = getLogger(),
): Promise<DocInfo> {
  const headers = await buildHeaders(config, log);
  const createResp = await axios.post(
    `${DINGTALK_API}/v1.0/doc/spaces/${spaceId}/docs`,
    {
      spaceId,
      parentDentryId: "",
      name: title,
      docType: "alidoc",
    },
    {
      headers,
      timeout: 10_000,
      ...getProxyBypassOption(config),
    },
  );
  const createdBase = mapDocInfo(createResp.data);
  const created = {
    ...createdBase,
    title: createdBase.title || title,
    docType: createdBase.docType || "alidoc",
  };
  if (content?.trim() && created.docId) {
    await appendToDoc(config, created.docId, content, log);
  }
  return created;
}

export async function appendToDoc(
  config: DingTalkConfig,
  docId: string,
  content: string,
  log = getLogger(),
  index = -1,
): Promise<{ success: true }> {
  const headers = await buildHeaders(config, log);
  await axios.post(
    `${DINGTALK_API}/v1.0/doc/documents/${docId}/blocks/root/children`,
    {
      blockType: "PARAGRAPH",
      body: { text: content },
      index,
    },
    {
      headers,
      timeout: 10_000,
      ...getProxyBypassOption(config),
    },
  );
  return { success: true };
}

export async function searchDocs(
  config: DingTalkConfig,
  keyword: string,
  spaceId?: string,
  log = getLogger(),
): Promise<DocInfo[]> {
  const headers = await buildHeaders(config, log);
  const resp = await axios.post(
    `${DINGTALK_API}/v1.0/doc/docs/search`,
    {
      keyword,
      maxResults: 20,
      ...(spaceId ? { spaceId } : {}),
    },
    {
      headers,
      timeout: 10_000,
      ...getProxyBypassOption(config),
    },
  );
  return Array.isArray(resp.data?.items) ? resp.data.items.map(mapDocInfo) : [];
}

export async function listDocs(
  config: DingTalkConfig,
  spaceId: string,
  parentId?: string,
  log = getLogger(),
): Promise<DocInfo[]> {
  const headers = await buildHeaders(config, log);
  const resp = await axios.get(`${DINGTALK_API}/v1.0/doc/spaces/${spaceId}/dentries`, {
    headers,
    params: {
      maxResults: 50,
      ...(parentId ? { parentDentryId: parentId } : {}),
    },
    timeout: 10_000,
    ...getProxyBypassOption(config),
  });
  return Array.isArray(resp.data?.items) ? resp.data.items.map(mapDocInfo) : [];
}
