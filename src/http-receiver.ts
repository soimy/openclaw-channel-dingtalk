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
import type { DingTalkConfig, DingTalkInboundMessage, Logger } from "./types";

const DEFAULT_WEBHOOK_PATH = "/dingtalk/callback";

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

    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
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

    // Process message through existing pipeline
    try {
      await handleDingTalkMessage({
        cfg,
        accountId,
        data,
        sessionWebhook: data.sessionWebhook,
        log,
        dingtalkConfig,
      });
    } catch (err: any) {
      log?.error?.(`[${accountId}][HTTP] Failed to process message: ${err.message}`);
    }
  });

  server.listen(port, () => {
    log?.info?.(`[${accountId}][HTTP] Listening on port ${port} (mode: http)`);
  });

  return server;
}
