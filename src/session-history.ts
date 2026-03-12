/**
 * Session history utilities for @sub-agent feature
 *
 * Reads session history from JSONL files to provide group chat context.
 *
 * @technical-debt
 * This module directly reads OpenClaw's internal session files (sessions.json and .jsonl).
 * This is fragile because:
 * 1. The file schema is an internal implementation detail, not a public API
 * 2. Changes in OpenClaw's session format will break this code
 * 3. Synchronous file reads block the event loop
 *
 * ## Compatibility Strategy
 *
 * Expected file formats:
 * - sessions.json: `{ [sessionKey]: { sessionId: string, updatedAt: number, sessionFile?: string } }`
 * - *.jsonl: Each line is `{ message: { role: string, content: string | Array, senderName?: string } }`
 *
 * If OpenClaw changes these formats, this module will fail silently (return empty context).
 * The sub-agent will still function, just without group chat history context.
 *
 * ## Graceful Degradation
 *
 * - File not found → return empty string (no history)
 * - Parse error → skip that line/entry, continue processing
 * - Missing fields → use sensible defaults
 * - Any exception → log warning, return empty string
 *
 * TODO: Request OpenClaw to provide a public API for reading session history,
 * or implement an alternative approach that doesn't depend on internal file formats.
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "./types";

interface SessionEntry {
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
}

interface SessionMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
  senderName?: string;
}

/**
 * Load session entry from sessions.json store
 */
function loadSessionEntry(storePath: string, sessionKey: string): SessionEntry | null {
  try {
    if (!fs.existsSync(storePath)) {
      return null;
    }
    const content = fs.readFileSync(storePath, "utf-8");
    const store = JSON.parse(content) as Record<string, SessionEntry>;
    return store[sessionKey] || null;
  } catch {
    return null;
  }
}

/**
 * Read session history from JSONL file
 */
function readSessionHistory(
  sessionId: string,
  storePath: string,
  sessionFile?: string,
  limit: number = 20,
): SessionMessage[] {
  const sessionsDir = path.dirname(storePath);

  // Try possible file paths
  const candidates: string[] = [];
  if (sessionFile) {
    candidates.push(path.resolve(sessionsDir, sessionFile));
  }
  candidates.push(path.join(sessionsDir, `${sessionId}.jsonl`));

  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return [];
  }

  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  const messages: SessionMessage[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message) {
        const msg = parsed.message;
        // Extract text content
        const content =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.map((c: { text?: string }) => c.text || "").join("")
              : "";
        messages.push({
          role: msg.role,
          content,
          senderName: msg.senderName,
        });
      }
    } catch {
      // Ignore parse errors
    }
  }

  return messages.slice(-limit);
}

/**
 * Get group chat history context string
 *
 * @param storePath - Path to sessions.json
 * @param sessionKey - Session key to read
 * @param limit - Maximum number of messages to include in output (default 10)
 * @param log - Optional logger
 * @returns Formatted history context string
 */
export function getGroupHistoryContext(
  storePath: string,
  sessionKey: string,
  limit: number = 10,
  log?: Logger,
): string {
  try {
    const entry = loadSessionEntry(storePath, sessionKey);
    if (!entry) {
      return "";
    }

    // Read exactly the number of messages we need
    const messages = readSessionHistory(entry.sessionId, storePath, entry.sessionFile, limit);

    if (messages.length === 0) {
      return "";
    }

    let context = "\n\n--- 群聊历史 ---\n";
    for (const msg of messages) {
      // 获取文本内容
      const contentText =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c) => c.text || "").join("")
            : "";

      // 尝试从消息内容中提取 agent 身份标识 [xxx]
      const agentMatch = contentText.match(/^\[([^\]]+)\]\s*/);
      if (agentMatch) {
        // 消息已经有身份标识前缀
        const agentName = agentMatch[1];
        const content = contentText.replace(agentMatch[0], "").slice(0, 200);
        context += `[${agentName}] ${content}\n`;
      } else {
        // 普通用户消息
        const sender = msg.senderName || "用户";
        const content = contentText.slice(0, 200);
        context += `[${sender}] ${content}\n`;
      }
    }
    context += "--- 历史结束 ---\n\n";
    return context;
  } catch (error) {
    log?.warn?.(`[DingTalk] Failed to get group history context: ${error}`);
    return "";
  }
}
