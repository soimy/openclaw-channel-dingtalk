import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken } from "../../src/auth";

const shared = vi.hoisted(() => ({
  getRuntimeMock: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
    isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
  },
  isAxiosError: (err: unknown) => Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
}));

vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("token_abc"),
}));

vi.mock("../../src/runtime", () => ({
  getDingTalkRuntime: shared.getRuntimeMock,
}));

import { downloadMedia } from "../../src/inbound-handler";

const mockedAxiosPost = vi.mocked(axios.post);
const mockedAxiosGet = vi.mocked(axios.get);
const mockedGetAccessToken = vi.mocked(getAccessToken);

function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi
          .fn()
          .mockReturnValue({ agentId: "main", sessionKey: "s1", mainSessionKey: "s1" }),
        buildAgentSessionKey: vi.fn().mockReturnValue("agent-session-key"),
      },
      media: {
        saveMediaBuffer: vi.fn().mockResolvedValue({
          path: "/tmp/.openclaw/media/inbound/test-file.png",
          contentType: "image/png",
        }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/store.json"),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: "s1" }),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockImplementation(
          async ({ dispatcherOptions, replyOptions }) => {
            await replyOptions?.onReasoningStream?.({ text: "thinking" });
            await dispatcherOptions.deliver({ text: "tool output" }, { kind: "tool" });
            await dispatcherOptions.deliver({ text: "final output" }, { kind: "final" });
            return { queuedFinal: "queued final" };
          },
        ),
      },
    },
  };
}

describe("inbound-handler downloadMedia", () => {
  beforeEach(() => {
    mockedAxiosPost.mockReset();
    mockedAxiosGet.mockReset();
    mockedGetAccessToken.mockReset();
    mockedGetAccessToken.mockResolvedValue("token_abc");
    shared.getRuntimeMock.mockReturnValue(buildRuntime());
  });

  it("returns file meta when DingTalk download succeeds", async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "image/png" },
    } as any);

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
    );

    expect(result).toBeTruthy();
    expect(result?.mimeType).toBe("image/png");
    expect(result?.path).toContain("/.openclaw/media/inbound/");
  });

  it("applies timeout to the downloadUrl fetch", async () => {
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "image/png" },
    } as any);

    await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
    );

    expect(mockedAxiosGet).toHaveBeenCalledWith("https://download.url/file", {
      responseType: "arraybuffer",
      timeout: 15_000,
    });
  });

  it("logs the download host when the downloadUrl fetch fails", async () => {
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockRejectedValueOnce({
      isAxiosError: true,
      code: "ETIMEDOUT",
      message: "connect ETIMEDOUT",
      request: {},
    });

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
      log as any,
    );

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("stage=download host=download.url"),
    );
  });

  it("logs the auth stage when token retrieval fails", async () => {
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    mockedGetAccessToken.mockRejectedValueOnce(new Error("token failed"));

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
      log as any,
    );

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("stage=auth host=api.dingtalk.com message=token failed"),
    );
  });

  it("logs the exchange stage when messageFiles/download fails", async () => {
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    mockedAxiosPost.mockRejectedValueOnce({
      isAxiosError: true,
      code: "ECONNRESET",
      message: "socket hang up",
      request: {},
    });

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
      log as any,
    );

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("stage=exchange host=api.dingtalk.com"),
    );
  });

  it("keeps message= prefix for non-Axios download failures", async () => {
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockRejectedValueOnce(new Error("plain failure"));

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
      log as any,
    );

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("stage=download host=download.url message=plain failure"),
    );
  });

  it("passes mediaMaxMb as maxBytes to saveMediaBuffer", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValue(runtime);

    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "application/pdf" },
    } as any);

    await downloadMedia(
      { clientId: "id", clientSecret: "sec", mediaMaxMb: 50 } as any,
      "download_code_1",
    );

    expect(runtime.channel.media.saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "inbound",
      50 * 1024 * 1024,
      undefined,
    );
  });

  it("uses runtime default when mediaMaxMb is not set", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValue(runtime);

    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "image/png" },
    } as any);

    await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
    );

    const call = runtime.channel.media.saveMediaBuffer.mock.calls[0];
    expect(call).toHaveLength(5);
    expect(call[2]).toBe("inbound");
    expect(call[3]).toBeUndefined();
    expect(call[4]).toBeUndefined();
  });

  it("forwards originalFilename to saveMediaBuffer", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValue(runtime);

    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    } as any);

    await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
      undefined,
      "report.docx",
    );

    expect(runtime.channel.media.saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.any(String),
      "inbound",
      undefined,
      "report.docx",
    );
  });

  it("uses clientId as robotCode", async () => {
    const runtime = buildRuntime();
    shared.getRuntimeMock.mockReturnValue(runtime);

    mockedAxiosPost.mockResolvedValueOnce({
      data: { downloadUrl: "https://download.url/file" },
    } as any);
    mockedAxiosGet.mockResolvedValueOnce({
      data: Buffer.from("abc"),
      headers: { "content-type": "image/png" },
    } as any);

    const result = await downloadMedia(
      { clientId: "id", clientSecret: "sec" } as any,
      "download_code_1",
    );

    expect(result).toBeTruthy();
    expect(mockedAxiosPost).toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/robot/messageFiles/download",
      { downloadCode: "download_code_1", robotCode: "id" },
      { headers: { "x-acs-dingtalk-access-token": "token_abc" } },
    );
  });
});