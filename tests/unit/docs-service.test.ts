import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("token_abc"),
}));

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

import { appendToDoc, createDoc, DocCreateAppendError, listDocs, searchDocs } from "../../src/docs-service";

const mockedAxiosPost = vi.mocked(axios.post);
const mockedAxiosGet = vi.mocked(axios.get);
const config = { clientId: "id", clientSecret: "sec" } as any;

describe("docs-service", () => {
  beforeEach(() => {
    mockedAxiosPost.mockReset();
    mockedAxiosGet.mockReset();
  });

  it("creates doc and appends initial content", async () => {
    mockedAxiosPost
      .mockResolvedValueOnce({ data: { docId: "doc_1", docType: "alidoc" } } as any)
      .mockResolvedValueOnce({ data: {} } as any);

    const result = await createDoc(config, "space_1", "测试文档", "第一段");

    expect(result).toEqual({
      docId: "doc_1",
      title: "测试文档",
      docType: "alidoc",
    });
    expect(mockedAxiosPost).toHaveBeenNthCalledWith(
      1,
      "https://api.dingtalk.com/v1.0/doc/spaces/space_1/docs",
      expect.objectContaining({ name: "测试文档", docType: "alidoc" }),
      expect.any(Object),
    );
    expect(mockedAxiosPost).toHaveBeenNthCalledWith(
      2,
      "https://api.dingtalk.com/v1.0/doc/documents/doc_1/blocks/root/children",
      expect.objectContaining({ body: { text: "第一段" } }),
      expect.any(Object),
    );
  });

  it("passes optional parentId when creating docs", async () => {
    mockedAxiosPost.mockResolvedValueOnce({ data: { docId: "doc_parent", docType: "alidoc" } } as any);

    await createDoc(config, "space_1", "子目录文档", undefined, undefined, "parent_1");

    expect(mockedAxiosPost).toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/doc/spaces/space_1/docs",
      expect.objectContaining({ parentDentryId: "parent_1" }),
      expect.any(Object),
    );
  });

  it("throws an error with created doc info when initial append fails", async () => {
    mockedAxiosPost
      .mockResolvedValueOnce({ data: { docId: "doc_partial", docType: "alidoc" } } as any)
      .mockRejectedValueOnce(new Error("append boom"));

    await expect(createDoc(config, "space_1", "测试文档", "第一段")).rejects.toMatchObject({
      name: "DocCreateAppendError",
      message: "initial content append failed after document creation",
      doc: {
        docId: "doc_partial",
        title: "测试文档",
        docType: "alidoc",
      },
      cause: expect.any(Error),
    });
  });

  it("searches docs by keyword", async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: { items: [{ docId: "doc_2", title: "周报", docType: "alidoc" }] },
    } as any);

    const docs = await searchDocs(config, "周报", "space_1");

    expect(docs).toEqual([{ docId: "doc_2", title: "周报", docType: "alidoc" }]);
  });

  it("lists docs in a space", async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: { items: [{ dentryUuid: "doc_3", name: "知识库", dentryType: "folder" }] },
    } as any);

    const docs = await listDocs(config, "space_1", "parent_1");

    expect(docs).toEqual([{ docId: "doc_3", title: "知识库", docType: "folder" }]);
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/doc/spaces/space_1/dentries",
      expect.objectContaining({
        params: { maxResults: 50, parentDentryId: "parent_1" },
      }),
    );
  });

  it("appends to an existing doc", async () => {
    mockedAxiosPost.mockResolvedValueOnce({ data: {} } as any);

    const result = await appendToDoc(config, "doc_1", "追加内容");

    expect(result).toEqual({ success: true });
  });

  it("throws when append response explicitly reports failure", async () => {
    mockedAxiosPost.mockResolvedValueOnce({ data: { success: false } } as any);

    await expect(appendToDoc(config, "doc_1", "追加内容")).rejects.toThrow("appendToDoc failed");
  });
});
