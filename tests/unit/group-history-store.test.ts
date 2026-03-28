import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { queryConversationHistory } from "../../src/commands/group-history-store";
import { upsertInboundMessageContext, upsertOutboundMessageContext } from "../../src/message-context-store";
import {
  clearTargetDirectoryStateCache,
  upsertObservedGroupTarget,
} from "../../src/targeting/target-directory-store";

describe("group-history-store", () => {
  let tempDir = "";
  let storePath = "";

  beforeEach(() => {
    clearTargetDirectoryStateCache();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-group-history-"));
    storePath = path.join(tempDir, "session-store.json");
  });

  afterEach(() => {
    clearTargetDirectoryStateCache();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = "";
    storePath = "";
  });

  it("filters conversation history by sender and mention", () => {
    upsertObservedGroupTarget({
      storePath,
      accountId: "main",
      conversationId: "cid_group_1",
      title: "研发群",
      seenAt: 3000,
    });

    upsertInboundMessageContext({
      storePath,
      accountId: "main",
      conversationId: "cid_group_1",
      msgId: "m1",
      createdAt: 1000,
      messageType: "text",
      text: "@Alice 今天上线么",
      senderId: "user_1",
      senderName: "Bob",
      mentions: ["Alice"],
      chatType: "group",
      ttlMs: 60_000,
      topic: null,
    });
    upsertOutboundMessageContext({
      storePath,
      accountId: "main",
      conversationId: "cid_group_1",
      createdAt: 2000,
      messageType: "outbound",
      text: "今晚 8 点发版",
      senderId: "bot",
      senderName: "OpenClaw",
      chatType: "group",
      ttlMs: 60_000,
      topic: null,
      delivery: { messageId: "out_1", kind: "session" },
    });

    const mentionSlices = queryConversationHistory({
      storePath,
      accountId: "main",
      mentionNames: ["alice"],
    });
    expect(mentionSlices).toHaveLength(1);
    expect(mentionSlices[0]?.recentEntries).toHaveLength(1);
    expect(mentionSlices[0]?.recentEntries[0]?.senderId).toBe("user_1");

    const senderSlices = queryConversationHistory({
      storePath,
      accountId: "main",
      senderIds: ["bot"],
    });
    expect(senderSlices).toHaveLength(1);
    expect(senderSlices[0]?.recentEntries[0]?.senderId).toBe("bot");
  });

  it("includes conversations discovered from message-context persistence even without target directory entries", () => {
    upsertInboundMessageContext({
      storePath,
      accountId: "main",
      conversationId: "cid_group_from_context",
      msgId: "m_ctx_1",
      createdAt: 1000,
      messageType: "text",
      text: "只写入 message context",
      senderId: "user_ctx",
      senderName: "Alice",
      chatType: "group",
      ttlMs: 60_000,
      topic: null,
    });

    const slices = queryConversationHistory({
      storePath,
      accountId: "main",
      chatType: "group",
    });

    expect(slices.some((slice) => slice.conversation.conversationId === "cid_group_from_context")).toBe(true);
  });
});
