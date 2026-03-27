import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHttpReceiver } from "../../src/http-receiver";

vi.mock("../../src/inbound-handler", () => ({
  handleDingTalkMessage: vi.fn().mockResolvedValue(undefined),
}));

import { handleDingTalkMessage } from "../../src/inbound-handler";

const mockedHandle = vi.mocked(handleDingTalkMessage);

function post(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
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

describe("http-receiver", () => {
  let server: http.Server;
  const port = 19876; // use a high port to avoid conflicts

  beforeEach(() => {
    mockedHandle.mockClear();
  });

  afterEach(() => {
    server?.close();
  });

  it("processes POST /callback and calls handleDingTalkMessage", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test-account",
      dingtalkConfig: { clientId: "id", clientSecret: "secret" } as any,
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

    const res = await post(port, "/dingtalk/callback", message);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 50));

    expect(mockedHandle).toHaveBeenCalledTimes(1);
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
      dingtalkConfig: { clientId: "id", clientSecret: "secret" } as any,
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
      dingtalkConfig: { clientId: "id", clientSecret: "secret" } as any,
      port,
      log: { warn: vi.fn() } as any,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/dingtalk/callback", method: "POST", headers: { "Content-Type": "application/json" } },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => resolve({ status: r.statusCode!, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on("error", reject);
      req.write("not json");
      req.end();
    });

    expect(res.status).toBe(400);
  });

  it("responds to GET /health", async () => {
    server = startHttpReceiver({
      cfg: {} as any,
      accountId: "test",
      dingtalkConfig: { clientId: "id", clientSecret: "secret" } as any,
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
      dingtalkConfig: { clientId: "id", clientSecret: "secret" } as any,
      port,
      webhookPath: "/custom/webhook",
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await post(port, "/custom/webhook", { msgId: "m2", sessionWebhook: "https://x" });
    expect(res.status).toBe(200);

    // Default path should 404
    const res2 = await post(port, "/dingtalk/callback", { msgId: "m3", sessionWebhook: "https://x" });
    expect(res2.status).toBe(404);
  });
});
