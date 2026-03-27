import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHttpReceiver } from "../../src/http-receiver";
import { generateDingTalkSignature } from "../../src/signature";

vi.mock("../../src/inbound-handler", () => ({
  handleDingTalkMessage: vi.fn().mockResolvedValue(undefined),
}));

import { handleDingTalkMessage } from "../../src/inbound-handler";

const mockedHandle = vi.mocked(handleDingTalkMessage);
const INGRESS_SECRET = "secret";

function createSignedHeaders(secret: string, timestamp = Date.now().toString()): Record<string, string> {
  return {
    timestamp,
    sign: generateDingTalkSignature(timestamp, secret),
  };
}

function post(
  port: number,
  path: string,
  body: unknown,
  options?: {
    headers?: Record<string, string>;
    rawBody?: string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = options?.rawBody ?? JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...(options?.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    }).on("error", reject);
  });
}

function postChunked(
  port: number,
  path: string,
  chunks: string[],
  options?: {
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options?.headers ?? {}),
        },
      },
      (res) => {
        const responseChunks: Buffer[] = [];
        res.on("data", (c) => responseChunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: Buffer.concat(responseChunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    for (const chunk of chunks) {
      req.write(chunk);
    }
    req.end();
  });
}

describe("http-receiver", () => {
  let server: http.Server;
  let destroySpy: ReturnType<typeof vi.spyOn<typeof http.IncomingMessage.prototype, "destroy">>;
  const port = 19876; // use a high port to avoid conflicts

  function expectServerRequestDestroyed(path: string): void {
    const destroyedServerRequest = destroySpy.mock.instances.some(
      (instance) => instance.method === "POST" && instance.url === path,
    );
    expect(destroyedServerRequest).toBe(true);
  }

  beforeEach(() => {
    mockedHandle.mockReset();
    mockedHandle.mockResolvedValue(undefined);
    destroySpy = vi.spyOn(http.IncomingMessage.prototype, "destroy");
  });

  afterEach(async () => {
    destroySpy.mockRestore();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("processes POST /callback and calls handleDingTalkMessage", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test-account",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100)); // wait for server to start

    const message = {
      msgId: "msg-1",
      msgtype: "text",
      text: { content: "hello" },
      conversationType: "2",
      conversationId: "group-1",
      senderId: "user-1",
      chatbotUserId: "bot-1",
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      createAt: Date.now(),
    };

    const res = await post(port, "/dingtalk/callback", message, {
      headers: createSignedHeaders(INGRESS_SECRET),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    await vi.waitFor(() => expect(mockedHandle).toHaveBeenCalledTimes(1));
    expect(mockedHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "test-account",
        data: expect.objectContaining({ msgId: "msg-1", conversationId: "group-1" }),
        sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=xxx",
      }),
    );
  });

  it("returns 404 for non-callback paths", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/other", {});
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid JSON", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
      log: { warn: vi.fn() } as any,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/dingtalk/callback", {}, {
      headers: createSignedHeaders(INGRESS_SECRET),
      rawBody: "not json",
    });

    expect(res.status).toBe(400);
  });

  it("responds to GET /health", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(port, "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, mode: "http", accountId: "test" });
  });

  it("accepts custom webhookPath", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
      webhookPath: "/custom/webhook",
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/custom/webhook", { msgId: "m2", sessionWebhook: "https://x" }, {
      headers: createSignedHeaders(INGRESS_SECRET),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockedHandle).toHaveBeenCalledTimes(1));

    // Default path should 404
    const res2 = await post(port, "/dingtalk/callback", { msgId: "m3", sessionWebhook: "https://x" });
    expect(res2.status).toBe(404);
  });

  it("returns 401 and destroys the request when signature headers are missing", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/dingtalk/callback", { msgId: "m-missing-sign", sessionWebhook: "https://x" });

    expect(res.status).toBe(401);
    expect(mockedHandle).not.toHaveBeenCalled();
    expectServerRequestDestroyed("/dingtalk/callback");
  });

  it("returns 403 and destroys the request when signature is invalid", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/dingtalk/callback", { msgId: "m-invalid-sign", sessionWebhook: "https://x" }, {
      headers: {
        timestamp: Date.now().toString(),
        sign: "invalid-sign",
      },
    });

    expect(res.status).toBe(403);
    expect(mockedHandle).not.toHaveBeenCalled();
    expectServerRequestDestroyed("/dingtalk/callback");
  });

  it("returns 403 and destroys the request when timestamp is invalid", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/dingtalk/callback", { msgId: "m-invalid-timestamp", sessionWebhook: "https://x" }, {
      headers: {
        timestamp: "not-a-timestamp",
        sign: "invalid-sign",
      },
    });

    expect(res.status).toBe(403);
    expect(mockedHandle).not.toHaveBeenCalled();
    expectServerRequestDestroyed("/dingtalk/callback");
  });

  it("returns 413 and destroys the request when content-length exceeds limit", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
      log: { warn: vi.fn() } as any,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/dingtalk/callback", {}, {
      headers: {
        ...createSignedHeaders(INGRESS_SECRET),
        "Content-Length": String(1_048_577),
      },
      rawBody: "{}",
    });

    expect(res.status).toBe(413);
    expect(mockedHandle).not.toHaveBeenCalled();
    expectServerRequestDestroyed("/dingtalk/callback");
  });

  it("returns 413 and destroys the request when chunked body exceeds limit while streaming", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
      log: { warn: vi.fn() } as any,
    });
    await new Promise((r) => setTimeout(r, 100));

    const prefix = JSON.stringify({
      msgId: "m-streaming-oversized",
      sessionWebhook: "https://x",
      text: { content: "" },
    }).replace('""', '"');
    const suffix = `${"x".repeat(1_048_577)}"}`;

    const res = await postChunked(port, "/dingtalk/callback", [prefix, suffix], {
      headers: createSignedHeaders(INGRESS_SECRET),
    });

    expect(res.status).toBe(413);
    expect(mockedHandle).not.toHaveBeenCalled();
    expectServerRequestDestroyed("/dingtalk/callback");
  });

  it("still returns success response even when handleDingTalkMessage throws", async () => {
    mockedHandle.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const errorLog = vi.fn();
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
      log: { error: errorLog } as any,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(
      port,
      "/dingtalk/callback",
      {
        msgId: "m-throw",
        msgtype: "text",
        text: { content: "hello" },
        conversationType: "2",
        conversationId: "group-1",
        senderId: "user-1",
        chatbotUserId: "bot-1",
        sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=yyy",
        createAt: Date.now(),
      },
      {
        headers: createSignedHeaders(INGRESS_SECRET),
      },
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    await vi.waitFor(() =>
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Failed to process message")),
    );
  });

  it("returns success for duplicate msgId callback and skips second dispatch", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
    });
    await new Promise((r) => setTimeout(r, 100));

    const message = {
      msgId: "m-http-dedup-once",
      msgtype: "text",
      text: { content: "dedup me once" },
      conversationType: "2",
      conversationId: "group-1",
      senderId: "user-1",
      chatbotUserId: "bot-1",
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=dedup",
      createAt: Date.now(),
    };

    const first = await post(port, "/dingtalk/callback", message, {
      headers: createSignedHeaders(INGRESS_SECRET),
    });
    const second = await post(port, "/dingtalk/callback", message, {
      headers: createSignedHeaders(INGRESS_SECRET),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ success: true });
    expect(JSON.parse(second.body)).toEqual({ success: true });
    await vi.waitFor(() => expect(mockedHandle).toHaveBeenCalledTimes(1));
  });

  it("retries same msgId after first dispatch failure", async () => {
    mockedHandle
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce(undefined);
    const errorLog = vi.fn();
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: INGRESS_SECRET } as any,
      port,
      log: { error: errorLog } as any,
    });
    await new Promise((r) => setTimeout(r, 100));

    const message = {
      msgId: "m-http-retry-after-failure",
      msgtype: "text",
      text: { content: "retry me" },
      conversationType: "2",
      conversationId: "group-1",
      senderId: "user-1",
      chatbotUserId: "bot-1",
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=retry",
      createAt: Date.now(),
    };

    const first = await post(port, "/dingtalk/callback", message, {
      headers: createSignedHeaders(INGRESS_SECRET),
    });
    const second = await post(port, "/dingtalk/callback", message, {
      headers: createSignedHeaders(INGRESS_SECRET),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ success: true });
    expect(JSON.parse(second.body)).toEqual({ success: true });
    await vi.waitFor(() => expect(mockedHandle).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Failed to process message")),
    );
  });
});
