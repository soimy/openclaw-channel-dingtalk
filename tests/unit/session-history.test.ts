import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getGroupHistoryContext } from "../../src/session-history";

describe("session-history", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-history-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("loadSessionEntry (via getGroupHistoryContext)", () => {
    it("returns empty string when sessions.json not found", async () => {
      const result = await getGroupHistoryContext(
        path.join(tempDir, "sessions.json"),
        "session-key-1",
        10,
      );
      expect(result).toBe("");
    });

    it("returns empty string when session key not in sessions.json", async () => {
      const sessionsPath = path.join(tempDir, "sessions.json");
      await fs.writeFile(sessionsPath, JSON.stringify({ "other-key": { sessionId: "sid1" } }));

      const result = await getGroupHistoryContext(sessionsPath, "session-key-1", 10);
      expect(result).toBe("");
    });

    it("returns empty string when sessions.json is malformed", async () => {
      const sessionsPath = path.join(tempDir, "sessions.json");
      await fs.writeFile(sessionsPath, "not valid json");

      const result = await getGroupHistoryContext(sessionsPath, "session-key-1", 10);
      expect(result).toBe("");
    });
  });

  describe("readSessionHistory (via getGroupHistoryContext)", () => {
    it("reads session history from JSONL file", async () => {
      const sessionsPath = path.join(tempDir, "sessions.json");
      const sessionKey = "session-key-1";
      const sessionId = "sid-123";

      // Create sessions.json
      await fs.writeFile(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: { sessionId, updatedAt: Date.now() },
        }),
      );

      // Create JSONL file
      const jsonlPath = path.join(tempDir, `${sessionId}.jsonl`);
      await fs.writeFile(
        jsonlPath,
        JSON.stringify({ message: { role: "user", content: "Hello" } }) + "\n" +
          JSON.stringify({ message: { role: "assistant", content: "Hi there" } }) + "\n",
      );

      const result = await getGroupHistoryContext(sessionsPath, sessionKey, 10);

      expect(result).toContain("群聊历史");
      expect(result).toContain("Hello");
      expect(result).toContain("Hi there");
      expect(result).toContain("历史结束");
    });

    it("respects limit parameter", async () => {
      const sessionsPath = path.join(tempDir, "sessions.json");
      const sessionKey = "session-key-1";
      const sessionId = "sid-123";

      await fs.writeFile(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: { sessionId, updatedAt: Date.now() },
        }),
      );

      // Create 10 messages
      const jsonlPath = path.join(tempDir, `${sessionId}.jsonl`);
      const lines = [];
      for (let i = 0; i < 10; i++) {
        lines.push(JSON.stringify({ message: { role: "user", content: `Message ${i}` } }));
      }
      await fs.writeFile(jsonlPath, lines.join("\n") + "\n");

      const result = await getGroupHistoryContext(sessionsPath, sessionKey, 3);

      // Should only include last 3 messages
      expect(result).toContain("Message 7");
      expect(result).toContain("Message 8");
      expect(result).toContain("Message 9");
      expect(result).not.toContain("Message 6");
    });

    it("handles malformed JSONL lines gracefully", async () => {
      const sessionsPath = path.join(tempDir, "sessions.json");
      const sessionKey = "session-key-1";
      const sessionId = "sid-123";

      await fs.writeFile(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: { sessionId, updatedAt: Date.now() },
        }),
      );

      const jsonlPath = path.join(tempDir, `${sessionId}.jsonl`);
      await fs.writeFile(
        jsonlPath,
        "not valid json\n" +
          JSON.stringify({ message: { role: "user", content: "Valid message" } }) + "\n" +
          "also not valid\n",
      );

      const result = await getGroupHistoryContext(sessionsPath, sessionKey, 10);

      expect(result).toContain("Valid message");
      expect(result).not.toContain("not valid json");
    });

    it("handles missing fields gracefully", async () => {
      const sessionsPath = path.join(tempDir, "sessions.json");
      const sessionKey = "session-key-1";
      const sessionId = "sid-123";

      await fs.writeFile(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: { sessionId, updatedAt: Date.now() },
        }),
      );

      const jsonlPath = path.join(tempDir, `${sessionId}.jsonl`);
      await fs.writeFile(
        jsonlPath,
        JSON.stringify({ message: { role: "user" } }) + "\n" + // missing content
          JSON.stringify({ message: { content: "No role" } }) + "\n" + // missing role
          JSON.stringify({ notMessage: true }) + "\n", // no message field
      );

      const result = await getGroupHistoryContext(sessionsPath, sessionKey, 10);

      // Should not crash and return something
      expect(result).toBeDefined();
    });

    it("returns empty string when JSONL file not found", async () => {
      const sessionsPath = path.join(tempDir, "sessions.json");
      const sessionKey = "session-key-1";

      await fs.writeFile(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: { sessionId: "non-existent-session", updatedAt: Date.now() },
        }),
      );

      const result = await getGroupHistoryContext(sessionsPath, sessionKey, 10);
      expect(result).toBe("");
    });

    it("uses sessionFile from session entry if provided", async () => {
      const sessionsPath = path.join(tempDir, "sessions.json");
      const sessionKey = "session-key-1";
      const sessionId = "sid-123";
      const customFileName = "custom-history.jsonl";

      await fs.writeFile(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: { sessionId, updatedAt: Date.now(), sessionFile: customFileName },
        }),
      );

      // Create file with custom name
      const customPath = path.join(tempDir, customFileName);
      await fs.writeFile(
        customPath,
        JSON.stringify({ message: { role: "user", content: "From custom file" } }) + "\n",
      );

      const result = await getGroupHistoryContext(sessionsPath, sessionKey, 10);

      expect(result).toContain("From custom file");
    });
  });

  describe("getGroupHistoryContext output formatting", () => {
    it("formats messages with sender name", async () => {
      const sessionsPath = path.join(tempDir, "sessions.json");
      const sessionKey = "session-key-1";
      const sessionId = "sid-123";

      await fs.writeFile(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: { sessionId, updatedAt: Date.now() },
        }),
      );

      const jsonlPath = path.join(tempDir, `${sessionId}.jsonl`);
      await fs.writeFile(
        jsonlPath,
        JSON.stringify({
          message: { role: "user", content: "Hello", senderName: "张三" },
        }) + "\n",
      );

      const result = await getGroupHistoryContext(sessionsPath, sessionKey, 10);

      expect(result).toContain("[张三]");
      expect(result).toContain("Hello");
    });

    it("uses '用户' as default sender name", async () => {
      const sessionsPath = path.join(tempDir, "sessions.json");
      const sessionKey = "session-key-1";
      const sessionId = "sid-123";

      await fs.writeFile(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: { sessionId, updatedAt: Date.now() },
        }),
      );

      const jsonlPath = path.join(tempDir, `${sessionId}.jsonl`);
      await fs.writeFile(
        jsonlPath,
        JSON.stringify({ message: { role: "user", content: "Hello" } }) + "\n",
      );

      const result = await getGroupHistoryContext(sessionsPath, sessionKey, 10);

      expect(result).toContain("[用户]");
    });

    it("extracts agent identity from [xxx] prefix in content", async () => {
      const sessionsPath = path.join(tempDir, "sessions.json");
      const sessionKey = "session-key-1";
      const sessionId = "sid-123";

      await fs.writeFile(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: { sessionId, updatedAt: Date.now() },
        }),
      );

      const jsonlPath = path.join(tempDir, `${sessionId}.jsonl`);
      await fs.writeFile(
        jsonlPath,
        JSON.stringify({
          message: { role: "assistant", content: "[Agent1] 这是回复内容" },
        }) + "\n",
      );

      const result = await getGroupHistoryContext(sessionsPath, sessionKey, 10);

      expect(result).toContain("[Agent1]");
      expect(result).toContain("这是回复内容");
    });

    it("handles array content format", async () => {
      const sessionsPath = path.join(tempDir, "sessions.json");
      const sessionKey = "session-key-1";
      const sessionId = "sid-123";

      await fs.writeFile(
        sessionsPath,
        JSON.stringify({
          [sessionKey]: { sessionId, updatedAt: Date.now() },
        }),
      );

      const jsonlPath = path.join(tempDir, `${sessionId}.jsonl`);
      await fs.writeFile(
        jsonlPath,
        JSON.stringify({
          message: {
            role: "user",
            content: [
              { type: "text", text: "Part 1" },
              { type: "text", text: " Part 2" },
            ],
          },
        }) + "\n",
      );

      const result = await getGroupHistoryContext(sessionsPath, sessionKey, 10);

      expect(result).toContain("Part 1 Part 2");
    });
  });
});