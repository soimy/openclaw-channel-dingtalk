/**
 * Session history utilities for @sub-agent feature
 *
 * Reads session history from JSONL files to provide group chat context.
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
 * @param limit - Maximum number of messages to include
 * @param log - Optional logger
 * @returns Formatted history context string
 */
export function getGroupHistoryContext(
  storePath: string,
  sessionKey: string,
  limit: number = 20,
  log?: Logger,
): string {
  try {
    const entry = loadSessionEntry(storePath, sessionKey);
    if (!entry) {
      return "";
    }

    const messages = readSessionHistory(entry.sessionId, storePath, entry.sessionFile, limit);

    if (messages.length === 0) {
      return "";
    }

    let context = "\n\n--- 群聊最近消息 ---\n";
    for (const msg of messages.slice(-10)) {
      const sender = msg.senderName || "某人";
      const content = msg.content.slice(0, 200);
      context += `${sender}: ${content}\n`;
    }
    context += "--- 以上为历史消息 ---\n\n";
    return context;
  } catch (error) {
    log?.warn?.(`[DingTalk] Failed to get group history context: ${error}`);
    return "";
  }
}
