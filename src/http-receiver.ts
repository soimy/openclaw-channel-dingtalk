/**
 * HTTP callback receiver for DingTalk plugin.
 *
 * Alternative to Stream (WebSocket) mode. Listens for POST requests from
 * DingTalk's HTTP callback and feeds them into the existing handleDingTalkMessage
 * pipeline. Enables multi-instance deployment behind a reverse proxy.
 *
 * Usage: configure `mode: "http"` and `httpPort: 3000` in DingTalk config.
 * The reverse proxy routes requests by conversationId to different instances.
 * Replies use sessionWebhook (included in POST body) directly — no proxy needed.
 */

import http from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { handleDingTalkMessage } from "./inbound-handler";
import { verifyDingTalkSignature } from "./signature";
import type { DingTalkConfig, DingTalkInboundMessage, Logger } from "./types";

const DEFAULT_WEBHOOK_PATH = "/dingtalk/callback";
const MAX_HTTP_BODY_BYTES = 1_048_576;

function readHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return String(value[0] ?? "").trim();
  }
  return String(value ?? "").trim();
}

function rejectRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  statusCode: number,
  payload: { success: false; error: string },
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload), () => {
    if (!req.destroyed) {
      req.destroy();
    }
  });
}

export function startHttpReceiver(params: {
  cfg: OpenClawConfig;
  accountId: string;
  dingtalkConfig: DingTalkConfig;
  port: number;
  webhookPath?: string;
  log?: Logger;
}): http.Server {
  const { cfg, accountId, dingtalkConfig, port, log } = params;
  const callbackPath = params.webhookPath || DEFAULT_WEBHOOK_PATH;

  const server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: "http", accountId }));
      return;
    }

    // Only accept POST on the configured callback path
    if (req.method !== "POST" || req.url !== callbackPath) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const timestamp = readHeaderValue(req.headers.timestamp);
    const sign = readHeaderValue(req.headers.sign);
    if (!timestamp || !sign) {
      log?.warn?.(`[${accountId}][HTTP] Missing callback signature headers`);
      rejectRequest(req, res, 401, { success: false, error: "Missing signature headers" });
      return;
    }

    if (!verifyDingTalkSignature({ timestamp, sign, secret: dingtalkConfig.clientSecret })) {
      log?.warn?.(`[${accountId}][HTTP] Callback signature verification failed`);
      rejectRequest(req, res, 403, { success: false, error: "Invalid signature" });
      return;
    }

    const contentLength = Number(readHeaderValue(req.headers["content-length"]));
    if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_BODY_BYTES) {
      log?.warn?.(
        `[${accountId}][HTTP] Callback payload too large (content-length=${contentLength}, max=${MAX_HTTP_BODY_BYTES})`,
      );
      rejectRequest(req, res, 413, { success: false, error: "Payload Too Large" });
      return;
    }

    // Read body
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const chunkBuffer = chunk as Buffer;
      totalBytes += chunkBuffer.length;
      if (totalBytes > MAX_HTTP_BODY_BYTES) {
        log?.warn?.(
          `[${accountId}][HTTP] Callback payload exceeded limit while streaming (bytes=${totalBytes}, max=${MAX_HTTP_BODY_BYTES})`,
        );
        rejectRequest(req, res, 413, { success: false, error: "Payload Too Large" });
        return;
      }
      chunks.push(chunkBuffer);
    }
    const body = Buffer.concat(chunks).toString("utf-8");

    let data: DingTalkInboundMessage;
    try {
      data = JSON.parse(body) as DingTalkInboundMessage;
    } catch {
      log?.warn?.(`[${accountId}][HTTP] Invalid JSON body`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
      return;
    }

    // Respond immediately (async processing)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));

    // Keep the callback acknowledgement decoupled from downstream handling.
    void Promise.resolve()
      .then(() =>
        handleDingTalkMessage({
          cfg,
          accountId,
          data,
          sessionWebhook: data.sessionWebhook,
          log,
          dingtalkConfig,
        }),
      )
      .catch((err: any) => {
        const message = err instanceof Error ? err.message : String(err);
        log?.error?.(`[${accountId}][HTTP] Failed to process message: ${message}`);
      });
  });

  server.listen(port, () => {
    log?.info?.(`[${accountId}][HTTP] Listening on port ${port} (mode: http)`);
  });

  return server;
}
